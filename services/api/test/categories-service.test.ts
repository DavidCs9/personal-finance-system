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
    expect((await fixture.sql.query('SELECT category_id FROM olbia.ledger_movements')).rows).toEqual([{ category_id: 'shopping' }]);
    expect((await fixture.sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual(frozen);
    expect((await fixture.sql.query('SELECT * FROM olbia.ledger_revisions')).rows).toHaveLength(1);
    expect(await service.listMerchantRules()).toHaveLength(1);
  });
  it('uses the SQL catalog without document commands, runtime defaults or fallback on read failure', async () => {
    await service.putCategoryCatalog([{ id: 'restaurantes', name: 'Comida', sortOrder: 1 }, { id: 'personal', name: 'Personal', sortOrder: 2 }]);
    expect(await service.listCategories()).toContainEqual({ id: 'restaurantes', name: 'Comida', sortOrder: 1 });
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
    expect((await fixture.sql.query('SELECT category_id FROM olbia.ledger_movements')).rows).toEqual([{ category_id: null }]);
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
