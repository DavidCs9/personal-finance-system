import { TABLE_COLUMNS, TABLE_NAMES, OPERATIONAL_TABLE_NAMES } from './model.js';
import type { SqlClient } from './projection.js';
import { isOCCError } from '@aws/aurora-dsql-node-postgres-connector';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';

export class BootstrapFailure extends Error {
  constructor(stage: string, error?: unknown) {
    const code = (error as { code?: unknown })?.code;
    const safeCode = typeof code === 'string' && /^(?:[A-Z0-9]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code) ? code : 'operation';
    super(`DSQL bootstrap failed at ${stage} (${safeCode})`);
  }
}

// DSQL has no CloudFormation SQL-schema resource. Additive, independently
// committed DDL is resumable; Delete of the provider must never run DROP.
export const SCHEMA_STATEMENTS = [
  'CREATE SCHEMA IF NOT EXISTS olbia',
  `CREATE TABLE IF NOT EXISTS olbia.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.projection_state (
    source_pk text NOT NULL, source_sk text NOT NULL, generation bigint NOT NULL,
    source_hash text, source_item jsonb, deleted boolean NOT NULL,
    transformer_version integer NOT NULL, reconciled_at timestamptz NOT NULL,
    stream_arn text, stream_sequence text, stream_delivered_at timestamptz,
    PRIMARY KEY (source_pk,source_sk))`,
  `CREATE TABLE IF NOT EXISTS olbia.runtime_state (id text PRIMARY KEY, mode text NOT NULL, changed_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.application_barrier (id text PRIMARY KEY, generation bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.command_receipts (token text PRIMARY KEY, request_hash text NOT NULL, expires_at bigint NOT NULL)`,
  `INSERT INTO olbia.runtime_state VALUES ('storage','dynamodb',CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO olbia.application_barrier VALUES ('storage',0) ON CONFLICT (id) DO NOTHING`,
  ...TABLE_NAMES.map((table) => `CREATE TABLE IF NOT EXISTS olbia.${table} (
    source_pk text NOT NULL, source_sk text NOT NULL, row_id text NOT NULL,
    ${Object.entries(TABLE_COLUMNS[table]).map(([column, type]) => `${column} ${type}`).join(',')},
    PRIMARY KEY (source_pk,source_sk,row_id))`),
  // Existing cards need the original envelope/timestamps for supporting Patrimonio reads.
  `ALTER TABLE olbia.cards ADD COLUMN IF NOT EXISTS source_item jsonb`,
  `CREATE OR REPLACE VIEW olbia.movement_months AS
    SELECT id AS movement_id, spend_month AS month FROM olbia.movements
    UNION SELECT movement_id, month FROM olbia.msi_installments`,
  `INSERT INTO olbia.schema_migrations VALUES (1,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
  // Version 2 is additive: only new tables. Existing column definitions are unchanged.
  `INSERT INTO olbia.schema_migrations VALUES (2,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
  `INSERT INTO olbia.schema_migrations VALUES (3,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
  `INSERT INTO olbia.schema_migrations VALUES (4,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
  `INSERT INTO olbia.schema_migrations VALUES (5,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
  // Version 6: SQL-native category authority. The old projection is retained only
  // as migration evidence; new category writes never update its envelopes.
  `CREATE TABLE IF NOT EXISTS olbia.spend_categories (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,39}$'),
    name text NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
    sort_order integer NOT NULL)`,
  `INSERT INTO olbia.spend_categories (id,name,sort_order)
    SELECT id,name,sort_order FROM olbia.categories
    WHERE NOT EXISTS (SELECT 1 FROM olbia.schema_migrations WHERE version=6)
    ON CONFLICT (id) DO NOTHING`,
  ...DEFAULT_SPEND_CATEGORIES.map(category => `INSERT INTO olbia.spend_categories (id,name,sort_order)
    SELECT '${category.id}','${category.name.replace(/'/g, "''")}',${category.sortOrder}
    WHERE NOT EXISTS (SELECT 1 FROM olbia.schema_migrations WHERE version=6)
    ON CONFLICT (id) DO NOTHING`),
  `INSERT INTO olbia.schema_migrations VALUES (6,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
];

export const bootstrapSchema = async (client: SqlClient, roleArns: readonly string[], options: {
  now?: () => number; pause?: (ms: number) => Promise<void>; indexWaitMs?: number; readerRoleArns?: readonly string[]; operationalVerifierRoleArns?: readonly string[]; applicationRoleArns?: readonly string[]; storeReaderRoleArns?: readonly string[]; cutoverRoleArns?: readonly string[];
} = {}): Promise<void> => {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const query = async (stage: string, statement: string, params?: unknown[]) => {
    for (let attempt = 0; ; attempt++) {
      try { return await client.query(statement, params); }
      catch (error) {
        if (!isOCCError(error) || attempt >= 4) throw new BootstrapFailure(stage, error);
        // One autocommit statement per retry; never combine DDL and DML.
        await pause(25 * 2 ** attempt);
      }
    }
  };
  for (const [index, statement] of SCHEMA_STATEMENTS.entries()) await query(`schema-statement-${index + 1}`, statement);
  for (const [name, table, columns] of [
    ['movements_month_idx', 'movements', 'spend_month,id'],
    ['installments_month_idx', 'msi_installments', 'month,movement_id'],
  ]) {
    await query(`index-create-${name}`, `CREATE INDEX ASYNC IF NOT EXISTS ${name} ON olbia.${table} (${columns})`);
    const deadline = now() + (options.indexWaitMs ?? 180_000);
    for (;;) {
      const valid = await query(`index-ready-${name}`, 'SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass', [`olbia.${name}`]);
      if (valid.rows[0]?.indisvalid === true) break;
      // IF NOT EXISTS returns no job ID when resuming an interrupted build.
      // sys.wait_for_job is a PROCEDURE, not a function for SELECT.
      const jobs = await query(`index-status-${name}`, 'SELECT status FROM sys.jobs WHERE object_id=$1::regclass AND job_type=$2', [`olbia.${name}`, 'INDEX_BUILD']);
      if (jobs.rows.some((job) => job.status === 'failed')) throw new BootstrapFailure(`index-build-${name}`);
      if (now() >= deadline) throw new BootstrapFailure(`index-timeout-${name}`);
      await pause(1_000);
    }
  }

  const existing = await query('role-lookup', "SELECT rolname FROM pg_roles WHERE rolname='olbia_projector'");
  if (!existing.rows.length) await query('role-create', 'CREATE ROLE olbia_projector WITH LOGIN');
  await query('schema-grant', 'GRANT USAGE ON SCHEMA olbia TO olbia_projector');
  await query('tables-grant', `GRANT SELECT,INSERT,UPDATE,DELETE ON ${['projection_state', ...TABLE_NAMES].map((table) => `olbia.${table}`).join(',')} TO olbia_projector`);
  await query('read-grant', 'GRANT SELECT ON olbia.schema_migrations,olbia.movement_months,olbia.runtime_state TO olbia_projector');
  await query('catalog-projector-read', 'GRANT SELECT ON olbia.spend_categories TO olbia_projector');
  await query('projector-barrier-grant','GRANT SELECT,UPDATE ON olbia.application_barrier TO olbia_projector');
  for (const arn of roleArns) {
    if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid runtime role ARN');
    await query('iam-grant', `AWS IAM GRANT olbia_projector TO '${arn}'`);
  }
  if (options.readerRoleArns?.length) {
    const reader = await query('reader-role-lookup', "SELECT rolname FROM pg_roles WHERE rolname='olbia_reader'");
    if (!reader.rows.length) await query('reader-role-create', 'CREATE ROLE olbia_reader WITH LOGIN');
    await query('reader-schema-grant', 'GRANT USAGE ON SCHEMA olbia TO olbia_reader');
    await query('reader-tables-grant', `GRANT SELECT ON ${['movements', 'movement_observations', 'movement_revisions', 'msi_installments', 'monthly_plans', 'payroll', 'cards', 'wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions', 'categories', 'merchant_category_rules', 'ingestion_exceptions', 'import_records', 'push_subscriptions', 'assistant_threads'].map(table => `olbia.${table}`).join(',')} TO olbia_reader`);
    await query('catalog-reader-read', 'GRANT SELECT ON olbia.spend_categories TO olbia_reader');
    for (const arn of options.readerRoleArns) {
      if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid reader role ARN');
      await query('reader-iam-grant', `AWS IAM GRANT olbia_reader TO '${arn}'`);
    }
  }
  if (options.operationalVerifierRoleArns?.length) {
    const role = 'olbia_operational_verifier';
    const existing = await query('operational-verifier-lookup', `SELECT rolname FROM pg_roles WHERE rolname='${role}'`);
    if (!existing.rows.length) await query('operational-verifier-create', `CREATE ROLE ${role} WITH LOGIN`);
    await query('operational-verifier-schema', `GRANT USAGE ON SCHEMA olbia TO ${role}`);
    await query('operational-verifier-select', `GRANT SELECT ON ${OPERATIONAL_TABLE_NAMES.map(table => `olbia.${table}`).join(',')} TO ${role}`);
    for (const arn of options.operationalVerifierRoleArns) {
      if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid verifier role ARN');
      await query('operational-verifier-iam', `AWS IAM GRANT ${role} TO '${arn}'`);
    }
  }
  for (const [role,arns,writer,operator] of [
    ['olbia_application',options.applicationRoleArns,true,false],
    ['olbia_store_reader',options.storeReaderRoleArns,false,false],
    ['olbia_cutover',options.cutoverRoleArns,true,true],
  ] as const) {
    if (!arns?.length) continue;
    if (!(await query(`lookup-${role}`, 'SELECT rolname FROM pg_roles WHERE rolname=$1',[role])).rows.length) await query(`create-${role}`,`CREATE ROLE ${role} WITH LOGIN`);
    await query(`schema-${role}`,`GRANT USAGE ON SCHEMA olbia TO ${role}`);
    await query(`select-${role}`,`GRANT SELECT ON olbia.runtime_state,olbia.projection_state,olbia.schema_migrations TO ${role}`);
    if (writer) await query(`write-${role}`,`GRANT SELECT,INSERT,UPDATE,DELETE ON ${['projection_state','application_barrier','command_receipts',...TABLE_NAMES].map(t=>`olbia.${t}`).join(',')} TO ${role}`);
    if (writer) await query(`view-${role}`,`GRANT SELECT ON olbia.movement_months TO ${role}`);
    await query(`catalog-read-${role}`, `GRANT SELECT ON olbia.spend_categories TO ${role}`);
    if (writer) await query(`catalog-write-${role}`, `GRANT INSERT,UPDATE ON olbia.spend_categories TO ${role}`);
    if (operator) await query(`control-${role}`,`GRANT UPDATE ON olbia.runtime_state TO ${role}`);
    for (const arn of arns) {
      if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid application role ARN');
      await query(`iam-${role}`,`AWS IAM GRANT ${role} TO '${arn}'`);
    }
  }

};
