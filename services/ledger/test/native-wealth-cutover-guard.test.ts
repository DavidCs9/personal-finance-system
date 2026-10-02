import { PGlite } from '@electric-sql/pglite';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/store.js';
import type { SqlClient } from '../src/dsql/projection.js';
import type { SourceItem } from '../src/dsql/model.js';

let sql: PGlite, store: OlbiaSqlStore;
const at = '2026-10-02T12:00:00Z';
const asset: SourceItem = { PK: 'USER#owner', SK: 'WEALTH_SNAP#bitso#2026-10-02', owner: 'owner',
  accountId: 'bitso', day: '2026-10-02', capturedAt: at, source: 'api', currency: 'MXN', totalMxnMinor: 100,
  holdings: [{ id: 'btc', name: 'Bitcoin', symbol: 'BTC', quantity: 0.0001, currency: 'BTC', valueNativeMinor: 1, valueMxnMinor: 100 }] };
const liability: SourceItem = { PK: asset.PK, SK: 'LIAB_SNAP#amex#2026-10-02', owner: 'owner',
  cardId: 'amex', day: '2026-10-02', capturedAt: at, source: 'manual', currency: 'MXN', totalMxnMinor: 0 };
const records = [asset, { ...asset, SK: `WEALTH_VER#bitso#2026-10-02#${at}`, versionId: 'asset-version', supersededAt: at },
  liability, { ...liability, SK: `LIAB_VER#amex#2026-10-02#${at}`, versionId: 'liability-version', supersededAt: at }];
const tables = ['projection_state', 'wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions', 'exception_claims', 'command_receipts'];
const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table =>
  [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2,3`)).rows])));
const key = (item: SourceItem) => ({ TableName: 'metadata', Key: { PK: item.PK, SK: item.SK } });
const put = (Item: SourceItem) => new PutCommand({ TableName: 'metadata', Item });
const unrelated: SourceItem = { PK: 'EXCEPTION_DEDUPE#other', SK: 'CLAIM', entityType: 'ingestion_exception_claim', createdAt: at };

beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  store = new OlbiaSqlStore({ query: (s, v) => sql.query(s, v), transaction: fn => sql.transaction(c => fn(c as unknown as SqlClient)) }, 'metadata');
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${tables.map(table => `olbia.${table}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=15');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

describe('wealth capture cutover prerequisite', () => {
  it('preserves every family and ordinary mutations before native activation', async () => {
    for (const item of records) {
      await store.send(put(item));
      await store.send(new UpdateCommand({ ...key(item), UpdateExpression: 'SET #extra=:value',
        ExpressionAttributeNames: { '#extra': 'extra' }, ExpressionAttributeValues: { ':value': 'before-copy' } }));
      expect((await store.send(new GetCommand(key(item)))).Item).toEqual({ ...item, extra: 'before-copy' });
      await store.send(new DeleteCommand(key(item)));
      expect((await store.send(new GetCommand(key(item)))).Item).toBeUndefined();
    }
  });
  it('freezes all four snapshot/version families without changing retained balances, positions or paid zero', async () => {
    for (const item of records) await store.send(put(item));
    const before = await snapshot(); await sql.query('INSERT INTO olbia.schema_migrations VALUES (15,CURRENT_TIMESTAMP)');
    for (const item of records) {
      for (const command of [put(item), new DeleteCommand(key(item)), new UpdateCommand({ ...key(item),
        UpdateExpression: 'SET #extra=:value', ExpressionAttributeNames: { '#extra': 'extra' }, ExpressionAttributeValues: { ':value': 'late' } })])
        await expect(store.send(command)).rejects.toMatchObject({ name: 'MigrationPausedException' });
      expect((await store.send(new GetCommand(key(item)))).Item).toEqual(item);
    }
    expect(await snapshot()).toEqual(before);
    await store.send(put(unrelated));
    expect((await store.send(new GetCommand(key(unrelated)))).Item).toEqual(unrelated);
  });
  it('rolls back unrelated writes, receipts and the barrier when any late capture fails in a shared transaction', async () => {
    for (const item of records) await store.send(put(item));
    const before = await snapshot(); await sql.query('INSERT INTO olbia.schema_migrations VALUES (15,CURRENT_TIMESTAMP)');
    const generation = (await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    for (const item of records) {
      await expect(store.send(new TransactWriteCommand({ ClientRequestToken: 'late-wealth', TransactItems: [
        { Put: { TableName: 'metadata', Item: unrelated } }, { Delete: { ...key(item) } },
      ] }))).rejects.toMatchObject({ name: 'MigrationPausedException' });
      await expect(store.transaction(async () => {
        await store.send(new TransactWriteCommand({ ClientRequestToken: 'earlier-operation', TransactItems: [
          { Put: { TableName: 'metadata', Item: unrelated } },
        ] }));
        await store.send(new DeleteCommand(key(item)));
      })).rejects.toMatchObject({ name: 'MigrationPausedException' });
    }
    expect(await snapshot()).toEqual(before);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(generation);
  });
});
