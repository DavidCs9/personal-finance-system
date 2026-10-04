import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS as historicalSchema } from './helpers/migration-schema.js';
import { bootstrapSchema, SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { CURRENT_SQL_TABLES, MIGRATION_EVIDENCE_TABLES } from '../src/dsql/catalog.js';
import { inspectNativeCatalog, retireMigrationEvidence } from '../src/dsql/catalog-retirement.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite;
beforeEach(async () => {
  sql = new PGlite();
  for (const statement of historicalSchema) await sql.query(statement);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (20,CURRENT_TIMESTAMP)');
  await sql.query("INSERT INTO olbia.cards (source_pk,source_sk,row_id,payload) VALUES ('old','old','old','{}')");
  await sql.query("INSERT INTO olbia.month_plans VALUES ('2026-10','owner',CURRENT_TIMESTAMP)");
}, 30_000);
afterEach(() => sql.close());
const snapshot = async () => Object.fromEntries(await Promise.all(CURRENT_SQL_TABLES.filter(table => table !== 'schema_migrations')
  .map(async table => [table, (await sql.query(`SELECT * FROM olbia.${table}`)).rows])));

it('removes exactly the 26 explicit migration tables, keeps every native row, and resumes without source access or recreation', async () => {
  const before = await snapshot(), recovery = vi.fn(async () => {});
  expect((await inspectNativeCatalog(sql)).frozen).toHaveLength(26);
  expect(await retireMigrationEvidence(sql, recovery)).toMatchObject({ verified: true, removedTables: 26,
    remainingTables: 41, domainTables: 38, controlTables: 3, migrationEvidenceTables: 0 });
  expect(await snapshot()).toEqual(before);
  expect(recovery).toHaveBeenCalledOnce();
  expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=21')).rows).toEqual([{ version: 21 }]);
  expect(await retireMigrationEvidence(sql, recovery)).toMatchObject({ removedTables: 0, remainingTables: 41 });
  expect(recovery).toHaveBeenCalledOnce();
  const client: SqlClient = { query: async (s, v) => {
    if (s.startsWith('AWS IAM GRANT')) return { rows: [] };
    if (s.startsWith('CREATE INDEX ASYNC')) return sql.query(s.replace('INDEX ASYNC', 'INDEX'), v);
    if (s.startsWith('ALTER TABLE ASYNC')) {
      await sql.query(s.replace('TABLE ASYNC', 'TABLE'), v); return { rows: [{ job_id: 'local-validation' }] };
    }
    return sql.query<Record<string, unknown>>(s, v);
  } };
  await bootstrapSchema(client, []);
  expect((await inspectNativeCatalog(sql)).frozen).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(SCHEMA_STATEMENTS.join('\n')).not.toMatch(/source_pk|source_sk|source_item|projection_state|command_receipts/);
});

it('refuses deletion before the first DROP when DynamoDB recovery, native authority or the native catalog is invalid', async () => {
  const recovery = vi.fn(async () => { throw new Error('Recovery unavailable'); });
  await expect(retireMigrationEvidence(sql, recovery)).rejects.toThrow('Recovery unavailable');
  expect((await inspectNativeCatalog(sql)).frozen).toHaveLength(26);
  await sql.query("UPDATE olbia.runtime_state SET mode='paused'");
  await expect(retireMigrationEvidence(sql, recovery)).rejects.toThrow('authority');
  expect(recovery).toHaveBeenCalledOnce();
  await sql.query("UPDATE olbia.runtime_state SET mode='sql'");
  await sql.query('CREATE TABLE olbia.unreviewed (id integer PRIMARY KEY)');
  await expect(retireMigrationEvidence(sql, recovery)).rejects.toThrow('inventory');
  expect(recovery).toHaveBeenCalledOnce();
});

it('refuses current view and FK dependencies without CASCADE or partial deletion', async () => {
  await sql.query('CREATE VIEW public.external_recovery_consumer AS SELECT id FROM olbia.movements');
  await expect(retireMigrationEvidence(sql, async () => {})).rejects.toThrow('View depends');
  expect((await inspectNativeCatalog(sql)).frozen).toHaveLength(26);
  await sql.query('DROP VIEW public.external_recovery_consumer');
  await sql.query('CREATE TABLE public.external_consumer (pk text,sk text,id text,FOREIGN KEY(pk,sk,id) REFERENCES olbia.movements(source_pk,source_sk,row_id))');
  await expect(retireMigrationEvidence(sql, async () => {})).rejects.toThrow('Current relation depends');
  expect((await inspectNativeCatalog(sql)).frozen).toHaveLength(26);
});

it('orders retired child tables before parents and resumes an interrupted sequence without changing native rows', async () => {
  await sql.query('ALTER TABLE olbia.cards ADD CONSTRAINT historical_parent FOREIGN KEY(source_pk,source_sk,row_id) REFERENCES olbia.movements(source_pk,source_sk,row_id) NOT VALID');
  const before = await snapshot(), drops: string[] = [];
  const client: SqlClient = { query: async (s, v) => {
    if (s.startsWith('DROP TABLE')) { drops.push(s); if (drops.length === 4) throw new Error('Interrupted DDL'); }
    return sql.query<Record<string, unknown>>(s, v);
  } };
  await expect(retireMigrationEvidence(client, async () => {})).rejects.toThrow('Interrupted DDL');
  expect(drops.join()).not.toContain('CASCADE');
  expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=21')).rows).toEqual([]);
  expect(await retireMigrationEvidence(sql, async () => {})).toMatchObject({ verified: true, remainingTables: 41 });
  expect(await snapshot()).toEqual(before);
  const names = drops.map(s => s.match(/olbia\.(\w+)/)![1]);
  expect(names).toContain('cards'); expect(names).not.toContain('movements');
  expect(MIGRATION_EVIDENCE_TABLES.some(table => (CURRENT_SQL_TABLES as readonly string[]).includes(table))).toBe(false);
});
