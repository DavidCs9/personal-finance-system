import { NATIVE_EXCEPTION_SCHEMA_STATEMENTS,nativeExceptionReadGrant,nativeExceptionWriteGrants } from './exception-schema.js';
import { NATIVE_THREAD_SCHEMA_STATEMENTS, nativeThreadReadGrant, nativeThreadWriteGrants } from './thread-schema.js';
import { NATIVE_DELIVERY_SCHEMA_STATEMENTS, nativeDeliveryReadGrant, nativeDeliveryWriteGrant } from './delivery-schema.js';
import { NATIVE_PUSH_SCHEMA_STATEMENT, nativePushReadGrant, nativePushMetadataGrant, nativePushWriteGrants } from './push-schema.js';
import type { SqlClient, TransactionPool } from './projection.js';
import { isOCCError } from '@aws/aurora-dsql-node-postgres-connector';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from './ledger-schema.js';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS, nativeWealthReadGrant, nativeWealthWriteGrants } from './wealth-schema.js';

import { MIGRATION_EVIDENCE_TABLES } from './catalog.js';
export class BootstrapFailure extends Error {
  constructor(stage: string, error?: unknown) {
    const code = (error as { code?: unknown })?.code;
    const safeCode = typeof code === 'string' && /^(?:[A-Z0-9]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code) ? code : 'operation';
    super(`DSQL bootstrap failed at ${stage} (${safeCode})`);
  }
}

// Native domain definitions only. Historical migration fixtures live under test/helpers.
export const SCHEMA_STATEMENTS = [
  'CREATE SCHEMA IF NOT EXISTS olbia',
  `CREATE TABLE IF NOT EXISTS olbia.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.runtime_state (id text PRIMARY KEY, mode text NOT NULL, changed_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.application_barrier (id text PRIMARY KEY, generation bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.spend_categories (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,39}$'),
    name text NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
    sort_order integer NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.merchant_rules (
    merchant_key text PRIMARY KEY CHECK (merchant_key ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
    id text NOT NULL CHECK (length(id) > 0), pattern text,
    category_id text CONSTRAINT merchant_rules_category_fk REFERENCES olbia.spend_categories(id),
    source text NOT NULL CHECK (source IN ('seed','human','llm_residual','agent_confirmed')),
    updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.card_profiles (
    id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
    owner text NOT NULL CHECK (length(owner) > 0),
    name text NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
    cut_off_day integer NOT NULL CHECK (cut_off_day BETWEEN 1 AND 31),
    payment_due_day integer NOT NULL CHECK (payment_due_day BETWEEN 1 AND 31),
    institution text CHECK (institution IN ('american_express_mx','santander_mx','nu_mx')),
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS olbia.month_plans (
    month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    owner text NOT NULL CHECK (length(owner) > 0), updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.planned_payments (
    month text NOT NULL CONSTRAINT planned_payments_month_fk REFERENCES olbia.month_plans(month),
    id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
    name text NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor BETWEEN 1 AND 9007199254740991),
    due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
    PRIMARY KEY (month,id), CONSTRAINT planned_payments_order_key UNIQUE (month,sort_order))`,
  `CREATE TABLE IF NOT EXISTS olbia.payslips (
    uuid uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    paid_on date NOT NULL, payroll_type text NOT NULL CHECK (length(payroll_type)>0),
    total_mxn_minor bigint NOT NULL CHECK (total_mxn_minor BETWEEN 0 AND 9007199254740991),
    perceptions_mxn_minor bigint NOT NULL CHECK (perceptions_mxn_minor BETWEEN 0 AND 9007199254740991),
    deductions_mxn_minor bigint NOT NULL CHECK (deductions_mxn_minor BETWEEN 0 AND 9007199254740991),
    other_payments_mxn_minor bigint NOT NULL CHECK (other_payments_mxn_minor BETWEEN 0 AND 9007199254740991),
    employer_name text, pay_period_start date, pay_period_end date, ingested_at timestamptz NOT NULL,
    evidence_bucket text NOT NULL CHECK (length(evidence_bucket)>0), evidence_key text NOT NULL CHECK (length(evidence_key)>0),
    evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    evidence_content_type text NOT NULL CHECK (length(evidence_content_type)>0))`,
  `CREATE TABLE IF NOT EXISTS olbia.payslip_lines (
    payslip_uuid uuid NOT NULL CONSTRAINT payslip_lines_receipt_fk REFERENCES olbia.payslips(uuid),
    position integer NOT NULL CHECK (position BETWEEN 0 AND 2997),
    sat_kind text NOT NULL CHECK (sat_kind IN ('percepcion','deduccion','otro_pago')),
    sat_type text NOT NULL CHECK (length(sat_type)>0), code text NOT NULL, concept text NOT NULL,
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (payslip_uuid,position))`,
  `CREATE TABLE IF NOT EXISTS olbia.bank_imports (
    kind text NOT NULL CHECK (kind IN ('amex_statement','santander_statement','santander_csv')),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    owner text NOT NULL CHECK (length(owner)>0),
    status text NOT NULL CHECK (status IN ('processing','previewed','applied','failed')),
    created_at timestamptz NOT NULL, previewed_at timestamptz, applied_at timestamptz,
    account_last_four text CHECK (account_last_four ~ '^[0-9]{4}$'), product text,
    period_start date, period_end date,
    evidence_bucket text NOT NULL CHECK (length(evidence_bucket)>0),
    evidence_key text NOT NULL CHECK (length(evidence_key)>0),
    evidence_content_type text NOT NULL CHECK (length(evidence_content_type)>0),
    textract_job_id text CHECK (length(textract_job_id)>0), extraction_key text CHECK (length(extraction_key)>0),
    textract_answers jsonb CHECK (jsonb_typeof(textract_answers)='object'),
    error_message text,
    result_created integer CHECK (result_created>=0), result_linked integer CHECK (result_linked>=0),
    result_skipped integer CHECK (result_skipped>=0), result_msi_confirmed integer CHECK (result_msi_confirmed>=0),
    result_created_unplanned integer CHECK (result_created_unplanned>=0),
    PRIMARY KEY (kind,content_sha256),
    CHECK ((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_start<=period_end)),
    CHECK (status NOT IN ('previewed','applied') OR (account_last_four IS NOT NULL AND (kind='santander_csv' OR (product IS NOT NULL AND period_start IS NOT NULL)))),
    CHECK (status<>'processing' OR (kind<>'santander_csv' AND textract_job_id IS NOT NULL)),
    CHECK (status<>'applied' OR (applied_at IS NOT NULL AND result_created IS NOT NULL AND result_linked IS NOT NULL AND result_skipped IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS olbia.bank_import_rows (
    kind text NOT NULL, content_sha256 text NOT NULL,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 2997),
    identity text NOT NULL CHECK (length(identity)>0),
    occurred_on date NOT NULL, merchant_raw text NOT NULL CHECK (length(merchant_raw)>0),
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor BETWEEN -9007199254740991 AND 9007199254740991),
    status text NOT NULL CHECK (status IN ('new','matched','ambiguous','duplicate','excluded','needs_decision','skipped')),
    row_kind text CHECK (row_kind IN ('purchase','msi')), is_credit boolean,
    installment_index integer CHECK (installment_index BETWEEN 1 AND 48),
    installment_months integer CHECK (installment_months BETWEEN 1 AND 48),
    original_amount_mxn_minor bigint CHECK (original_amount_mxn_minor BETWEEN 1 AND 9007199254740991),
    row_number integer CHECK (row_number>0), occurrence integer CHECK (occurrence>0), bank_transaction_id text,
    selected_movement_id text CHECK (length(selected_movement_id)>0),
    PRIMARY KEY (kind,content_sha256,position),
    CONSTRAINT bank_import_rows_identity_key UNIQUE (kind,content_sha256,identity),
    CONSTRAINT bank_import_rows_import_fk FOREIGN KEY (kind,content_sha256) REFERENCES olbia.bank_imports(kind,content_sha256),
    CHECK (kind='santander_csv' OR row_kind IS NOT NULL),
    CHECK (installment_index IS NULL OR installment_months IS NULL OR installment_index<=installment_months))`,
  `CREATE TABLE IF NOT EXISTS olbia.bank_import_candidates (
    kind text NOT NULL, content_sha256 text NOT NULL, row_position integer NOT NULL,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 2997),
    movement_id text NOT NULL CHECK (length(movement_id)>0),
    merchant_raw text, occurred_at timestamptz,
    PRIMARY KEY (kind,content_sha256,row_position,position),
    CONSTRAINT bank_import_candidates_movement_key UNIQUE (kind,content_sha256,row_position,movement_id),
    CONSTRAINT bank_import_candidates_row_fk FOREIGN KEY (kind,content_sha256,row_position) REFERENCES olbia.bank_import_rows(kind,content_sha256,position),
    CHECK (merchant_raw IS NOT NULL OR occurred_at IS NULL))`,
  ...NATIVE_LEDGER_SCHEMA_STATEMENTS,
  `CREATE OR REPLACE VIEW olbia.movement_months AS
    SELECT id::text AS movement_id,
      to_char(COALESCE(occurred_at,received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM') AS month
      FROM olbia.ledger_movements
    UNION SELECT movement_id::text,month FROM olbia.installment_entries`,
  ...NATIVE_WEALTH_SCHEMA_STATEMENTS,
  NATIVE_PUSH_SCHEMA_STATEMENT,
  ...NATIVE_DELIVERY_SCHEMA_STATEMENTS,
  ...NATIVE_THREAD_SCHEMA_STATEMENTS,
  ...NATIVE_EXCEPTION_SCHEMA_STATEMENTS,
];

export const bootstrapSchema = async (client: SqlClient, roleArns: readonly string[], options: {
  transactionPool?: TransactionPool; now?: () => number; pause?: (ms: number) => Promise<void>; indexWaitMs?: number; readerRoleArns?: readonly string[]; operationalVerifierRoleArns?: readonly string[]; applicationRoleArns?: readonly string[]; storeReaderRoleArns?: readonly string[]; cutoverRoleArns?: readonly string[];
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
  if (!(await query('native-baseline', 'SELECT version FROM olbia.schema_migrations WHERE version=20')).rows.length) throw new BootstrapFailure('native-baseline');
  for (const [index, statement] of SCHEMA_STATEMENTS.entries()) await query(`schema-statement-${index + 1}`, statement);
  await ensureNativeControlConstraints({ query: (statement, params) => query('native-control', statement, params) }, { now, pause, waitMs: options.indexWaitMs });
  await ensureLedgerPrimaryObservation({ query: (statement, params) => query('ledger-primary', statement, params) }, { now, pause, waitMs: options.indexWaitMs });
  for (const [name, table, columns] of [
    ['payslips_paid_on_idx', 'payslips', 'paid_on,uuid'],
    ['ledger_revisions_movement_idx', 'ledger_revisions', 'movement_id,created_at,id'],
    ['installment_entries_month_idx', 'installment_entries', 'month,movement_id'],
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
  await query('read-grant', 'GRANT SELECT ON olbia.schema_migrations,olbia.movement_months,olbia.runtime_state TO olbia_projector');
  await query('catalog-projector-read', 'GRANT SELECT ON olbia.spend_categories TO olbia_projector');
  await query('plans-projector-read', 'GRANT SELECT ON olbia.month_plans,olbia.planned_payments TO olbia_projector');
  await query('payroll-projector-read', 'GRANT SELECT ON olbia.payslips,olbia.payslip_lines TO olbia_projector');
  await query('imports-projector-read', 'GRANT SELECT ON olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates TO olbia_projector');
  await query('cards-projector-read', 'GRANT SELECT ON olbia.card_profiles TO olbia_projector');
  await query('rules-projector-read', 'GRANT SELECT ON olbia.merchant_rules TO olbia_projector');
  await query('ledger-projector-read', nativeLedgerReadGrant('olbia_projector'));
  await query('wealth-projector-read', nativeWealthReadGrant('olbia_projector'));
  await query('exceptions-projector-read',nativeExceptionReadGrant('olbia_projector'));
  await query('threads-projector-read', nativeThreadReadGrant('olbia_projector'));
  await query('delivery-projector-read', nativeDeliveryReadGrant('olbia_projector'));
  await query('push-projector-read', nativePushReadGrant('olbia_projector'));
  await query('projector-barrier-revoke','REVOKE INSERT,UPDATE,DELETE ON olbia.application_barrier FROM olbia_projector');
  await query('projector-barrier-read','GRANT SELECT ON olbia.application_barrier TO olbia_projector');
  await query('projector-barrier-grant','GRANT UPDATE (generation) ON olbia.application_barrier TO olbia_projector');
  for (const arn of roleArns) {
    if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid runtime role ARN');
    await query('iam-grant', `AWS IAM GRANT olbia_projector TO '${arn}'`);
  }
  if (options.readerRoleArns?.length) {
    const reader = await query('reader-role-lookup', "SELECT rolname FROM pg_roles WHERE rolname='olbia_reader'");
    if (!reader.rows.length) await query('reader-role-create', 'CREATE ROLE olbia_reader WITH LOGIN');
    await query('ledger-reader-read', nativeLedgerReadGrant('olbia_reader'));
    await query('wealth-reader-read', nativeWealthReadGrant('olbia_reader'));
    await query('push-reader-metadata', nativePushMetadataGrant('olbia_reader'));
    await query('reader-schema-grant', 'GRANT USAGE ON SCHEMA olbia TO olbia_reader');
    await query('exceptions-reader-read',nativeExceptionReadGrant('olbia_reader'));
    await query('threads-reader-read', nativeThreadReadGrant('olbia_reader'));
    await query('reader-migration-read', 'GRANT SELECT ON olbia.schema_migrations TO olbia_reader');
    await query('catalog-reader-read', 'GRANT SELECT ON olbia.spend_categories TO olbia_reader');
    await query('plans-reader-read', 'GRANT SELECT ON olbia.month_plans,olbia.planned_payments TO olbia_reader');
    await query('payroll-reader-read', 'GRANT SELECT ON olbia.payslips,olbia.payslip_lines TO olbia_reader');
    await query('imports-reader-read', 'GRANT SELECT ON olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates TO olbia_reader');
    await query('cards-reader-read', 'GRANT SELECT ON olbia.card_profiles TO olbia_reader');
    await query('rules-reader-read', 'GRANT SELECT ON olbia.merchant_rules TO olbia_reader');
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
    await query('ledger-verifier-read', nativeLedgerReadGrant(role));
    await query('wealth-verifier-read', nativeWealthReadGrant(role));
    await query('exceptions-verifier-read',nativeExceptionReadGrant(role));
    await query('threads-verifier-read', nativeThreadReadGrant(role));
    await query('delivery-verifier-read', nativeDeliveryReadGrant(role));
    await query('push-verifier-read', nativePushReadGrant(role));
    await query('verification-snapshot-read', `GRANT SELECT ON ${['runtime_state','schema_migrations',
      'spend_categories','merchant_rules','card_profiles','month_plans','planned_payments','payslips','payslip_lines'].map(table => `olbia.${table}`).join(',')} TO ${role}`);
    await query('imports-verifier-select', `GRANT SELECT ON olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates,olbia.schema_migrations TO ${role}`);
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
    await query(`select-${role}`,`GRANT SELECT ON olbia.runtime_state,olbia.schema_migrations TO ${role}`);
    await query(`ledger-read-${role}`, nativeLedgerReadGrant(role));
    await query(`wealth-read-${role}`, nativeWealthReadGrant(role));
    await query(`exceptions-read-${role}`,nativeExceptionReadGrant(role));
    if(writer)for(const [index,statement] of nativeExceptionWriteGrants(role).entries())await query(`exceptions-write-${role}-${index}`,statement);
    await query(`threads-read-${role}`, nativeThreadReadGrant(role));
    if (writer) for (const [index, statement] of nativeThreadWriteGrants(role).entries()) await query(`threads-write-${role}-${index}`, statement);
    await query(`delivery-read-${role}`, nativeDeliveryReadGrant(role));
    if (writer) await query(`delivery-write-${role}`, nativeDeliveryWriteGrant(role));
    await query(`push-read-${role}`, nativePushReadGrant(role));
    if (writer) for (const [index, statement] of nativePushWriteGrants(role).entries()) await query(`push-write-${role}-${index}`, statement);
    if (writer) for (const [index, statement] of nativeWealthWriteGrants(role).entries()) await query(`wealth-write-${role}-${index}`, statement);
    if (writer) for (const [index, statement] of nativeLedgerWriteGrants(role).entries()) await query(`ledger-write-${role}-${index}`, statement);
    if (writer) {
      await query(`barrier-revoke-${role}`,`REVOKE INSERT,UPDATE,DELETE ON olbia.application_barrier FROM ${role}`);
      await query(`write-${role}`,`GRANT SELECT ON olbia.application_barrier TO ${role}`);
      await query(`barrier-generation-${role}`,`GRANT UPDATE (generation) ON olbia.application_barrier TO ${role}`);
    }
    if (writer) await query(`view-${role}`,`GRANT SELECT ON olbia.movement_months TO ${role}`);
    await query(`catalog-read-${role}`, `GRANT SELECT ON olbia.spend_categories TO ${role}`);
    await query(`plans-read-${role}`, `GRANT SELECT ON olbia.month_plans,olbia.planned_payments TO ${role}`);
    await query(`payroll-read-${role}`, `GRANT SELECT ON olbia.payslips,olbia.payslip_lines TO ${role}`);
    await query(`imports-read-${role}`, `GRANT SELECT ON olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates TO ${role}`);
    if (writer) {
      await query(`imports-header-write-${role}`, `GRANT INSERT,UPDATE ON olbia.bank_imports TO ${role}`);
      await query(`imports-children-write-${role}`, `GRANT INSERT,DELETE ON olbia.bank_import_rows,olbia.bank_import_candidates TO ${role}`);
    }
    if (writer) await query(`payroll-insert-${role}`, `GRANT INSERT ON olbia.payslips,olbia.payslip_lines TO ${role}`);
    if (writer) {
      await query(`plans-write-${role}`, `GRANT INSERT,UPDATE ON olbia.month_plans TO ${role}`);
      await query(`payments-write-${role}`, `GRANT INSERT,DELETE ON olbia.planned_payments TO ${role}`);
    }
    await query(`cards-read-${role}`, `GRANT SELECT ON olbia.card_profiles TO ${role}`);
    if (writer) await query(`cards-write-${role}`, `GRANT INSERT,UPDATE ON olbia.card_profiles TO ${role}`);
    await query(`rules-read-${role}`, `GRANT SELECT ON olbia.merchant_rules TO ${role}`);
    if (writer) await query(`catalog-write-${role}`, `GRANT INSERT,UPDATE ON olbia.spend_categories TO ${role}`);
    if (writer) await query(`rules-write-${role}`, `GRANT INSERT,UPDATE ON olbia.merchant_rules TO ${role}`);
    if (operator) {
      await query(`control-revoke-${role}`,`REVOKE UPDATE ON olbia.runtime_state FROM ${role}`);
      await query(`control-${role}`,`GRANT UPDATE (mode,changed_at) ON olbia.runtime_state TO ${role}`);
    }
    for (const arn of arns) {
      if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid application role ARN');
      await query(`iam-${role}`,`AWS IAM GRANT ${role} TO '${arn}'`);
    }
  }
  // Revoke still-present migration copies during this deployment. After cleanup
  // the empty catalog makes future bootstraps independent of those relations.
  const frozen = (await query('migration-evidence-lookup',
    "SELECT tablename FROM pg_tables WHERE schemaname='olbia' AND tablename=ANY($1::text[]) ORDER BY tablename",
    [[...MIGRATION_EVIDENCE_TABLES]])).rows.map(row => String(row.tablename));
  if (frozen.some(table => !(MIGRATION_EVIDENCE_TABLES as readonly string[]).includes(table))) throw new BootstrapFailure('migration-evidence-scope');
  for (const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_projector','olbia_operational_verifier']) {
    if (frozen.length && (await query(`revoke-lookup-${role}`, 'SELECT rolname FROM pg_roles WHERE rolname=$1', [role])).rows.length)
      await query(`migration-evidence-revoke-${role}`, `REVOKE ALL PRIVILEGES ON ${frozen.map(table => `olbia.${table}`).join(',')} FROM ${role}`);
  }
  await query('native-control-complete','INSERT INTO olbia.schema_migrations VALUES (20,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING');
};

export const nativeLedgerReadGrant = (role: string): string =>
  `GRANT SELECT ON ${[...NATIVE_LEDGER_TABLES,'movement_months'].map(table => `olbia.${table}`).join(',')} TO ${role}`;

/** Original assertions are append-only; only bulk lifecycle columns can change. */
export const nativeLedgerWriteGrants = (role: string): string[] => [
  `GRANT INSERT,UPDATE ON olbia.ledger_movements TO ${role}`,
  `GRANT INSERT ON olbia.ledger_observations,olbia.ledger_observation_warnings,olbia.ledger_revisions,olbia.source_claims,olbia.ledger_bulk_members TO ${role}`,
  `GRANT INSERT,DELETE ON olbia.ledger_movement_warnings,olbia.ledger_tags,olbia.installment_plans,olbia.installment_entries,olbia.installment_evidence_candidates TO ${role}`,
  `GRANT INSERT ON olbia.ledger_bulk_operations TO ${role}`,
  `GRANT UPDATE (status,applied_at,undone_at) ON olbia.ledger_bulk_operations TO ${role}`,
];

/** Native DSQL validates existing rows asynchronously before release succeeds. */
const ensureValidatedConstraint = async (client: SqlClient, table: string, name: string, definition: string, stage: string, options: {
  now?: () => number; pause?: (ms: number) => Promise<void>; waitMs?: number;
} = {}): Promise<void> => {
  const now = options.now ?? Date.now, pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const state = () => client.query('SELECT convalidated FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2', [`olbia.${table}`, name]);
  try {
    let constraint = (await state()).rows[0];
    if (!constraint) {
      await client.query(`ALTER TABLE olbia.${table} ADD CONSTRAINT ${name} ${definition} NOT VALID`);
      constraint = (await state()).rows[0];
    }
    if (constraint?.convalidated !== true) {
      const job = (await client.query(`ALTER TABLE ASYNC olbia.${table} VALIDATE CONSTRAINT ${name}`)).rows[0]?.job_id;
      if (typeof job !== 'string' || !job) throw new BootstrapFailure(`${stage}-job`);
      const deadline = now() + (options.waitMs ?? 180_000);
      for (;;) {
        if ((await state()).rows[0]?.convalidated === true) break;
        const status = (await client.query('SELECT status FROM sys.jobs WHERE job_id=$1', [job])).rows[0]?.status;
        if (status === 'failed') throw new BootstrapFailure(`${stage}-validation`);
        if (now() >= deadline) throw new BootstrapFailure(`${stage}-timeout`);
        await pause(1_000);
      }
    }
  } catch (error) {
    if (error instanceof BootstrapFailure) throw error;
    throw new BootstrapFailure(stage, error);
  }
};

/** Fixed native authority identities and finite states, validated against real rows. */
export const NATIVE_CONTROL_CONSTRAINTS = [
  ['runtime_state','runtime_state_storage_id',"CHECK (id='storage')"],
  ['runtime_state','runtime_state_mode',"CHECK (mode IN ('dynamodb','paused','sql'))"],
  ['application_barrier','application_barrier_storage_id',"CHECK (id='storage')"],
  ['application_barrier','application_barrier_generation','CHECK (generation>=0)'],
  ['schema_migrations','schema_migrations_positive_version','CHECK (version>0)'],
] as const;

export const ensureNativeControlConstraints = async (client: SqlClient, options: Parameters<typeof ensureValidatedConstraint>[5] = {}): Promise<void> => {
  for (const [table,name,definition] of NATIVE_CONTROL_CONSTRAINTS) {
    await ensureValidatedConstraint(client,table,name,definition,`native-control-${name}`,options);
  }
};

export const ensureLedgerPrimaryObservation = (client: SqlClient, options: Parameters<typeof ensureValidatedConstraint>[5] = {}): Promise<void> =>
  ensureValidatedConstraint(client, 'ledger_movements', 'ledger_movements_primary_observation_fk',
    LEDGER_PRIMARY_OBSERVATION_CONSTRAINT, 'ledger-primary', options);
