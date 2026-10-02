import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { OlbiaSqlStore, withStoreClient, currentStoreTransaction } from '../../ledger/src/dsql/store.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';
const { database } = await import('../src/http/clients.js');
const readers = await import('../src/events/sql-reads.js');
const storeClients = await import('@finance/ledger/dsql-store');
const { listCategories, listMerchantRules, putCategoryCatalog, ensureDefaultCatalog, setEventCategory, upsertMerchantRule } =
  await import('../src/categories/service.js');
const { previewAgentCategoryEdit, previewBulkEdit, applyBulkEdit, undoBulkEdit, applyAgentCategoryEdits } =
  await import('../src/events/bulk-edits.js');
const { patchEvent } = await import('../src/events/mutations.js');
let sql: PGlite, store: OlbiaSqlStore;
const run = <T>(callback: () => Promise<T>) => sql.transaction(client => withStoreClient(client as unknown as SqlClient, callback));
const snapshot = (nextCategoryId: string | null, previousCategoryId: string | null = 'otros') => ({
  id: 'event-1', merchantRaw: 'Shop', status: 'accepted', amountMinor: 100, occurredAt: '2026-10-01T12:00:00Z',
  previousTags: [], nextTags: [], previousCategoryId, nextCategoryId,
});
const seedOperation = async (id: string, next: string | null, previous = 'otros', status = 'pending') => {
  const operation = { operationId: id, owner: 'owner', status, createdAt: '2026-10-01T12:00:00Z',
    expiresAt: 9_999_999_999, selection: { statuses: ['accepted'], fromDay: '2026-10-01', toDay: '2026-10-01' },
    change: { categoryId: next }, events: [snapshot(next, previous)], amountMinor: 100 };
  await sql.query(`INSERT INTO olbia.projection_state (source_pk,source_sk,generation,deleted,transformer_version,reconciled_at,source_item)
    VALUES ('BULK_EDIT#owner',$1,1,false,4,CURRENT_TIMESTAMP,$2)`, [`OP#${id}`, JSON.stringify({ PK: 'BULK_EDIT#owner', SK: `OP#${id}`, entityType: 'bulk_edit_operation', payload: operation })]);
};
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await sql.query('ALTER TABLE olbia.movements ADD CONSTRAINT movements_category_fk FOREIGN KEY (category_id) REFERENCES olbia.spend_categories(id)');
  const pool = { query: async (s: string, v?: unknown[]) => sql.query<Record<string, unknown>>(s, v),
    transaction: <T>(callback: (c: SqlClient) => Promise<T>) => sql.transaction(c => callback(c as unknown as SqlClient)) };
  store = new OlbiaSqlStore(pool, process.env.METADATA_TABLE_NAME!);
}, 30_000);
afterAll(async () => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.projection_state,olbia.movements,olbia.merchant_rules,olbia.movement_revisions,olbia.bulk_edit_operations,olbia.command_receipts,olbia.merchant_category_rules');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=14');
  await sql.query('DELETE FROM olbia.spend_categories');
  for (const c of DEFAULT_SPEND_CATEGORIES) await sql.query('INSERT INTO olbia.spend_categories VALUES ($1,$2,$3)', [c.id, c.name, c.sortOrder]);
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true');
  vi.spyOn(readers, 'readerPool').mockImplementation(() => currentStoreTransaction() ?? sql);
  vi.spyOn(storeClients, 'applicationStoreClient').mockImplementation(() => currentStoreTransaction() ?? sql);
  vi.spyOn(database as any, 'send').mockImplementation(command => store.send(command));
  await store.send(new PutCommand({ TableName: process.env.METADATA_TABLE_NAME!, Item: {
    PK: 'EVENT#event-1', SK: 'EVENT', entityType: 'observed_purchase', payload: { id: 'event-1', institution: 'santander_mx',
      eventType: 'card_purchase', status: 'accepted', amount: { amountMinor: 100, currency: 'MXN' }, merchantRaw: 'Shop',
      categoryId: 'otros', occurredAt: '2026-10-01T12:00:00Z', receivedAt: '2026-10-01T12:00:00Z' },
  } }));
});

describe('native SQL category catalog and membership', () => {
  it('blocks actual single edits and bulk apply after ledger cutover without audit/rule/operation changes', async () => {
    await seedOperation('ledger-cutover','shopping');
    const tables=['projection_state','movements','movement_revisions','bulk_edit_operations','merchant_rules','command_receipts'];
    const before=await Promise.all(tables.map(async table=>(await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2`)).rows));
    await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
    await expect(run(()=>setEventCategory('event-1','owner','shopping',{updateRule:true})))
      .rejects.toMatchObject({name:'MigrationPausedException'});
    for(const body of [{action:'set_tags',tags:['retained']},{action:'set_personal_amount',personalAmountMinor:0},
      {action:'set_msi',months:3},{action:'reject'},{action:'verify'}])
      await expect(run(()=>patchEvent('event-1','owner',JSON.stringify(body))))
        .rejects.toMatchObject({name:'MigrationPausedException'});
    await expect(applyBulkEdit('owner','ledger-cutover','owner')).rejects.toMatchObject({name:'MigrationPausedException'});
    expect(await Promise.all(tables.map(async table=>(await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2`)).rows)))
      .toEqual(before);
  });
  it('reads and updates the catalog without document commands or runtime default overlays', async () => {
    vi.mocked(database.send).mockClear();
    await run(() => putCategoryCatalog([{ id: 'restaurantes', name: 'Comida', sortOrder: 1 }, { id: 'personal', name: 'Personal', sortOrder: 2 }]));
    expect(await listCategories()).toContainEqual({ id: 'restaurantes', name: 'Comida', sortOrder: 1 });
    expect(await listCategories()).toContainEqual({ id: 'personal', name: 'Personal', sortOrder: 2 });
    await sql.query("DELETE FROM olbia.spend_categories WHERE id='deportes'");
    expect((await ensureDefaultCatalog()).some(c => c.id === 'deportes')).toBe(false);
    expect(database.send).not.toHaveBeenCalled();
  });
  it('fails closed on SQL read failure and atomically rejects an invalid catalog batch', async () => {
    await expect(run(() => putCategoryCatalog([{ id: 'otros', name: 'Changed', sortOrder: 1 }, { id: 'bad', name: '', sortOrder: 2 }]))).rejects.toThrow();
    expect((await listCategories()).find(c => c.id === 'otros')?.name).toBe('Otros');
    await expect(run(() => putCategoryCatalog([null] as any))).rejects.toThrow('Cada categoría');
    await expect(run(() => putCategoryCatalog([{ id: 'otros', name: 'One', sortOrder: 1 }, { id: 'otros', name: 'Two', sortOrder: 2 }]))).rejects.toThrow('IDs únicos');
    vi.mocked(database.send).mockClear();
    vi.spyOn(readers, 'readerPool').mockReturnValue({ query: async () => { throw new Error('SQL unavailable'); } });
    await expect(listCategories()).rejects.toThrow('SQL unavailable');
    expect(database.send).not.toHaveBeenCalled();
  });
  it('rejects unknown single/rule/preview targets before writing any category or audit data', async () => {
    const before = (await sql.query('SELECT source_item FROM olbia.projection_state')).rows;
    await expect(run(() => setEventCategory('event-1', 'owner', 'inventada'))).rejects.toThrow('no existe');
    await expect(run(() => upsertMerchantRule({ merchantRaw: 'Shop', categoryId: 'inventada', source: 'human' }))).rejects.toThrow('no existe');
    await expect(previewAgentCategoryEdit('owner', { categoryId: 'inventada', eventIds: ['event-1'], onlyUncategorized: false })).rejects.toThrow('no existe');
    await expect(previewBulkEdit('owner', { selection: { fromDay: '2026-10-01', toDay: '2026-10-01', statuses: ['accepted'] }, change: { categoryId: 'inventada' } })).rejects.toThrow('no existe');
    expect((await sql.query('SELECT source_item FROM olbia.projection_state')).rows).toEqual(before);
    expect((await sql.query('SELECT * FROM olbia.movement_revisions')).rows).toHaveLength(0);
  });
  it('accepts custom catalog IDs and null while preserving a revision of each single change', async () => {
    await run(() => putCategoryCatalog([{ id: 'personal', name: 'Personal', sortOrder: 1 }]));
    await run(() => setEventCategory('event-1', 'owner', 'personal'));
    await run(() => setEventCategory('event-1', 'owner', null));
    expect((await sql.query('SELECT category_id FROM olbia.movements')).rows).toEqual([{ category_id: null }]);
    expect((await sql.query('SELECT payload FROM olbia.movement_revisions')).rows).toHaveLength(2);
  });
  it('revalidates stale prepared single/batch apply and undo targets without changing state', async () => {
    await seedOperation('stale', 'inventada');
    await expect(applyBulkEdit('owner', 'stale', 'owner')).rejects.toThrow('no existe');
    await expect(applyAgentCategoryEdits('owner', ['stale'])).rejects.toThrow('no existe');
    await seedOperation('undo-invalid', 'otros', 'inventada', 'applied');
    await expect(undoBulkEdit('owner', 'undo-invalid', 'owner')).rejects.toThrow('no existe');
    expect((await sql.query('SELECT category_id FROM olbia.movements')).rows).toEqual([{ category_id: 'otros' }]);
    expect((await sql.query('SELECT * FROM olbia.movement_revisions')).rows).toHaveLength(0);
  });
  it('validates standalone mutation targets with the application identity, without opening a reader identity', async () => {
    const { requireCatalogCategories } = await import('../src/categories/catalog.js');
    vi.mocked(readers.readerPool).mockImplementation(() => { throw new Error('Reader role not granted to mutation runtime'); });
    await expect(requireCatalogCategories(['otros'])).resolves.toBeUndefined();
    await expect(requireCatalogCategories(['inventada'])).rejects.toThrow('no existe');
    await requireCatalogCategories([null]);
    expect(readers.readerPool).not.toHaveBeenCalled();
  });
  it('stores normalized rules directly with stable IDs and nullable assignment, without document writes', async () => {
    vi.mocked(database.send).mockClear();
    const first = await run(() => upsertMerchantRule({ merchantRaw: 'Á Shared Shop', categoryId: 'shopping', pattern: 'Shóp', source: 'human' }));
    const second = await run(() => upsertMerchantRule({ merchantRaw: 'A Shared Shop', categoryId: '', source: 'agent_confirmed' }));
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ merchantKey: 'a shared shop', categoryId: '', pattern: undefined, source: 'agent_confirmed' });
    expect((await sql.query('SELECT category_id,pattern FROM olbia.merchant_rules')).rows).toEqual([{ category_id: null, pattern: null }]);
    expect(await listMerchantRules()).toEqual([second]);
    expect(database.send).not.toHaveBeenCalled();
    await expect(store.send(new PutCommand({ TableName: process.env.METADATA_TABLE_NAME!, Item: {
      PK: 'CATEGORY_RULES', SK: 'RULE#a shared shop', ...first,
    } }))).rejects.toMatchObject({ name: 'ValidationException' });
  });
  it('native foreign keys reject unknown direct assignments and referenced category deletion', async () => {
    await expect(sql.query("UPDATE olbia.movements SET category_id='inventada' WHERE id='event-1'")).rejects.toThrow();
    await expect(sql.query("INSERT INTO olbia.merchant_rules VALUES ('shop','id',NULL,'inventada','human',CURRENT_TIMESTAMP)")).rejects.toThrow();
    await expect(sql.query("DELETE FROM olbia.spend_categories WHERE id='otros'")).rejects.toThrow();
    expect((await sql.query('SELECT category_id FROM olbia.movements')).rows).toEqual([{ category_id: 'otros' }]);
    expect(await listMerchantRules()).toHaveLength(0);
  });
  it('rolls back category and revision when an accompanying rule update fails', async () => {
    await expect(run(() => setEventCategory('event-1', 'owner', 'shopping', { updateRule: true, source: 'invalid' as any }))).rejects.toThrow('Origen');
    expect((await sql.query('SELECT category_id FROM olbia.movements')).rows).toEqual([{ category_id: 'otros' }]);
    expect((await sql.query('SELECT * FROM olbia.movement_revisions')).rows).toHaveLength(0);
    expect(await listMerchantRules()).toHaveLength(0);
  });
});
