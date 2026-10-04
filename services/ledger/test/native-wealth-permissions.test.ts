import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bootstrapSchema } from '../src/dsql/schema.js';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { NATIVE_WEALTH_TABLES, nativeWealthReadGrant, nativeWealthWriteGrants } from '../src/dsql/wealth-schema.js';
import { insertNativeAssetCapture } from '../src/dsql/wealth-writes.js';
import { smokeNativeWealth } from '../src/dsql/wealth-smoke.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite;
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  const client: SqlClient = { query: async (statement, values) => {
    if (statement.startsWith('AWS IAM GRANT')) return { rows: [] };
    if (statement.startsWith('CREATE INDEX ASYNC')) return sql.query(statement.replace('INDEX ASYNC', 'INDEX'), values);
    if (statement.startsWith('ALTER TABLE ASYNC')) { await sql.query(statement.replace('TABLE ASYNC', 'TABLE'), values); return { rows: [{ job_id: 'local-validation' }] }; }
    return sql.query<Record<string, unknown>>(statement, values);
  } };
  const identity = ['arn:aws:iam::225989371926:role/permission-test'];
  for(const version of [8,9,10,11,12,13,14,15,16,17,18,19,20]) await sql.query('INSERT INTO olbia.schema_migrations VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING',[version]);
  await sql.query(`INSERT INTO olbia.asset_accounts VALUES ('nu_cajita_emergencia','Cajita','Nu','emergency_fund','manual',0),('bitso','Bitso','Bitso','crypto','api',1),('ibkr','IBKR','IBKR','brokerage','flex',2) ON CONFLICT DO NOTHING`);
  await bootstrapSchema(client, [], { transactionPool: { transaction: fn => sql.transaction(c => fn(c as unknown as SqlClient)) },
    applicationRoleArns: identity, readerRoleArns: identity, operationalVerifierRoleArns: identity, storeReaderRoleArns: identity, cutoverRoleArns: identity });
  const at = '2026-10-02T12:00:00.123Z';
  await sql.query("INSERT INTO olbia.card_profiles VALUES ('amex','owner','Amex',25,15,'american_express_mx',$1,$1,NULL)", [at]);
  await sql.transaction(c => insertNativeAssetCapture(c as unknown as SqlClient, { id: randomUUID(), owner: 'owner', snapshot: {
    accountId: 'nu_cajita_emergencia', day: '2026-10-02', capturedAt: at, source: 'manual', currency: 'MXN', totalMxnMinor: 100,
    holdings: [{ id: 'cash', symbol: 'MXN', name: 'Cash', quantity: 1, currency: 'MXN', valueNativeMinor: 100, valueMxnMinor: 100 }],
    evidence: { bucket: 'original', key: 'original', sha256: 'a'.repeat(64), contentType: 'application/json' },
  } }));
}, 30_000);
afterAll(() => sql.close());
afterEach(() => sql.query('RESET ROLE'));
const snapshot = async () => Object.fromEntries(await Promise.all([...NATIVE_WEALTH_TABLES, 'wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions']
  .map(async t => [t, (await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));

it('executes the actual wealth capture smoke with product and operator privileges and rolls every relation back', async () => {
  const before = await snapshot();
  for (const role of ['olbia_application', 'olbia_cutover']) {
    await sql.query(`SET ROLE ${role}`); const rollback = new Error('Expected complete rollback');
    await expect(sql.transaction(async c => { await smokeNativeWealth(c as unknown as SqlClient, 'owner', 'amex'); throw rollback; })).rejects.toBe(rollback);
    await sql.query('RESET ROLE'); expect(await snapshot()).toEqual(before);
  }
});
it('denies all writer alterations/deletions of originals and catalog writes, while permitting only daily capture selection changes', async () => {
  for (const role of ['olbia_application', 'olbia_cutover']) {
    await sql.query(`SET ROLE ${role}`);
    for (const table of ['asset_captures', 'asset_holdings', 'asset_capture_replacements', 'liability_captures', 'liability_capture_replacements', 'asset_accounts']) {
      await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({ code: '42501' });
      const column = table.endsWith('replacements') ? 'previous_capture_id' : 'id';
      await expect(sql.query(`UPDATE olbia.${table} SET ${column}=${column}`)).rejects.toMatchObject({ code: '42501' });
    }
    for (const [table, identity] of [['asset_daily_captures', 'account_id'], ['liability_daily_captures', 'card_id']]) {
      await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(sql.query(`UPDATE olbia.${table} SET ${identity}=${identity}`)).rejects.toMatchObject({ code: '42501' });
      await expect(sql.query(`UPDATE olbia.${table} SET day=day`)).rejects.toMatchObject({ code: '42501' });
    }
    await sql.query('RESET ROLE');
  }
});
it('keeps product/store/audit reader identities SELECT-only on every native wealth relation', async () => {
  for (const role of ['olbia_reader', 'olbia_store_reader', 'olbia_operational_verifier']) {
    await sql.query(`SET ROLE ${role}`);
    for (const table of NATIVE_WEALTH_TABLES) {
      await expect(sql.query(`SELECT 1 FROM olbia.${table}`)).resolves.toBeDefined();
      await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    await sql.query('RESET ROLE');
  }
});
it('defines the native relation grant without granting a mutable original or account catalog', () => {
  expect(nativeWealthReadGrant('olbia_reader')).toContain('olbia.asset_accounts,olbia.asset_captures,olbia.asset_holdings');
  expect(nativeWealthWriteGrants('olbia_application').join()).not.toMatch(/GRANT UPDATE ON|DELETE|INSERT ON olbia.asset_accounts/);
});

it('revokes frozen wealth recovery reads for every role and prevents every runtime recovery mutation', async () => {
  const retained = ['wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions'];
  for (const role of ['olbia_application', 'olbia_cutover', 'olbia_store_reader', 'olbia_reader', 'olbia_operational_verifier', 'olbia_projector']) {
    await sql.query(`SET ROLE ${role}`);
    for (const table of retained) {
      await expect(sql.query(`SELECT 1 FROM olbia.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(sql.query(`UPDATE olbia.${table} SET source_item=source_item`)).rejects.toMatchObject({ code: '42501' });
    }
    await sql.query('RESET ROLE');
  }
});
