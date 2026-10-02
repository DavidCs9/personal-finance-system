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
const { listCategories, putCategoryCatalog, ensureDefaultCatalog, setEventCategory, upsertMerchantRule } =
  await import('../src/categories/service.js');
const { previewAgentCategoryEdit, previewBulkEdit, applyBulkEdit, undoBulkEdit, applyAgentCategoryEdits } =
  await import('../src/events/bulk-edits.js');
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
  const pool = { query: async (s: string, v?: unknown[]) => sql.query<Record<string, unknown>>(s, v),
    transaction: <T>(callback: (c: SqlClient) => Promise<T>) => sql.transaction(c => callback(c as unknown as SqlClient)) };
  store = new OlbiaSqlStore(pool, process.env.METADATA_TABLE_NAME!);
}, 30_000);
afterAll(async () => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.projection_state,olbia.movements,olbia.movement_revisions,olbia.bulk_edit_operations,olbia.command_receipts,olbia.merchant_category_rules');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('DELETE FROM olbia.spend_categories');
  for (const c of DEFAULT_SPEND_CATEGORIES) await sql.query('INSERT INTO olbia.spend_categories VALUES ($1,$2,$3)', [c.id, c.name, c.sortOrder]);
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true');
  vi.spyOn(readers, 'readerPool').mockImplementation(() => currentStoreTransaction() ?? sql);
  vi.spyOn(database as any, 'send').mockImplementation(command => store.send(command));
  await store.send(new PutCommand({ TableName: process.env.METADATA_TABLE_NAME!, Item: {
    PK: 'EVENT#event-1', SK: 'EVENT', entityType: 'observed_purchase', payload: { id: 'event-1', institution: 'santander_mx',
      eventType: 'card_purchase', status: 'accepted', amount: { amountMinor: 100, currency: 'MXN' }, merchantRaw: 'Shop',
      categoryId: 'otros', occurredAt: '2026-10-01T12:00:00Z', receivedAt: '2026-10-01T12:00:00Z' },
  } }));
});

describe('native SQL category catalog and membership', () => {
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
});
