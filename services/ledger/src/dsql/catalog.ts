import { NATIVE_LEDGER_TABLES } from './ledger-schema.js';
import { NATIVE_WEALTH_TABLES } from './wealth-schema.js';
import { NATIVE_THREAD_TABLES } from './thread-schema.js';

/** Current personal-finance model. Controls are operational facts, not migration copies. */
export const NATIVE_DOMAIN_TABLES = [
  ...NATIVE_LEDGER_TABLES, ...NATIVE_WEALTH_TABLES, ...NATIVE_THREAD_TABLES,
  'spend_categories', 'merchant_rules', 'card_profiles', 'month_plans', 'planned_payments',
  'payslips', 'payslip_lines', 'bank_imports', 'bank_import_rows', 'bank_import_candidates',
  'web_push_subscriptions', 'monthly_email_preparations', 'monthly_email_receipts',
  'ingestion_review_exceptions', 'ingestion_review_claims', 'ingestion_retry_attempts',
] as const;
export const SQL_CONTROL_TABLES = ['schema_migrations', 'runtime_state', 'application_barrier'] as const;
export const CURRENT_SQL_TABLES = [...NATIVE_DOMAIN_TABLES, ...SQL_CONTROL_TABLES] as const;

/** Explicitly authorized retirement list; never discover deletion targets by pattern. */
export const MIGRATION_EVIDENCE_TABLES = [
  'movements', 'movement_observations', 'movement_revisions', 'categories', 'merchant_category_rules',
  'cards', 'movement_tags', 'msi_plans', 'msi_installments', 'monthly_plans', 'payroll',
  'wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions',
  'dedupe_claims', 'exception_claims', 'ingestion_exceptions', 'ingestion_retries', 'import_records',
  'bulk_edit_operations', 'delivery_records', 'push_subscriptions', 'assistant_threads',
  'projection_state', 'command_receipts',
] as const;
