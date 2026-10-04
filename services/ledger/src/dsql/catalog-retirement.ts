import type { SqlClient } from './projection.js';
import { CURRENT_SQL_TABLES, MIGRATION_EVIDENCE_TABLES, NATIVE_DOMAIN_TABLES } from './catalog.js';

const ordered = (values: readonly string[]) => [...values].sort();
const same = (left: readonly string[], right: readonly string[]) => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));

/** Native catalog integrity, independently of any historical document representation. */
export const inspectNativeCatalog = async (client: SqlClient) => {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='olbia' ORDER BY tablename")).rows.map(row => String(row.tablename));
  const frozen = tables.filter(table => (MIGRATION_EVIDENCE_TABLES as readonly string[]).includes(table));
  const current = tables.filter(table => !frozen.includes(table));
  if (!same(current, CURRENT_SQL_TABLES)) throw new Error('Unexpected native SQL table inventory');
  const columns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='olbia' AND table_name=ANY($1::text[])`, [[...CURRENT_SQL_TABLES]])).rows;
  if (columns.some(row => ['source_pk','source_sk','row_id','payload','source_item','index_pk','index_sk'].includes(String(row.column_name))))
    throw new Error('Native SQL contains a retired document column');
  const constraints = (await client.query(`SELECT t.relname AS table_name,c.conname,c.contype,c.convalidated
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    WHERE c.connamespace='olbia'::regnamespace AND t.relname=ANY($1::text[])`, [[...CURRENT_SQL_TABLES]])).rows;
  if (!same(constraints.filter(row => row.contype === 'p').map(row => String(row.table_name)), CURRENT_SQL_TABLES)
    || constraints.some(row => row.convalidated !== true)) throw new Error('Native SQL constraints are incomplete');
  if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=20')).rows.length !== 1)
    throw new Error('Native SQL baseline is incomplete');
  if ((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode !== 'sql')
    throw new Error('Native SQL authority is required');
  return { current, frozen, columns: columns.length, constraints: constraints.length };
};

/** Reviewed deploy-production calls this only after native financial and rollback gates pass.
 * Every DROP is separately committed, restricted and resumable; no new archival relation is created. */
export const retireMigrationEvidence = async (client: SqlClient, verifyRetainedDynamoDb: () => Promise<void>) => {
  const before = await inspectNativeCatalog(client);
  if (before.frozen.length) {
    await verifyRetainedDynamoDb();
    // Resolve actual dependencies before the first destructive statement. Native financial
    // relationships must never be removed implicitly by CASCADE.
    const foreignKeys = (await client.query(`SELECT child.relname AS child,parent.relname AS parent,
      child.relnamespace='olbia'::regnamespace AS child_in_olbia
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
      WHERE c.contype='f' AND parent.relnamespace='olbia'::regnamespace AND parent.relname=ANY($1::text[])`, [before.frozen])).rows;
    if (foreignKeys.some(row => row.child_in_olbia !== true || !before.frozen.includes(String(row.child))))
      throw new Error('Current relation depends on migration evidence');
    const dependentViews = (await client.query(`SELECT DISTINCT v.relname FROM pg_depend d
      JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class v ON v.oid=r.ev_class JOIN pg_class source ON source.oid=d.refobjid
      WHERE v.relkind='v' AND source.relnamespace='olbia'::regnamespace AND source.relname=ANY($1::text[])`, [before.frozen])).rows;
    if (dependentViews.length) throw new Error('View depends on migration evidence');
    const remaining = new Set(before.frozen), dropOrder: string[] = [];
    while (remaining.size) {
      const next = [...remaining].find(table => !foreignKeys.some(row => String(row.parent) === table
        && String(row.child) !== table && remaining.has(String(row.child))));
      if (!next) throw new Error('Migration evidence has cyclic dependencies');
      dropOrder.push(next); remaining.delete(next);
    }
    for (const table of dropOrder) await client.query(`DROP TABLE IF EXISTS olbia.${table} RESTRICT`);
  }
  const after = await inspectNativeCatalog(client);
  if (after.frozen.length || after.columns !== before.columns || after.constraints !== before.constraints)
    throw new Error('Native SQL catalog changed during retirement');
  await client.query('INSERT INTO olbia.schema_migrations VALUES (21,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING');
  return { verified: true, mode: 'native-sql', removedTables: before.frozen.length, remainingTables: after.current.length,
    domainTables: NATIVE_DOMAIN_TABLES.length, controlTables: 3, migrationEvidenceTables: 0, nativeColumns: after.columns,
    nativeConstraints: after.constraints };
};
