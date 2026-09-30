import { TABLE_COLUMNS, TABLE_NAMES } from './model.js';
import type { SqlClient } from './projection.js';

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
  ...TABLE_NAMES.map((table) => `CREATE TABLE IF NOT EXISTS olbia.${table} (
    source_pk text NOT NULL, source_sk text NOT NULL, row_id text NOT NULL,
    ${Object.entries(TABLE_COLUMNS[table]).map(([column, type]) => `${column} ${type}`).join(',')},
    PRIMARY KEY (source_pk,source_sk,row_id))`),
  `CREATE OR REPLACE VIEW olbia.movement_months AS
    SELECT id AS movement_id, spend_month AS month FROM olbia.movements
    UNION SELECT movement_id, month FROM olbia.msi_installments`,
  `INSERT INTO olbia.schema_migrations VALUES (1,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
];

export const bootstrapSchema = async (client: SqlClient, roleArns: readonly string[]): Promise<void> => {
  for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
  for (const [name, table, columns] of [
    ['movements_month_idx', 'movements', 'spend_month,id'],
    ['installments_month_idx', 'msi_installments', 'month,movement_id'],
  ]) {
    const job = await client.query(`CREATE INDEX ASYNC IF NOT EXISTS ${name} ON olbia.${table} (${columns})`);
    if (job.rows[0]?.job_id) {
      const completed = await client.query('SELECT sys.wait_for_job($1) AS completed', [job.rows[0].job_id]);
      if (completed.rows[0]?.completed !== true) throw new Error('DSQL index build failed');
    }
    const valid = await client.query('SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass', [`olbia.${name}`]);
    if (valid.rows[0]?.indisvalid !== true) throw new Error('DSQL index is not ready');
  }

  const existing = await client.query("SELECT rolname FROM pg_roles WHERE rolname='olbia_projector'");
  if (!existing.rows.length) await client.query('CREATE ROLE olbia_projector WITH LOGIN');
  await client.query('GRANT USAGE ON SCHEMA olbia TO olbia_projector');
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${['projection_state', ...TABLE_NAMES].map((table) => `olbia.${table}`).join(',')} TO olbia_projector`);
  await client.query('GRANT SELECT ON olbia.schema_migrations,olbia.movement_months TO olbia_projector');
  for (const arn of roleArns) {
    if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid runtime role ARN');
    await client.query(`AWS IAM GRANT olbia_projector TO '${arn}'`);
  }
};
