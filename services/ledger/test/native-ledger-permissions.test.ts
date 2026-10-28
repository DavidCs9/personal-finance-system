import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bootstrapSchema } from '../src/dsql/schema.js';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { smokeNativeLedger } from '../src/dsql/ledger-smoke.js';
import { smokeNativePlanning } from '../src/dsql/planning-smoke.js';
import { NATIVE_PLANNING_TABLES } from '../src/dsql/planning-schema.js';
import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite;
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  const client: SqlClient = {query: async (statement, values) => {
    if (statement.startsWith('AWS IAM GRANT')) return {rows:[]};
    if (statement.startsWith('CREATE INDEX ASYNC')) return sql.query(statement.replace('INDEX ASYNC','INDEX'), values);
    if (statement.startsWith('ALTER TABLE ASYNC')) {
      await sql.query(statement.replace('TABLE ASYNC','TABLE'), values);
      return {rows:[{job_id:'local-validation'}]};
    }
    return sql.query<Record<string,unknown>>(statement, values);
  }};
  const identity = ['arn:aws:iam::225989371926:role/permission-test'];
  for(const version of [8,9,10,11,12,13,14,15,16,17,18,19,20]) await sql.query('INSERT INTO olbia.schema_migrations VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING',[version]);
  await bootstrapSchema(client, [], {transactionPool: {transaction: fn => sql.transaction(c => fn(c as unknown as SqlClient))},
    applicationRoleArns: identity, readerRoleArns: identity, operationalVerifierRoleArns: identity});
}, 30_000);
afterEach(() => sql.query('RESET ROLE'));
afterAll(() => sql.close());
const snapshot = async () => Object.fromEntries(await Promise.all([...NATIVE_LEDGER_TABLES,...NATIVE_PLANNING_TABLES,'month_plans','planned_payments','projection_state','command_receipts']
  .map(async table => [table,(await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1`)).rows])));

it('executes the deployed native smoke with actual application privileges and rolls every row back', async () => {
  const before = await snapshot();
  await sql.query('SET ROLE olbia_application');
  const rollback = new Error('Expected rollback');
  await expect(sql.transaction(async client => {
    await smokeNativeLedger(client as unknown as SqlClient, 'owner', 'shopping');
    expect((await client.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
    expect((await client.query('SELECT id FROM olbia.ledger_revisions')).rows).toHaveLength(2);
    expect((await client.query('SELECT status FROM olbia.ledger_bulk_operations')).rows).toEqual([{status:'undone'}]);
    throw rollback;
  })).rejects.toBe(rollback);
  await sql.query('RESET ROLE');
  expect(await snapshot()).toEqual(before);
});

it('denies alteration/deletion of original assertions and alteration of frozen bulk proposal columns', async () => {
  await sql.query('SET ROLE olbia_application');
  for (const table of ['ledger_observations','ledger_observation_warnings','ledger_revisions','source_claims','ledger_bulk_members','planned_payment_charge_revisions']) {
    await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
    const column = table === 'ledger_observation_warnings' ? 'message' : table === 'ledger_bulk_members' ? 'merchant_assertion' :
      table === 'source_claims' ? 'token' : 'id';
    await expect(sql.query(`UPDATE olbia.${table} SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
  }
  await expect(sql.query('DELETE FROM olbia.ledger_movements')).rejects.toMatchObject({code:'42501'});
  await expect(sql.query('DELETE FROM olbia.ledger_bulk_operations')).rejects.toMatchObject({code:'42501'});
  for (const column of ['owner','selection_assertion','change_assertion','created_at','expires_at'])
    await expect(sql.query(`UPDATE olbia.ledger_bulk_operations SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
});

it('keeps the product SQL reader read-only and without recovery assertions', async () => {
  await sql.query('SET ROLE olbia_reader');
  for (const table of [...NATIVE_LEDGER_TABLES,...NATIVE_PLANNING_TABLES]) {
    await expect(sql.query(`SELECT 1 FROM olbia.${table}`)).resolves.toBeDefined();
    await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
  }
  for (const table of ['projection_state','dedupe_claims','bulk_edit_operations'])
    await expect(sql.query(`SELECT 1 FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
});


it('lets only the isolated verifier read current native facts and retained assertions without write access', async () => {
  await sql.query('SET ROLE olbia_operational_verifier');
  for (const table of [...NATIVE_LEDGER_TABLES,...NATIVE_PLANNING_TABLES,'payslips','planned_payments','bank_imports']) {
    await expect(sql.query(`SELECT 1 FROM olbia.${table}`)).resolves.toBeDefined();
    await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
  }
});

it('smokes monthly relationships with application grants and rolls back even when the month already has a link', async () => {
  const before=await snapshot(),rollback=new Error('Expected planning rollback');
  await sql.query('SET ROLE olbia_application');
  await expect(sql.transaction(async client => {
    const movement=await smokeNativeLedger(client as unknown as SqlClient,'owner','shopping');
    await client.query("INSERT INTO olbia.month_plans VALUES ('2026-10','owner',CURRENT_TIMESTAMP)");
    await client.query("INSERT INTO olbia.planned_payments VALUES ('2026-10','original','Original',39900,18,0)");
    await client.query("INSERT INTO olbia.planned_payment_charges VALUES ('2026-10','original',$1,CURRENT_TIMESTAMP,'owner')",[movement]);
    const revision=randomUUID();
    await client.query(`INSERT INTO olbia.planned_payment_charge_revisions
      VALUES ($1,'2026-10','original',CURRENT_TIMESTAMP,'owner','link',NULL,$2,'{"name":"Original"}')`,[revision,movement]);
    await smokeNativePlanning(client as unknown as SqlClient,'owner',movement);
    expect((await client.query('SELECT id FROM olbia.planned_payment_charge_revisions WHERE id=$1',[revision])).rows).toHaveLength(1);
    expect((await client.query('SELECT * FROM olbia.planned_payment_charge_revisions')).rows).toHaveLength(3);
    expect((await client.query('SELECT * FROM olbia.planned_payment_charges')).rows).toHaveLength(0);
    throw rollback;
  })).rejects.toBe(rollback);
  await sql.query('RESET ROLE');
  expect(await snapshot()).toEqual(before);
});

it('enforces real payment/movement membership and forbids one charge from covering two fixed items', async () => {
  for (const failure of ['missing-payment','missing-movement','reused-charge','linked-delete']) {
    await expect(sql.transaction(async client => {
      const movement=await smokeNativeLedger(client as unknown as SqlClient,'owner','shopping');
      await client.query("INSERT INTO olbia.month_plans VALUES ('2026-10','owner',CURRENT_TIMESTAMP)");
      await client.query("INSERT INTO olbia.planned_payments VALUES ('2026-10','one','One',1,1,0),('2026-10','two','Two',1,1,1)");
      const insert="INSERT INTO olbia.planned_payment_charges VALUES ('2026-10',$1,$2,CURRENT_TIMESTAMP,'owner')";
      if (failure==='missing-payment') await client.query(insert,['absent',movement]);
      else if (failure==='missing-movement') await client.query(insert,['one',randomUUID()]);
      else {
        await client.query(insert,['one',movement]);
        if (failure==='reused-charge') await client.query(insert,['two',movement]);
        else await client.query("DELETE FROM olbia.planned_payments WHERE month='2026-10' AND id='one'");
      }
      throw new Error('Native constraint did not reject invalid relationship');
    })).rejects.toMatchObject({code:failure==='reused-charge' ? '23505' : '23503'});
  }
});

it('denies migration copies to the native verifier before catalog retirement', async () => {
  await sql.query('SET ROLE olbia_operational_verifier');
  for(const table of ['projection_state','dedupe_claims','bulk_edit_operations','monthly_plans','payroll','wealth_snapshots'])
    await expect(sql.query(`SELECT 1 FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
});
