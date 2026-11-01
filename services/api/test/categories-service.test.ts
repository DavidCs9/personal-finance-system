import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { nativeFixture } from './fixtures/native-ledger.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let service: typeof import('../src/categories/service.js');
let bulk: typeof import('../src/events/bulk-edits.js');
let readers: typeof import('../src/events/sql-reads.js');
beforeAll(async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true'); vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  service = await import('../src/categories/service.js'); bulk = await import('../src/events/bulk-edits.js'); readers = await import('../src/events/sql-reads.js');
}, 30_000);
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await fixture.reset(); await fixture.sql.query('DELETE FROM olbia.spend_categories');
  for (const c of DEFAULT_SPEND_CATEGORIES) await fixture.sql.query('INSERT INTO olbia.spend_categories VALUES ($1,$2,$3)', [c.id,c.name,c.sortOrder]);
});

describe('native category catalog, assignments and merchant rules', () => {
  it('edits the native ledger after cutover without changing frozen compatibility records', async () => {
    const id = await fixture.create({ categoryId: 'otros' });
    await fixture.sql.query(`INSERT INTO olbia.projection_state (source_pk,source_sk,generation,deleted,transformer_version,reconciled_at,source_item)
      VALUES ($1,'EVENT',1,false,4,CURRENT_TIMESTAMP,$2)`, [`EVENT#${id}`, JSON.stringify({ id, retained: true })]);
    const frozen = (await fixture.sql.query('SELECT * FROM olbia.projection_state')).rows;
    await service.setEventCategory(id, 'owner', 'shopping', { updateRule: true });
    expect((await fixture.sql.query<{ category_id: string }>('SELECT category_id FROM olbia.ledger_movements')).rows).toEqual([{ category_id: 'shopping' }]);
    expect((await fixture.sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual(frozen);
    expect((await fixture.sql.query('SELECT * FROM olbia.ledger_revisions')).rows).toHaveLength(1);
    expect(await service.listMerchantRules()).toHaveLength(1);
  });
  it('uses the SQL catalog without document commands, runtime defaults or fallback on read failure', async () => {
    await service.putCategoryCatalog([{ id: 'restaurantes', name: 'Comida', sortOrder: 1 }, { id: 'personal', name: 'Personal', sortOrder: 2 }]);
    expect(await service.listCategories()).toContainEqual(expect.objectContaining({ id: 'restaurantes', name: 'Comida', sortOrder: 1 }));
    await fixture.sql.query("DELETE FROM olbia.spend_categories WHERE id='deportes'");
    expect((await service.ensureDefaultCatalog()).some(c => c.id === 'deportes')).toBe(false);
    const failure = vi.spyOn(readers, 'readerPool').mockImplementation(() => { throw new Error('SQL unavailable'); });
    try { await expect(service.listCategories()).rejects.toThrow('SQL unavailable'); } finally { failure.mockRestore(); }
    expect((await fixture.sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual([]);
  });
  it('rejects invalid catalog batches, unknown assignment/rule/preview targets and direct FK violations', async () => {
    const id = await fixture.create({ categoryId: 'otros' }); const before = await fixture.snapshot();
    await expect(service.putCategoryCatalog([{ id: 'otros', name: 'Changed', sortOrder: 1 }, { id: 'bad', name: '', sortOrder: 2 }])).rejects.toThrow();
    await expect(service.putCategoryCatalog([null] as never)).rejects.toThrow('Cada categoría');
    await expect(service.putCategoryCatalog([{ id: 'otros', name: 'One', sortOrder: 1 }, { id: 'otros', name: 'Two', sortOrder: 2 }])).rejects.toThrow('IDs únicos');
    await expect(service.setEventCategory(id, 'owner', 'inventada')).rejects.toThrow('no existe');
    await expect(service.upsertMerchantRule({ merchantRaw: 'Shop', categoryId: 'inventada', source: 'human' })).rejects.toThrow('no existe');
    await expect(bulk.previewAgentCategoryEdit('owner', { categoryId: 'inventada', eventIds: [id], onlyUncategorized: false })).rejects.toThrow('no existe');
    await expect(fixture.sql.query("UPDATE olbia.ledger_movements SET category_id='inventada'")).rejects.toThrow();
    await expect(fixture.sql.query("DELETE FROM olbia.spend_categories WHERE id='otros'")).rejects.toThrow();
    expect(await fixture.snapshot()).toEqual(before);
  });
  it('accepts custom IDs and null while preserving every revision', async () => {
    const id = await fixture.create(); await service.putCategoryCatalog([{ id: 'personal', name: 'Personal', sortOrder: 1 }]);
    await service.setEventCategory(id, 'owner', 'personal'); await service.setEventCategory(id, 'owner', null);
    expect((await fixture.sql.query<{ category_id: string }>('SELECT category_id FROM olbia.ledger_movements')).rows).toEqual([{ category_id: null }]);
    expect((await fixture.sql.query('SELECT changes FROM olbia.ledger_revisions')).rows).toHaveLength(2);
  });
  it('validates standalone mutation targets with the application identity instead of opening a reader identity', async () => {
    const { requireCatalogCategories } = await import('../src/categories/catalog.js');
    const failure = vi.spyOn(readers, 'readerPool').mockImplementation(() => { throw new Error('Reader role not granted'); });
    try {
      await requireCatalogCategories(['otros']); await requireCatalogCategories([null]);
      await expect(requireCatalogCategories(['inventada'])).rejects.toThrow('no existe');
      expect(failure).not.toHaveBeenCalled();
    } finally { failure.mockRestore(); }
  });
  it('keeps normalized merchant identity stable and rolls back category/history if the accompanying rule fails', async () => {
    const first = await service.upsertMerchantRule({ merchantRaw: 'Á Shared Shop', categoryId: 'shopping', pattern: 'Shóp', source: 'human' });
    const second = await service.upsertMerchantRule({ merchantRaw: 'A Shared Shop', categoryId: '', source: 'agent_confirmed' });
    expect(second.id).toBe(first.id); expect(second).toMatchObject({ merchantKey: 'a shared shop', categoryId: '', pattern: undefined });
    const id = await fixture.create({ categoryId: 'otros' }); const before = await fixture.snapshot();
    await expect(service.setEventCategory(id, 'owner', 'shopping', { updateRule: true, source: 'invalid' as never })).rejects.toThrow('Origen');
    expect(await fixture.snapshot()).toEqual(before);
  });
});

// The control plane manages category identities; it never rewrites movement evidence.
describe('assistant category catalog control plane', () => {
  const operation = async (args: Record<string, unknown>) => {
    const { manageAgentCategory, listAgentCategories } = await import('../src/categories/control-plane.js');
    const discovered = await listAgentCategories();
    const { runTagMutationTool } = await import('../src/agent/tag-mutation-tools.js');
    return runTagMutationTool('owner', 'manage_category', { operationId: discovered.operationId, ...args }) as ReturnType<typeof manageAgentCategory>;
  };
  it('creates and renames custom categories with durable retry receipts and stale-version rejection', async () => {
    const { manageAgentCategory, listAgentCategories } = await import('../src/categories/control-plane.js');
    const { operationId } = await listAgentCategories();
    const args = { operationId, action: 'create', categoryId: 'mascotas', name: 'Mascotas', sortOrder: 130 };
    const created = await manageAgentCategory('owner', args);
    expect(created.category).toMatchObject({ id: 'mascotas', name: 'Mascotas', revision: 1, archived: false });
    expect(await manageAgentCategory('owner', args)).toEqual(created);
    await expect(manageAgentCategory('owner', { ...args, name: 'Otro nombre' })).rejects.toThrow('otra solicitud');
    await expect(manageAgentCategory('intruder', args)).rejects.toThrow('otra solicitud');
    const id = await fixture.create({ categoryId: 'mascotas' });
    const before = await fixture.snapshot();
    const updated = await operation({ action: 'update', categoryId: 'mascotas', name: 'Veterinario y mascotas', expectedRevision: 1 });
    expect(updated.category).toMatchObject({ revision: 2, name: 'Veterinario y mascotas' });
    expect(await fixture.snapshot()).toEqual(before);
    expect((await fixture.sql.query<{ category_id: string }>('SELECT category_id FROM olbia.ledger_movements WHERE id=$1', [id])).rows[0]?.category_id).toBe('mascotas');
    await expect(operation({ action: 'archive', categoryId: 'mascotas', expectedRevision: 1 })).rejects.toThrow('cambió');
    expect((await fixture.sql.query('SELECT * FROM olbia.category_catalog_changes')).rows).toHaveLength(2);
    // Replaying an old successful request returns its original receipt, without reverting the rename.
    expect(await manageAgentCategory('owner', args)).toEqual(created);
    expect((await service.listCategories()).find(c => c.id === 'mascotas')?.name).toBe('Veterinario y mascotas');
  });
  it('archives without losing assignments/rules or changing totals; rejects pending/new writes and supports restore/undo', async () => {
    const id = await fixture.create({ categoryId: 'otros' });
    const fresh = await fixture.create();
    await service.upsertMerchantRule({ merchantRaw: 'Archive shop', categoryId: 'otros', source: 'human' });
    const pending = await bulk.previewAgentCategoryEdit('owner', { categoryId: 'otros', eventIds: [fresh], onlyUncategorized: false });
    const toShopping = await bulk.previewAgentCategoryEdit('owner', { categoryId: 'shopping', eventIds: [id], onlyUncategorized: false });
    await bulk.applyAgentCategoryEdit('owner', toShopping.operationId);
    const before = await fixture.snapshot();
    await operation({ action: 'archive', categoryId: 'otros', expectedRevision: 0 });
    expect(await fixture.snapshot()).toEqual(before);
    expect((await service.listCategories()).find(c => c.id === 'otros')).toMatchObject({ name: 'Otros', archived: true });
    expect(await service.resolveCategoryForMerchant('Archive shop')).toBeUndefined();
    await expect(service.setEventCategory(fresh, 'owner', 'otros')).rejects.toThrow('archivada');
    await expect(service.upsertMerchantRule({ merchantRaw: 'New shop', categoryId: 'otros', source: 'human' })).rejects.toThrow('archivada');
    await expect(bulk.applyAgentCategoryEdit('owner', pending.operationId)).rejects.toThrow('archivada');
    await bulk.undoAgentCategoryEdit('owner', toShopping.operationId);
    expect((await fixture.sql.query<{ category_id: string }>('SELECT category_id FROM olbia.ledger_movements WHERE id=$1', [id])).rows[0]?.category_id).toBe('otros');
    await operation({ action: 'restore', categoryId: 'otros', expectedRevision: 1 });
    expect(await service.resolveCategoryForMerchant('Archive shop')).toBe('otros');
    await service.setEventCategory(fresh, 'owner', 'otros');
    expect(await service.listMerchantRules()).toHaveLength(1);
  });
  it('rejects invalid/duplicate catalog requests and rolls back both category and audit writes on failure', async () => {
    for (const args of [
      { action: 'create', categoryId: 'Bad ID', name: 'Invalid' },
      { action: 'create', categoryId: 'personal', name: '' },
      { action: 'create', categoryId: 'personal', name: '  Súpermercado ' },
      { action: 'create', categoryId: 'otros', name: 'Duplicado' },
      { action: 'update', categoryId: 'otros', name: 'New' },
      { action: 'update', categoryId: 'otros', name: 'New', expectedRevision: 9 },
      { action: 'archive', categoryId: 'otros', name: 'Hidden rename', expectedRevision: 0 },
      { action: 'restore', categoryId: 'missing', expectedRevision: 0 },
    ]) await expect(operation(args)).rejects.toThrow();
    expect((await fixture.sql.query('SELECT * FROM olbia.category_catalog_changes')).rows).toEqual([]);
    // Inject a real SQL failure after category and lifecycle writes inside the transaction.
    await fixture.sql.exec(`ALTER TABLE olbia.category_catalog_changes ADD CONSTRAINT test_failure CHECK (action <> 'create')`);
    await expect(operation({ action: 'create', categoryId: 'personal', name: 'Personal' })).rejects.toThrow();
    expect((await service.listCategories()).some(c => c.id === 'personal')).toBe(false);
    expect((await fixture.sql.query('SELECT * FROM olbia.category_lifecycle')).rows).toEqual([]);
    await fixture.sql.exec('ALTER TABLE olbia.category_catalog_changes DROP CONSTRAINT test_failure');
  });
  it('tracks legacy catalog edits in the same version history so stale assistant writes cannot overwrite them', async () => {
    await service.putCategoryCatalog([{ id: 'otros', name: 'Personal', sortOrder: 1 }]);
    await expect(operation({ action: 'archive', categoryId: 'otros', expectedRevision: 0 })).rejects.toThrow('cambió');
    await operation({ action: 'archive', categoryId: 'otros', expectedRevision: 1 });
    await service.putCategoryCatalog([{ id: 'otros', name: 'Personales', sortOrder: 2, archived: false }]);
    expect((await service.listCategories()).find(c => c.id === 'otros')).toMatchObject({ archived: true, revision: 3 });
    expect((await fixture.sql.query('SELECT action FROM olbia.category_catalog_changes ORDER BY revision')).rows)
      .toEqual([{ action: 'update' }, { action: 'archive' }, { action: 'update' }]);
  });
});
