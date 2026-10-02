import { PGlite } from '@electric-sql/pglite';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/store.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite, store: OlbiaSqlStore;
const card = { PK: 'USER#owner', SK: 'CARD#amex', owner: 'owner', createdAt: '2026-09-01T12:00:00.123Z',
  updatedAt: '2026-09-01T12:00:00.123Z', payload: { id: 'amex', name: 'Amex', cutOffDay: 10, paymentDueDay: 28 } };
const input = { TableName: 'metadata', Key: { PK: card.PK, SK: card.SK } };
const markNative = () => sql.query('INSERT INTO olbia.schema_migrations VALUES (9,CURRENT_TIMESTAMP)');
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  store = new OlbiaSqlStore({ query: (s, v) => sql.query<Record<string, unknown>>(s, v),
    transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) }, 'metadata');
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.projection_state,olbia.cards,olbia.movements,olbia.command_receipts');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=9');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await store.send(new PutCommand({ TableName: 'metadata', Item: card }));
});
describe('card profile cutover guard', () => {
  it('preserves normal legacy editing and deletion before the native marker exists', async () => {
    await store.send(new UpdateCommand({ ...input, UpdateExpression: 'SET #payload.#name = :name',
      ExpressionAttributeNames: { '#payload': 'payload', '#name': 'name' }, ExpressionAttributeValues: { ':name': 'Updated' } }));
    expect((await store.send(new GetCommand(input))).Item.payload.name).toBe('Updated');
    await store.send(new DeleteCommand(input));
    expect((await store.send(new GetCommand(input))).Item).toBeUndefined();
  });
  it('blocks put/update/delete after native copy while retaining readable frozen evidence', async () => {
    const before = (await sql.query('SELECT * FROM olbia.projection_state')).rows;
    await markNative();
    for (const command of [new PutCommand({ TableName: 'metadata', Item: card }),
      new UpdateCommand({ ...input, UpdateExpression: 'SET #owner=:owner', ExpressionAttributeNames: { '#owner': 'owner' }, ExpressionAttributeValues: { ':owner': 'owner' } }),
      new DeleteCommand(input)]) {
      await expect(store.send(command)).rejects.toMatchObject({ name: 'MigrationPausedException' });
    }
    expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual(before);
    expect((await store.send(new GetCommand(input))).Item).toEqual(card);
  });
  it('rolls back a mixed transaction instead of leaving financial rows changed before a blocked card action', async () => {
    const movement = { PK: 'EVENT#event-1', SK: 'EVENT', payload: { id: 'event-1', institution: 'santander_mx', eventType: 'card_purchase',
      status: 'accepted', merchantRaw: 'Shop', receivedAt: '2026-09-01T12:00:00Z', amount: { amountMinor: 100, currency: 'MXN' } } };
    await store.send(new PutCommand({ TableName: 'metadata', Item: movement }));
    await markNative();
    await expect(store.send(new TransactWriteCommand({ ClientRequestToken: 'card-migration-guard', TransactItems: [
      { Put: { TableName: 'metadata', Item: { ...movement, payload: { ...movement.payload, status: 'rejected' } } } },
      { Delete: input },
    ] }))).rejects.toMatchObject({ name: 'MigrationPausedException' });
    expect((await store.send(new GetCommand({ TableName: 'metadata', Key: { PK: movement.PK, SK: movement.SK } }))).Item).toEqual(movement);
    expect((await sql.query('SELECT * FROM olbia.command_receipts')).rows).toHaveLength(0);
  });
  it('keeps the migration marker and prior profile state absent/unchanged when the shared transaction aborts', async () => {
    await expect(store.transaction(async client => {
      await store.send(new DeleteCommand(input));
      await client.query('INSERT INTO olbia.schema_migrations VALUES (9,CURRENT_TIMESTAMP)');
      throw new Error('Migration interrupted');
    })).rejects.toThrow('Migration interrupted');
    expect((await store.send(new GetCommand(input))).Item).toEqual(card);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=9')).rows).toHaveLength(0);
  });
});
