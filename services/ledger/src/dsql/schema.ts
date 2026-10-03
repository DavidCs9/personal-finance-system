import { NATIVE_EXCEPTION_SCHEMA_STATEMENTS,nativeExceptionReadGrant,nativeExceptionWriteGrants } from './exception-schema.js';
import { migrateIngestionReview,type OriginalEmailReader } from './exception-copy.js';
import { NATIVE_THREAD_SCHEMA_STATEMENTS, nativeThreadReadGrant, nativeThreadWriteGrants } from './thread-schema.js';
import { migrateConversationMetadata } from './thread-copy.js';
import { NATIVE_DELIVERY_SCHEMA_STATEMENTS, nativeDeliveryReadGrant, nativeDeliveryWriteGrant } from './delivery-schema.js';
import { migrateMonthlyDeliveries } from './delivery-copy.js';
import { NATIVE_PUSH_SCHEMA_STATEMENT, nativePushReadGrant, nativePushMetadataGrant, nativePushWriteGrants } from './push-schema.js';
import { migratePushSubscriptions } from './push-copy.js';
import { TABLE_COLUMNS, TABLE_NAMES, OPERATIONAL_TABLE_NAMES } from './model.js';
import type { SqlClient, TransactionPool } from './projection.js';
import { isOCCError } from '@aws/aurora-dsql-node-postgres-connector';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from './ledger-schema.js';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS, nativeWealthReadGrant, nativeWealthWriteGrants } from './wealth-schema.js';
import { migrateWealth } from './wealth-copy.js';
import { migrateLedger } from './ledger-copy.js';

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
  // Version 7: native merchant rules. NULL is no assignment, never a fake category.
  `CREATE TABLE IF NOT EXISTS olbia.merchant_rules (
    merchant_key text PRIMARY KEY CHECK (merchant_key ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
    id text NOT NULL CHECK (length(id) > 0), pattern text,
    category_id text CONSTRAINT merchant_rules_category_fk REFERENCES olbia.spend_categories(id),
    source text NOT NULL CHECK (source IN ('seed','human','llm_residual','agent_confirmed')),
    updated_at timestamptz NOT NULL)`,
  `INSERT INTO olbia.merchant_rules (merchant_key,id,pattern,category_id,source,updated_at)
    SELECT merchant_key,id,NULLIF(payload->>'pattern',''),NULLIF(category_id,''),payload->>'source',(payload->>'updatedAt')::timestamptz
    FROM olbia.merchant_category_rules WHERE NOT EXISTS (SELECT 1 FROM olbia.schema_migrations WHERE version=7)
    ON CONFLICT (merchant_key) DO NOTHING`,
  `INSERT INTO olbia.schema_migrations VALUES (7,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING`,
  // Version 9 copy/marker runs atomically under the application barrier below.
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
  transactionPool?: TransactionPool; readOriginalEmail?: OriginalEmailReader; now?: () => number; pause?: (ms: number) => Promise<void>; indexWaitMs?: number; readerRoleArns?: readonly string[]; operationalVerifierRoleArns?: readonly string[]; applicationRoleArns?: readonly string[]; storeReaderRoleArns?: readonly string[]; cutoverRoleArns?: readonly string[];
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
  if (!options.transactionPool) throw new BootstrapFailure('card-copy-transaction-pool');
  await migrateCardProfiles(options.transactionPool);
  await migrateMonthPlans(options.transactionPool);
  await migratePayroll(options.transactionPool);
  await migrateBankImports(options.transactionPool);
  await ensureCardLiabilityRelationships({ query: (statement, params) => query('card-relationships', statement, params) }, { now, pause, waitMs: options.indexWaitMs });
  await ensureMovementCategoryForeignKey({ query: (statement, params) => query('category-fk', statement, params) }, { now, pause, waitMs: options.indexWaitMs });
  await ensureLedgerPrimaryObservation({ query: (statement, params) => query('ledger-primary', statement, params) }, { now, pause, waitMs: options.indexWaitMs });
  for (const [name, table, columns] of [
    ['movements_month_idx', 'movements', 'spend_month,id'],
    ['installments_month_idx', 'msi_installments', 'month,movement_id'],
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
  await query('tables-grant', `GRANT SELECT ON ${['projection_state', ...TABLE_NAMES].map((table) => `olbia.${table}`).join(',')} TO olbia_projector`);
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
  await query('exceptions-projector-recovery-revoke','REVOKE INSERT,UPDATE,DELETE ON olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries FROM olbia_projector');
  await query('threads-projector-read', nativeThreadReadGrant('olbia_projector'));
  await query('threads-projector-recovery-revoke', 'REVOKE INSERT,UPDATE,DELETE ON olbia.assistant_threads FROM olbia_projector');
  await query('delivery-projector-read', nativeDeliveryReadGrant('olbia_projector'));
  await query('delivery-projector-recovery-revoke', 'REVOKE INSERT,UPDATE,DELETE ON olbia.delivery_records FROM olbia_projector');
  await query('push-projector-read', nativePushReadGrant('olbia_projector'));
  await query('push-projector-recovery-revoke', 'REVOKE INSERT,UPDATE,DELETE ON olbia.push_subscriptions FROM olbia_projector');
  await query('wealth-projector-recovery-revoke', 'REVOKE INSERT,UPDATE,DELETE ON olbia.wealth_snapshots,olbia.wealth_versions,olbia.liability_snapshots,olbia.liability_versions FROM olbia_projector');
  await query('projector-barrier-grant','GRANT SELECT,UPDATE ON olbia.application_barrier TO olbia_projector');
  for (const arn of roleArns) {
    if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid runtime role ARN');
    await query('iam-grant', `AWS IAM GRANT olbia_projector TO '${arn}'`);
  }
  if (options.readerRoleArns?.length) {
    const reader = await query('reader-role-lookup', "SELECT rolname FROM pg_roles WHERE rolname='olbia_reader'");
    if (!reader.rows.length) await query('reader-role-create', 'CREATE ROLE olbia_reader WITH LOGIN');
    await query('ledger-reader-read', nativeLedgerReadGrant('olbia_reader'));
    await query('wealth-reader-read', nativeWealthReadGrant('olbia_reader'));
    await query('delivery-reader-recovery-revoke', 'REVOKE SELECT ON olbia.delivery_records FROM olbia_reader');
    await query('push-reader-metadata', nativePushMetadataGrant('olbia_reader'));
    await query('push-reader-recovery-revoke', 'REVOKE SELECT ON olbia.push_subscriptions FROM olbia_reader');
    await query('reader-schema-grant', 'GRANT USAGE ON SCHEMA olbia TO olbia_reader');
    await query('wealth-reader-recovery-revoke', 'REVOKE SELECT ON olbia.wealth_snapshots,olbia.wealth_versions,olbia.liability_snapshots,olbia.liability_versions FROM olbia_reader');
    await query('exceptions-reader-read',nativeExceptionReadGrant('olbia_reader'));
    await query('exceptions-reader-recovery-revoke','REVOKE ALL PRIVILEGES ON olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries FROM olbia_reader');
    await query('threads-reader-read', nativeThreadReadGrant('olbia_reader'));
    await query('threads-reader-recovery-revoke', 'REVOKE ALL PRIVILEGES ON olbia.assistant_threads FROM olbia_reader');
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
    await query('verification-snapshot-read', `GRANT SELECT ON ${['runtime_state','projection_state','schema_migrations',...TABLE_NAMES,
      'spend_categories','merchant_rules','card_profiles','month_plans','planned_payments','payslips','payslip_lines'].map(table => `olbia.${table}`).join(',')} TO ${role}`);
    await query('operational-verifier-select', `GRANT SELECT ON ${OPERATIONAL_TABLE_NAMES.map(table => `olbia.${table}`).join(',')} TO ${role}`);
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
      await query(`barrier-revoke-${role}`,`REVOKE INSERT,DELETE ON olbia.application_barrier FROM ${role}`);
      await query(`write-${role}`,`GRANT SELECT,UPDATE ON olbia.application_barrier TO ${role}`);
    }
    await query(`exceptions-recovery-revoke-${role}`,`REVOKE ALL PRIVILEGES ON olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries FROM ${role}`);
    await query(`threads-recovery-revoke-${role}`, `REVOKE ALL PRIVILEGES ON olbia.assistant_threads FROM ${role}`);
    await query(`delivery-recovery-revoke-${role}`, `REVOKE ALL PRIVILEGES ON olbia.delivery_records FROM ${role}`);
    await query(`push-recovery-revoke-${role}`, `REVOKE ALL PRIVILEGES ON olbia.push_subscriptions FROM ${role}`);
    await query(`wealth-recovery-revoke-${role}`, `REVOKE ALL PRIVILEGES ON olbia.wealth_snapshots,olbia.wealth_versions,olbia.liability_snapshots,olbia.liability_versions FROM ${role}`);
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
    if (operator) await query(`control-${role}`,`GRANT UPDATE ON olbia.runtime_state TO ${role}`);
    for (const arn of arns) {
      if (!/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error('Invalid application role ARN');
      await query(`iam-${role}`,`AWS IAM GRANT ${role} TO '${arn}'`);
    }
  }
  // All product domains are native. Originals remain isolated, immutable recovery evidence.
  const recoveryTables=['projection_state','command_receipts',...TABLE_NAMES].map(t=>`olbia.${t}`).join(',');
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader']) {
    const configured=role==='olbia_application'?options.applicationRoleArns:role==='olbia_cutover'?options.cutoverRoleArns:role==='olbia_reader'?options.readerRoleArns:options.storeReaderRoleArns;
    if(configured?.length)await query(`recovery-product-revoke-${role}`,`REVOKE ALL PRIVILEGES ON ${recoveryTables} FROM ${role}`);
  }
  for(const role of ['olbia_projector',...(options.operationalVerifierRoleArns?.length?['olbia_operational_verifier']:[])]) {
    await query(`recovery-write-revoke-${role}`,`REVOKE INSERT,UPDATE,DELETE ON ${recoveryTables} FROM ${role}`);
    await query(`recovery-read-${role}`,`GRANT SELECT ON ${recoveryTables} TO ${role}`);
  }
  // Activation is last: constraints, indexes and permissions precede atomic ledger/wealth copies.
  try { await migrateLedger(options.transactionPool); }
  catch (error) { throw new BootstrapFailure('ledger-copy', error); }
  try { await migrateWealth(options.transactionPool); }
  catch (error) { throw new BootstrapFailure('wealth-copy', error); }
  try { await migratePushSubscriptions(options.transactionPool); }
  catch (error) { throw new BootstrapFailure('push-copy', error); }
  try { await migrateMonthlyDeliveries(options.transactionPool); }
  catch (error) { throw new BootstrapFailure('delivery-copy', error); }
  try { await migrateConversationMetadata(options.transactionPool); }
  catch (error) { throw new BootstrapFailure('thread-copy', error); }
  try { await migrateIngestionReview(options.transactionPool,options.readOriginalEmail??(async()=>{throw new Error('Original email reader is required');})); }
  catch(error){throw new BootstrapFailure('exception-copy',error);}
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

/** DML copy + marker share the same OCC dependency as every legacy card writer. */
export const migrateCardProfiles = async (pool: TransactionPool): Promise<void> => {
  try {
    await pool.transaction(async client => {
      await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
      if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=9')).rows.length) return;
      await client.query(`INSERT INTO olbia.card_profiles
        (id,owner,name,cut_off_day,payment_due_day,institution,created_at,updated_at)
        SELECT id,owner,name,cut_off_day,payment_due_day,payload->>'institution',
          (source_item->>'createdAt')::timestamptz,(source_item->>'updatedAt')::timestamptz FROM olbia.cards`);
      await client.query('INSERT INTO olbia.schema_migrations VALUES (9,CURRENT_TIMESTAMP)');
    });
  } catch (error) { throw new BootstrapFailure('card-copy', error); }
};

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

export const ensureLedgerPrimaryObservation = (client: SqlClient, options: Parameters<typeof ensureValidatedConstraint>[5] = {}): Promise<void> =>
  ensureValidatedConstraint(client, 'ledger_movements', 'ledger_movements_primary_observation_fk',
    LEDGER_PRIMARY_OBSERVATION_CONSTRAINT, 'ledger-primary', options);

export const ensureMovementCategoryForeignKey = async (client: SqlClient, options: Parameters<typeof ensureValidatedConstraint>[5] = {}): Promise<void> => {
  await ensureValidatedConstraint(client, 'movements', 'movements_category_fk',
    'FOREIGN KEY (category_id) REFERENCES olbia.spend_categories(id)', 'category-fk', options);
  await client.query('INSERT INTO olbia.schema_migrations VALUES (8,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING');
};

export const ensureCardLiabilityRelationships = async (client: SqlClient, options: Parameters<typeof ensureValidatedConstraint>[5] = {}): Promise<void> => {
  for (const table of ['liability_snapshots', 'liability_versions']) {
    await ensureValidatedConstraint(client, table, `${table}_card_required`, 'CHECK (card_id IS NOT NULL)', 'card-required', options);
    await ensureValidatedConstraint(client, table, `${table}_card_fk`, 'FOREIGN KEY (card_id) REFERENCES olbia.card_profiles(id)', 'card-fk', options);
  }
  await client.query('INSERT INTO olbia.schema_migrations VALUES (10,CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING');
};

/** Preserve empty parents; all native parents, ordered children and marker commit together. */
export const migrateMonthPlans = async (pool: TransactionPool): Promise<void> => {
  try {
    await pool.transaction(async client => {
      await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
      if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=11')).rows.length) return;
      if ((await client.query("SELECT month FROM olbia.monthly_plans WHERE jsonb_typeof(payload->'upcomingPayments') IS DISTINCT FROM 'array' LIMIT 1")).rows.length) {
        throw new Error('Invalid retained payment list');
      }
      await client.query(`INSERT INTO olbia.month_plans (month,owner,updated_at)
        SELECT month,owner,(payload->>'updatedAt')::timestamptz FROM olbia.monthly_plans`);
      await client.query(`INSERT INTO olbia.planned_payments (month,id,name,amount_mxn_minor,due_day,sort_order)
        SELECT plan.month,payment.item->>'id',payment.item->>'name',(payment.item->>'amountMinor')::bigint,
          (payment.item->>'dueDay')::integer,(payment.position-1)::integer
        FROM olbia.monthly_plans plan CROSS JOIN LATERAL jsonb_array_elements(plan.payload->'upcomingPayments')
          WITH ORDINALITY AS payment(item,position)`);
      await client.query('INSERT INTO olbia.schema_migrations VALUES (11,CURRENT_TIMESTAMP)');
    });
  } catch (error) { throw new BootstrapFailure('month-plan-copy', error); }
};

/** Immutable CFDI UUID identity replaces the separate live document claim. */
export const migratePayroll = async (pool: TransactionPool): Promise<void> => {
  try {
    await pool.transaction(async client => {
      await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
      if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=12')).rows.length) return;
      const malformed = await client.query(`SELECT uuid FROM olbia.payroll WHERE
        jsonb_typeof(payload->'lines') IS DISTINCT FROM 'array' OR source->>'kind' IS DISTINCT FROM 'cfdi_nomina' LIMIT 1`);
      if (malformed.rows.length) throw new Error('Invalid retained payroll evidence');
      const claims = await client.query(`SELECT receipt.uuid FROM olbia.payroll receipt LEFT JOIN olbia.dedupe_claims claim
        ON claim.source_pk='DEDUPE#CFDI_NOMINA#'||receipt.uuid AND claim.source_sk='CLAIM' WHERE claim.source_pk IS NULL
        UNION ALL SELECT claim.source_pk FROM olbia.dedupe_claims claim LEFT JOIN olbia.payroll receipt
        ON receipt.uuid=claim.source_item->>'uuid' WHERE claim.source_pk LIKE 'DEDUPE#CFDI_NOMINA#%' AND receipt.uuid IS NULL`);
      if (claims.rows.length) throw new Error('Retained CFDI claim membership differs');
      const count = Number((await client.query(`SELECT count(*)+COALESCE(sum(jsonb_array_length(payload->'lines')),0)+2 AS count FROM olbia.payroll`)).rows[0]?.count);
      if (!Number.isSafeInteger(count) || count > 3000) throw new Error('Payroll copy exceeds native transaction budget');
      const classification = await client.query(`SELECT receipt.uuid FROM olbia.payroll receipt CROSS JOIN LATERAL
        jsonb_array_elements(receipt.payload->'lines') AS line(item) WHERE
        line.item->>'group' IS DISTINCT FROM CASE
          WHEN (line.item->>'kind'='deduccion' AND line.item->>'tipo'='004') OR
            (line.item->>'kind'='percepcion' AND line.item->>'tipo'='005') THEN 'fondo'
          WHEN line.item->>'kind'='deduccion' AND line.item->>'tipo'='002' THEN 'isr'
          WHEN line.item->>'kind'='deduccion' AND line.item->>'tipo'='001' THEN 'imss' ELSE 'otro' END
        OR line.item->'notCashInBank' IS DISTINCT FROM CASE WHEN line.item->>'kind'='percepcion' AND line.item->>'tipo'='005'
          THEN 'true'::jsonb ELSE NULL::jsonb END LIMIT 1`);
      if (classification.rows.length) throw new Error('Retained payroll classification differs');
      await client.query(`INSERT INTO olbia.payslips (uuid,owner,paid_on,payroll_type,total_mxn_minor,perceptions_mxn_minor,
        deductions_mxn_minor,other_payments_mxn_minor,employer_name,pay_period_start,pay_period_end,ingested_at,
        evidence_bucket,evidence_key,evidence_sha256,evidence_content_type)
        SELECT uuid::uuid,owner,fecha_pago,payload->>'tipoNomina',(payload->>'totalMinor')::bigint,
          (payload->>'totalPercepcionesMinor')::bigint,(payload->>'totalDeduccionesMinor')::bigint,
          (payload->>'totalOtrosPagosMinor')::bigint,payload->>'employerName',(payload->>'fechaInicialPago')::date,
          (payload->>'fechaFinalPago')::date,ingested_at,source->>'bucket',source->>'key',source->>'sha256',source->>'contentType'
        FROM olbia.payroll`);
      await client.query(`INSERT INTO olbia.payslip_lines (payslip_uuid,position,sat_kind,sat_type,code,concept,amount_mxn_minor)
        SELECT receipt.uuid::uuid,(line.position-1)::integer,line.item->>'kind',line.item->>'tipo',
          line.item->>'clave',line.item->>'concepto',(line.item->>'amountMinor')::bigint FROM olbia.payroll receipt
        CROSS JOIN LATERAL jsonb_array_elements(receipt.payload->'lines') WITH ORDINALITY AS line(item,position)`);
      await client.query('INSERT INTO olbia.schema_migrations VALUES (12,CURRENT_TIMESTAMP)');
    });
  } catch (error) { throw new BootstrapFailure('payroll-copy',error); }
};

/** One-time decoding of retained evidence; no native import writes use document keys. */
export const migrateBankImports = async (pool: TransactionPool): Promise<void> => {
  try {
    await pool.transaction(async client => {
      await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
      if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows.length) return;
      const retained=(await client.query('SELECT source_item FROM olbia.import_records')).rows;
      const object=(value:unknown,keys:readonly string[]):Record<string,any> => {
        if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)))
          throw new Error('Unrepresentable retained import evidence');
        return value as Record<string,any>;
      };
      const strings=(item:Record<string,any>,keys:readonly string[],required=false) => {
        if(keys.some(k=>(required || Object.hasOwn(item,k)) && typeof item[k]!=='string'))throw new Error('Invalid retained import text');
      };
      const integers=(item:Record<string,any>,keys:readonly string[],required=false) => {
        if(keys.some(k=>(required || Object.hasOwn(item,k)) && !Number.isSafeInteger(item[k])))throw new Error('Invalid retained import integer');
      };
      let count=retained.length+2;
      for(const stored of retained){
        const item=object(stored.source_item,['PK','SK','owner','entityType','status','createdAt','previewedAt','appliedAt','accountLastFour',
          'product','period','source','textractJobId','extractionKey','textractAnswers','errorMessage','result','rows','importId']);
        strings(item,['PK','SK','owner','entityType','status'],true);
        strings(item,['createdAt','previewedAt','appliedAt','accountLastFour','product','textractJobId','extractionKey','errorMessage','importId']);
        const source=object(item.source,['bucket','key','sha256','contentType']);strings(source,['bucket','key','sha256','contentType'],true);
        const provider=({amex_statement_import:'AMEX',santander_statement_import:'SANTANDER_STATEMENT',santander_csv_import:'SANTANDER'} as Record<string,string>)[item.entityType];
        if(!provider || item.PK!==`USER#${item.owner}` || item.SK!==`IMPORT#${provider}#${source.sha256}` ||
          item.importId!==undefined && item.importId!==source.sha256)throw new Error('Invalid retained import identity');
        if(item.period!==undefined)strings(object(item.period,['from','to']),['from','to'],true);
        if(item.textractAnswers!==undefined && (!item.textractAnswers || typeof item.textractAnswers!=='object' || Array.isArray(item.textractAnswers)))
          throw new Error('Invalid retained extraction answers');
        if(item.result!==undefined)integers(object(item.result,['created','linked','skipped','msiConfirmed','createdUnplanned']),['created','linked','skipped','msiConfirmed','createdUnplanned']);
        const rows=item.rows===undefined && ['processing','failed'].includes(item.status) ? [] : item.rows;
        if(!Array.isArray(rows))throw new Error('Invalid retained import rows');
        count+=rows.length;
        for(const raw of rows){
          const row=object(raw,['identity','occurredOn','merchantRaw','amountMinor','status','kind','msi','credit','installmentIndex',
            'installmentMonths','originalAmountMinor','rowNumber','occurrence','transactionId','eventId','candidateEventIds','candidates']);
          strings(row,['identity','occurredOn','merchantRaw','status'],true);strings(row,['kind','transactionId','eventId']);
          integers(row,['amountMinor'],true);integers(row,['installmentIndex','installmentMonths','originalAmountMinor','rowNumber','occurrence']);
          if(Object.hasOwn(row,'credit') && typeof row.credit!=='boolean' ||
            Object.hasOwn(row,'kind') && row.msi!==(row.kind==='msi') || Object.hasOwn(row,'msi') && !Object.hasOwn(row,'kind'))
            throw new Error('Invalid retained row classification');
          if(!Array.isArray(row.candidateEventIds) || !row.candidateEventIds.every((id:unknown)=>typeof id==='string') || !Array.isArray(row.candidates))
            throw new Error('Invalid retained candidate list');
          count+=row.candidateEventIds.length;
          let prior=-1;
          for(const rawCandidate of row.candidates){
            const candidate=object(rawCandidate,['id','merchantRaw','occurredAt']);strings(candidate,['id','merchantRaw'],true);strings(candidate,['occurredAt']);
            const position=row.candidateEventIds.indexOf(candidate.id);
            if(position<=prior)throw new Error('Invalid retained candidate label order');prior=position;
          }
        }
      }
      if(count>3000)throw new Error('Bank import copy exceeds native transaction budget');
      const kind=`CASE receipt.source_item->>'entityType' WHEN 'amex_statement_import' THEN 'amex_statement'
        WHEN 'santander_statement_import' THEN 'santander_statement' WHEN 'santander_csv_import' THEN 'santander_csv' END`;
      await client.query(`INSERT INTO olbia.bank_imports (kind,content_sha256,owner,status,created_at,previewed_at,applied_at,
        account_last_four,product,period_start,period_end,evidence_bucket,evidence_key,evidence_content_type,
        textract_job_id,extraction_key,textract_answers,error_message,result_created,result_linked,result_skipped,result_msi_confirmed,result_created_unplanned)
        SELECT ${kind},receipt.source_item->'source'->>'sha256',receipt.source_item->>'owner',receipt.source_item->>'status',
          COALESCE(receipt.source_item->>'createdAt',receipt.source_item->>'previewedAt')::timestamptz,
          (receipt.source_item->>'previewedAt')::timestamptz,(receipt.source_item->>'appliedAt')::timestamptz,
          receipt.source_item->>'accountLastFour',receipt.source_item->>'product',
          (receipt.source_item->'period'->>'from')::date,(receipt.source_item->'period'->>'to')::date,
          receipt.source_item->'source'->>'bucket',receipt.source_item->'source'->>'key',receipt.source_item->'source'->>'contentType',
          receipt.source_item->>'textractJobId',receipt.source_item->>'extractionKey',receipt.source_item->'textractAnswers',receipt.source_item->>'errorMessage',
          (receipt.source_item->'result'->>'created')::integer,(receipt.source_item->'result'->>'linked')::integer,
          (receipt.source_item->'result'->>'skipped')::integer,(receipt.source_item->'result'->>'msiConfirmed')::integer,
          (receipt.source_item->'result'->>'createdUnplanned')::integer FROM olbia.import_records receipt`);
      await client.query(`INSERT INTO olbia.bank_import_rows (kind,content_sha256,position,identity,occurred_on,merchant_raw,
        amount_mxn_minor,status,row_kind,is_credit,installment_index,installment_months,original_amount_mxn_minor,row_number,occurrence,bank_transaction_id,selected_movement_id)
        SELECT ${kind},receipt.source_item->'source'->>'sha256',(line.position-1)::integer,line.item->>'identity',
          (line.item->>'occurredOn')::date,line.item->>'merchantRaw',(line.item->>'amountMinor')::bigint,line.item->>'status',
          line.item->>'kind',(line.item->>'credit')::boolean,(line.item->>'installmentIndex')::integer,
          (line.item->>'installmentMonths')::integer,(line.item->>'originalAmountMinor')::bigint,
          (line.item->>'rowNumber')::integer,(line.item->>'occurrence')::integer,line.item->>'transactionId',line.item->>'eventId'
        FROM olbia.import_records receipt CROSS JOIN LATERAL jsonb_array_elements(receipt.source_item->'rows') WITH ORDINALITY AS line(item,position)`);
      await client.query(`INSERT INTO olbia.bank_import_candidates (kind,content_sha256,row_position,position,movement_id,merchant_raw,occurred_at)
        SELECT ${kind},receipt.source_item->'source'->>'sha256',(line.position-1)::integer,(candidate.position-1)::integer,
          candidate.id,label.item->>'merchantRaw',(label.item->>'occurredAt')::timestamptz FROM olbia.import_records receipt
        CROSS JOIN LATERAL jsonb_array_elements(receipt.source_item->'rows') WITH ORDINALITY AS line(item,position)
        CROSS JOIN LATERAL jsonb_array_elements_text(line.item->'candidateEventIds') WITH ORDINALITY AS candidate(id,position)
        LEFT JOIN LATERAL jsonb_array_elements(line.item->'candidates') AS label(item) ON label.item->>'id'=candidate.id`);
      await client.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP)');
    });
  } catch(error){throw new BootstrapFailure('bank-import-copy',error);}
};
