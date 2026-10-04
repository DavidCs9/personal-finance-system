# Olbia SQL schema

Olbia's current model has **38 financial/application tables and three operational controls**, all in `olbia`. Each domain fact has one relational authority. The October 4 cleanup removed all 26 frozen migration tables and is [deployed and independently accepted](autonomous-runs/2026-10-04-clean-dsql-catalog.md). Retained DynamoDB provides pre-cutover recovery; current DSQL backups protect subsequent finances.

## Where to start

For transactions, start with `ledger_movements`. Its `id` joins observations, revisions, tags and installment plans. For net worth, start with `asset_accounts` and `card_profiles`, then their immutable captures and daily selections. The database keeps original financial observations and audited changes because they explain David's actual finances.

| Area | Tables | Purpose |
| --- | --- | --- |
| Transactions and history (8) | `ledger_movements`, `ledger_observations`, `ledger_movement_warnings`, `ledger_observation_warnings`, `ledger_tags`, `ledger_revisions`, `ledger_bulk_operations`, `ledger_bulk_members` | Current transactions, individual captures, ordered warnings/tags, revisions and auditable bulk changes. |
| Installments and capture identity (4) | `installment_plans`, `installment_entries`, `installment_evidence_candidates`, `source_claims` | Purchase schedules, actual confirmations, ambiguous original bank-row candidates and capture idempotency. |
| Categories and cards (3) | `spend_categories`, `merchant_rules`, `card_profiles` | Classification and David's card settings. |
| Monthly plan and payroll (4) | `month_plans`, `planned_payments`, `payslips`, `payslip_lines` | Configured payments, immutable CFDI receipts and their ordered SAT lines. |
| Bank imports (3) | `bank_imports`, `bank_import_rows`, `bank_import_candidates` | Original import headers, actual bank rows and preview matching candidates. |
| Net worth and debt (8) | `asset_accounts`, `asset_captures`, `asset_holdings`, `asset_daily_captures`, `asset_capture_replacements`, `liability_captures`, `liability_daily_captures`, `liability_capture_replacements` | Immutable asset/debt captures, their holdings, selected daily values and explicit supersessions. |
| Review and retries (3) | `ingestion_review_exceptions`, `ingestion_review_claims`, `ingestion_retry_attempts` | Failed capture review, worker ownership and auditable retries. |
| Notifications (3) | `web_push_subscriptions`, `monthly_email_preparations`, `monthly_email_receipts` | Device registrations, actual prepared reports and provider delivery receipts. |
| Assistant metadata (2) | `conversation_threads`, `assistant_thread_selection` | Conversation titles/expiry and selected thread; AgentCore owns transcripts. |
| Operational controls (3) | `schema_migrations`, `runtime_state`, `application_barrier` | Reviewed schema versions, persisted maintenance/authority mode and transaction ordering. |

`movement_months` is a view over native transactions and installment months. It stores no additional financial copy.

## Financial conventions

Amounts are integer minor units; keep currencies separate. Nullable `personal_amount_minor` preserves Mi parte absence and zero. Instants use `timestamptz`; financial month calculations use America/Chihuahua. Domain keys, typed columns, validated primary/foreign/unique/CHECK constraints and SQL transactions enforce the model.

JSON is limited to immutable audit assertions and variable provider metadata. MIME, XML, PDF, CSV and original capture objects remain in S3. Those source facts support current financial provenance and are distinct from discarded migration copies.

The [table audit](sql-relational-table-audit.md) documents exact keys, relationships and JSON meanings. Authoritative DDL lives in [schema.ts](../services/ledger/src/dsql/schema.ts) and its native domain modules; historical migration definitions exist only as test fixtures. Bootstrap upgrades the already accepted native baseline (version 20); it does not replay DynamoDB or reconstruct a blank financial database. Restore current finances through native DSQL recovery. Production schema changes follow PR, required quality, linear merge and `deploy-production`.
