import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ensureAmexActivitySchema } from '../src/dsql/schema.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite;
beforeAll(async () => {
  sql = new PGlite();
  await sql.exec(`CREATE SCHEMA olbia;
    CREATE TABLE olbia.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz);
    CREATE TABLE olbia.bank_imports(kind text CHECK(kind IN ('amex_statement','santander_statement','santander_csv')));
    CREATE TABLE olbia.bank_import_rows(identity text);
    CREATE TABLE olbia.ledger_observations(capture_source text CHECK(capture_source IN ('email','manual')));
    CREATE TABLE olbia.source_claims(capture_source text CHECK(capture_source IN ('email','manual')));
    INSERT INTO olbia.bank_imports VALUES ('amex_statement');
    INSERT INTO olbia.ledger_observations VALUES ('email'); INSERT INTO olbia.source_claims VALUES ('manual');`);
}, 30_000);
afterAll(() => sql.close());
it('upgrades restrictive deployed checks, retains rows, adds typed evidence and resumes safely', async () => {
  const client: SqlClient = { query: async (s, p) => {
    if (s.startsWith('ALTER TABLE ASYNC')) {
      await sql.query(s.replace('TABLE ASYNC', 'TABLE'), p); return { rows: [{ job_id: 'local-validation' }] };
    }
    return sql.query<Record<string, unknown>>(s, p);
  } };
  await ensureAmexActivitySchema(client); await ensureAmexActivitySchema(client);
  expect((await sql.query('SELECT * FROM olbia.bank_imports')).rows).toEqual([{ kind: 'amex_statement' }]);
  await sql.query("INSERT INTO olbia.bank_imports VALUES ('amex_activity')");
  await sql.query("INSERT INTO olbia.ledger_observations VALUES ('amex_activity')");
  await sql.query("INSERT INTO olbia.source_claims VALUES ('amex_activity')");
  for (const [table, column] of [['bank_imports', 'kind'], ['ledger_observations', 'capture_source'], ['source_claims', 'capture_source']])
    await expect(sql.query(`INSERT INTO olbia.${table} (${column}) VALUES ('unknown')`)).rejects.toMatchObject({ code: '23514' });
  expect((await sql.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='olbia' AND table_name='bank_import_rows' AND column_name IN ('purchase_on','merchant_reference') ORDER BY column_name")).rows)
    .toEqual([{ column_name: 'merchant_reference', data_type: 'text' }, { column_name: 'purchase_on', data_type: 'date' }]);
  expect((await sql.query('SELECT version FROM olbia.schema_migrations')).rows).toEqual([{ version: 23 }]);
});
it('never removes the restrictive check or records completion after failed provider validation', async () => {
  const query = vi.fn(async (s: string) => ({ rows: s.includes('pg_constraint') ? [{ convalidated: false }]
    : s.startsWith('ALTER TABLE ASYNC') ? [{ job_id: 'failed-job' }] : s.includes('sys.jobs') ? [{ status: 'failed' }] : [] }));
  await expect(ensureAmexActivitySchema({ query })).rejects.toThrow('amex-activity-constraint-validation');
  expect(query.mock.calls.map(([s]) => s).join()).not.toMatch(/DROP CONSTRAINT|INSERT INTO olbia.schema_migrations/);
});
