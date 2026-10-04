import { PGlite } from '@electric-sql/pglite';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS, migrateMonthPlans } from './helpers/migration-schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';

let sql: PGlite, pool: TransactionPool, store: OlbiaSqlStore;
const plan = (month: string, payments = [{ id: 'z',name: 'Renta',amountMinor: 10000,dueDay: 31 },
  { id: 'a',name: 'Internet',amountMinor: 20000,dueDay: 15 }]) => ({ PK: 'USER#owner',SK: `MONTH#${month}`,owner: 'owner',month,
  payload: { updatedAt: '2026-09-01T12:00:00.123Z',incomeMinor: 123456,currency: 'MXN',upcomingPayments: payments } });
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) };
  store = new OlbiaSqlStore({ ...pool,query: (s,v) => sql.query(s,v) },'metadata');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
},30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.month_plans,olbia.planned_payments,olbia.monthly_plans,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=11');
  for (const item of [plan('2026-09'),plan('2026-10',[])]) await store.send(new PutCommand({ TableName: 'metadata',Item: item }));
});
describe('native month-plan migration', () => {
  it('copies latest edits, exact payment identity/order/values and empty parents, retaining old income only as evidence', async () => {
    const item = plan('2026-09');
    await store.send(new UpdateCommand({ TableName: 'metadata',Key: item,UpdateExpression: 'SET #payload.#payments=:payments',
      ExpressionAttributeNames: { '#payload': 'payload','#payments': 'upcomingPayments' },ExpressionAttributeValues: { ':payments': [...item.payload.upcomingPayments].reverse() } }));
    const frozen = (await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_sk')).rows;
    await migrateMonthPlans(pool);
    expect((await sql.query('SELECT month,owner FROM olbia.month_plans ORDER BY month')).rows).toEqual([{ month: '2026-09',owner: 'owner' },{ month: '2026-10',owner: 'owner' }]);
    expect((await sql.query('SELECT month,id,name,amount_mxn_minor,due_day,sort_order FROM olbia.planned_payments ORDER BY sort_order')).rows).toEqual([
      { month: '2026-09',id: 'a',name: 'Internet',amount_mxn_minor: 20000,due_day: 15,sort_order: 0 },
      { month: '2026-09',id: 'z',name: 'Renta',amount_mxn_minor: 10000,due_day: 31,sort_order: 1 },
    ]);
    expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_sk')).rows).toEqual(frozen);
    await expect(store.send(new PutCommand({ TableName: 'metadata',Item: item }))).rejects.toMatchObject({ name: 'MigrationPausedException' });
  });
  it('rolls back parents, children, marker and barrier on interruption, then replays without overwriting native edits', async () => {
    const barrier = (await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    const interrupted: TransactionPool = { transaction: fn => sql.transaction(async client => { await fn(client as unknown as SqlClient); throw new Error('Interrupted'); }) };
    await expect(migrateMonthPlans(interrupted)).rejects.toThrow('month-plan-copy');
    expect((await sql.query('SELECT * FROM olbia.month_plans')).rows).toHaveLength(0);
    expect((await sql.query('SELECT * FROM olbia.planned_payments')).rows).toHaveLength(0);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=11')).rows).toHaveLength(0);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(barrier);
    await migrateMonthPlans(pool);
    await sql.query("UPDATE olbia.month_plans SET updated_at='2026-10-02T12:00:00Z' WHERE month='2026-09'");
    await sql.query("DELETE FROM olbia.planned_payments WHERE month='2026-09'");
    await migrateMonthPlans(pool);
    expect((await sql.query('SELECT * FROM olbia.planned_payments')).rows).toHaveLength(0);
    expect((await sql.query<{ updated_at: Date }>("SELECT updated_at FROM olbia.month_plans WHERE month='2026-09'")).rows[0].updated_at.toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });
  it('fails closed on malformed retained arrays or duplicate payment identities without publishing a partial parent', async () => {
    for (const payments of [null,[{ id: 'same',name: 'A',amountMinor: 1,dueDay: 1 },{ id: 'same',name: 'B',amountMinor: 2,dueDay: 2 }]]) {
      await sql.query("UPDATE olbia.monthly_plans SET payload=jsonb_set(payload,'{upcomingPayments}',$1) WHERE month='2026-09'",[JSON.stringify(payments)]);
      await expect(migrateMonthPlans(pool)).rejects.toThrow('month-plan-copy');
      expect((await sql.query('SELECT * FROM olbia.month_plans')).rows).toHaveLength(0);
      expect((await sql.query('SELECT * FROM olbia.planned_payments')).rows).toHaveLength(0);
      expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=11')).rows).toHaveLength(0);
    }
  });
  it('enforces native parent membership, child identity/order and safe positive money/due-day limits', async () => {
    await migrateMonthPlans(pool);
    for (const row of [['missing','valid','Name',1,1,0],['2026-09','a','Name',1,1,9],['2026-09','new','Name',1,1,0],
      ['2026-09','new','Name',0,1,9],['2026-09','new','Name','9007199254740992',1,9],['2026-09','new','Name',1,32,9],
      ['2026-09','new','Name',1,1,100]]) await expect(sql.query('INSERT INTO olbia.planned_payments VALUES ($1,$2,$3,$4,$5,$6)',row)).rejects.toThrow();
    // The same child domain ID can recur in another month's complete plan.
    await sql.query("INSERT INTO olbia.planned_payments VALUES ('2026-10','a','Internet',1,1,0)");
    await expect(sql.query("DELETE FROM olbia.month_plans WHERE month='2026-09'")).rejects.toThrow();
  });
});
