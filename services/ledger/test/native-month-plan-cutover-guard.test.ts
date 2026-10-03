import { PGlite } from '@electric-sql/pglite';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite, store: OlbiaSqlStore;
const plan = { PK: 'USER#owner', SK: 'MONTH#2026-09', owner: 'owner', month: '2026-09',
  payload: { incomeMinor: 123456, currency: 'MXN', updatedAt: '2026-09-01T12:00:00.123Z',
    upcomingPayments: [{ id: 'rent', name: 'Renta', amountMinor: 10000, dueDay: 31 }] } };
const input = { TableName: 'metadata', Key: { PK: plan.PK, SK: plan.SK } };
const markNative = () => sql.query('INSERT INTO olbia.schema_migrations VALUES (11,CURRENT_TIMESTAMP)');
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  store = new OlbiaSqlStore({ query: (s, v) => sql.query<Record<string, unknown>>(s, v),
    transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) }, 'metadata');
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.projection_state,olbia.monthly_plans,olbia.movements,olbia.command_receipts');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=11');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await store.send(new PutCommand({ TableName: 'metadata', Item: plan }));
});
describe('month-plan cutover guard', () => {
  it('allows normal pre-marker edits and preserves an explicit empty month parent', async () => {
    await store.send(new UpdateCommand({ ...input, UpdateExpression: 'SET #payload.#payments=:empty',
      ExpressionAttributeNames: { '#payload': 'payload', '#payments': 'upcomingPayments' }, ExpressionAttributeValues: { ':empty': [] } }));
    expect((await store.send(new GetCommand(input))).Item).toEqual({ ...plan, payload: { ...plan.payload, upcomingPayments: [] } });
    expect((await sql.query("SELECT payload FROM olbia.monthly_plans WHERE month='2026-09'")).rows).toEqual([{ payload: { ...plan.payload, upcomingPayments: [] } }]);
  });
  it('blocks every legacy mutation after native copy without changing the frozen plan or checkpoint', async () => {
    const before = (await sql.query('SELECT * FROM olbia.projection_state')).rows;
    await markNative();
    for (const command of [new PutCommand({ TableName: 'metadata', Item: plan }),
      new UpdateCommand({ ...input, UpdateExpression: 'SET #payload.#payments=:empty',
        ExpressionAttributeNames: { '#payload': 'payload', '#payments': 'upcomingPayments' }, ExpressionAttributeValues: { ':empty': [] } }),
      new DeleteCommand(input)]) await expect(store.send(command)).rejects.toMatchObject({ name: 'MigrationPausedException' });
    expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual(before);
    expect((await store.send(new GetCommand(input))).Item).toEqual(plan);
  });
  it('rolls back prior movement changes and receipts if a mixed transaction reaches a blocked plan write', async () => {
    const movement = { PK: 'EVENT#event-1', SK: 'EVENT', payload: { id: 'event-1', institution: 'santander_mx', eventType: 'card_purchase',
      status: 'accepted', merchantRaw: 'Shop', receivedAt: '2026-09-01T12:00:00Z', amount: { amountMinor: 100, currency: 'MXN' } } };
    await store.send(new PutCommand({ TableName: 'metadata', Item: movement })); await markNative();
    await expect(store.send(new TransactWriteCommand({ ClientRequestToken: 'month-migration-guard', TransactItems: [
      { Put: { TableName: 'metadata', Item: { ...movement, payload: { ...movement.payload, status: 'rejected' } } } },
      { Delete: input },
    ] }))).rejects.toMatchObject({ name: 'MigrationPausedException' });
    expect((await store.send(new GetCommand({ TableName: 'metadata', Key: { PK: movement.PK, SK: movement.SK } }))).Item).toEqual(movement);
    expect((await sql.query('SELECT * FROM olbia.command_receipts')).rows).toHaveLength(0);
  });
  it('preserves the prior plan and absence of its marker when a shared cutover transaction aborts', async () => {
    await expect(store.transaction(async client => {
      await store.send(new DeleteCommand(input));
      await client.query('INSERT INTO olbia.schema_migrations VALUES (11,CURRENT_TIMESTAMP)');
      throw new Error('Migration interrupted');
    })).rejects.toThrow('Migration interrupted');
    expect((await store.send(new GetCommand(input))).Item).toEqual(plan);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=11')).rows).toHaveLength(0);
  });
});
