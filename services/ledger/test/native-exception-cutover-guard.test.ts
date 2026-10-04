import { PGlite } from '@electric-sql/pglite';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient } from '../src/dsql/projection.js';
import type { SourceItem } from '../src/dsql/model.js';

let sql: PGlite, store: OlbiaSqlStore;
const at = '2026-10-02T12:00:00Z';
const source={bucket:'evidence',key:'original.eml',sha256:'a'.repeat(64),contentType:'message/rfc822'};
const records: SourceItem[] = [
  { PK:'EXCEPTION#exception', SK:'EXCEPTION', entityType:'ingestion_exception', GSI1PK:'EXCEPTIONS', GSI1SK:at,
    payload:{id:'exception',receivedAt:at,reason:'parser_failed',details:'Preserved original',source} },
  { PK:'EXCEPTION_DEDUPE#claim', SK:'CLAIM', entityType:'ingestion_exception_claim', sourceDedupeKey:'original-source',extractorVersion:'original-version',createdAt:at },
  { PK:'RETRY#exception', SK:'DISPATCH#request', entityType:'ingestion_retry',status:'pending',createdAt:at,job:{source,receivedAt:at,retryExceptionId:'exception'} },
];
const tables = ['projection_state','ingestion_exceptions','exception_claims','ingestion_retries','push_subscriptions','command_receipts'];
const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table =>
  [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1`)).rows])));
const key = (item: SourceItem) => ({ TableName: 'metadata', Key: { PK: item.PK, SK: item.SK } });
const put = (Item: SourceItem) => new PutCommand({ TableName: 'metadata', Item });
const unrelated:SourceItem={PK:'USER#owner',SK:'PUSH#unrelated',entityType:'push_subscription',subscriptionId:'unrelated',owner:'owner',
  endpoint:'https://push.example.test/other',keys:{p256dh:'key',auth:'auth'},contentMode:'private',active:false,createdAt:at,updatedAt:at};

beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  store = new OlbiaSqlStore({ query: (s, v) => sql.query(s, v), transaction: fn => sql.transaction(c => fn(c as unknown as SqlClient)) }, 'metadata');
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${tables.map(table => `olbia.${table}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

describe('exception workflow cutover prerequisite', () => {
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
  it('freezes exception/claim/retry mutations while retaining exact recovery records', async () => {
    for (const item of records) await store.send(put(item));
    const before = await snapshot(); await sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');
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
  it('rolls back unrelated writes, receipts and the barrier when any late exception fails in a shared transaction', async () => {
    for (const item of records) await store.send(put(item));
    const before = await snapshot(); await sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');
    const generation = (await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    for (const item of records) {
      await expect(store.send(new TransactWriteCommand({ ClientRequestToken: 'late-exception', TransactItems: [
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
