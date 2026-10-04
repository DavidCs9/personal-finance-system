# Current SQL relational table audit — 2026-10-04

**OLBIA MUST FEEL AS IF IT WAS BORN IN SQL. David Castro is its sole owner/user.** Domain facts have native keys, columns, relationships, constraints and SQL transactions. Pre-cutover DynamoDB remains the migration recovery source; DSQL keeps only current domain facts and operational controls. See [the binding north star](product-north-star.md).

The [#207 cleanup](https://github.com/DavidCs9/personal-finance-system/pull/207) is deployed and independently accepted at **2026-10-04T18:05:36.118Z**: 41 base tables, one view, 355 base columns, 297 validated constraints and 64 indexes. Every one of the 4,251 native domain rows and every retained column/constraint/index/view/privilege definition exactly matches the October 4 pre-release snapshot. All 26 frozen migration relations are absent. The [run record](autonomous-runs/2026-10-04-clean-dsql-catalog.md) records reviewed release, real financial/original-object gates, fully rolled-back native writes and recovery checks. Counts are an accepted snapshot, not live counters.

## Architecture acceptance criteria

The active product's SQL-native redesign is implemented, deployed and independently accepted. These are the initial audit's criteria and the evidence supporting that conclusion; they do not certify every historical bank charge or classification.

| Criterion | Verified disposition and evidence |
| --- | --- |
| Domain keys, required fields and native relationships | All 38 native tables use domain PKs; 236 required columns, 20 additional UNIQUE constraints, 36 FKs and 195 CHECKs are validated. Exact live inventory follows below. Nullable original assertions, unresolved suppression and ambiguous provenance retain documented meanings. |
| One relational authority and complete consumer migration | Every product reader/writer uses direct SQL. All domain slices are accepted; shared runtime #200, real fallback access #201 and public boundary #203 finish the product surface. Actual bundle regressions reject the document factory, DynamoDB SDK and obsolete flags; real 17-function/role inspection confirms deployed scope. |
| Exact observations, revisions, payroll and captures | Each domain's independent copy/activation receipt preserves real originals, rejected records, ordered children and supersessions. The October 4 complete comparison preserves all 38 native domain tables and 4,251 rows exactly; migration copies are deliberately removed. Current edits remain distinct from immutable source/history assertions. |
| Financial results and month/currency semantics | Deployed independent SQL financial, provenance, monthly-plan/payroll, wealth/as-of, report and worker gates pass with zero mismatches. Mi parte zero/absence, foreign authorization, spent/committed/cancelled MSI and rejected/deferred exclusions retain their contracts. |
| Transactions, idempotency, rollback and restart | Native connector transactions own OCC/retry; actual domain SQL cases cover atomic children, replay, interrupted writes and import budgets. All eleven deployed native domain smoke checks succeed and fully roll back. Cleanup resumes safely after interruption; bootstrap never recreates retired tables, and migration replay is retired. Provider acceptance outside SQL remains explicitly non-atomic. |
| Original evidence and native recovery | Original-object gates and separate real MIME/PDF/CSV/XML checks pass within their documented scopes. S3 originals, native DSQL backups and retained DynamoDB recovery remain available. Apple Pay inline original metadata follows its actual contract. All 26 frozen SQL migration relations are absent; current verification has no dependency on them. |
| Real query plans and proportional indexes | Deployed EXPLAIN ANALYZE checks exercise financial, planning, payroll, wealth/history, category/rule/card reads. Native month scans use indexes; the #203 snapshot records 49.084 ms execution. Three native secondary indexes plus domain PK/UNIQUE indexes cover current access patterns without a speculative index framework or performance guarantee. |
| Native controls and reviewed delivery | Five native control CHECKs and scoped mutable columns remain validated. Cleanup marker 21 is complete; all 647 retained table privileges and 4,421 column privileges are exact. Every release follows final-head quality, linear merge, deploy-production and independent acceptance; #203 completes the current public/guide boundary. |

The [closeout record](autonomous-runs/2026-10-03-sql-normalization-closeout.md) distinguishes architectural acceptance from any subsequent evidence-backed financial cleanup. Purposeful native financial history JSON remains intentional. The October 4 decision supersedes retention of migration copies inside DSQL.

## Inventory and current authority

**41 base tables / one view / 355 columns / 297 validated constraints / 64 indexes.** These are 38 native domain tables and three current operational controls. The pre-cleanup accepted catalog contained 67 tables, 663 columns, 328 constraints and 92 indexes. All active readers/writers use direct SQL; native roles retain their scoped current access. Frozen migration copies, their columns, constraints and indexes are removed, with no archive schema.


The 38 native tables have **348 columns, 236 NOT NULL columns, 38 primary keys, 20 additional UNIQUE constraints, 36 FKs and 195 CHECKs** (289 constraints). Native domain rows total **4,251**. There are **zero** native source_pk/source_sk/row_id/payload/source_item/index_pk/index_sk columns. Nine JSON columns retain only purposeful history/evidence/provider metadata. SQL integers preserve minor-unit arithmetic and nullable Mi parte, including zero; timestamps retain milliseconds; currency/financial semantics remain unchanged.

The three standalone native indexes cover installment months, movement revision chronology and payroll payment dates. PK/UNIQUE indexes cover actual domain identities; the two historical month indexes leave with their retired tables. No speculative general index catalog or new account/card mapping is introduced.

## Native domain tables

Each row below audits its actual PK, required-column count, CHECK/UNIQUE counts, relationships and JSON purpose. PK INCLUDE columns in DSQL are storage coverage, not additional logical identity. All listed constraints were validated in production; financial keys and original assertions are required according to their domain meaning. C/U denotes additional CHECK/UNIQUE counts, excluding the PK/FKs.

| Table and purpose | Rows | Domain PK | Required / columns; C/U | Actual foreign keys | JSON retained |
| --- | ---: | --- | --- | --- | --- |
| `asset_accounts` — Small personal asset account catalog. | 3 | `(id)` | 6/6; 6/1 | — | — |
| `asset_capture_replacements` — Immutable actual prior/successor capture relationship. | 4 | `(previous_capture_id)` | 4/4; 1/1 | `FOREIGN KEY (account_id, day, replacement_capture_id) REFERENCES olbia.asset_captures(account_id, day, id)`; `FOREIGN KEY (account_id, day, previous_capture_id) REFERENCES olbia.asset_captures(account_id, day, id)` | — |
| `asset_captures` — Immutable asset capture header/source/evidence; total derived from holdings. | 130 | `(id)` | 10/12; 8/1 | `FOREIGN KEY (account_id) REFERENCES olbia.asset_accounts(id)` | — |
| `asset_daily_captures` — One selected capture per actual account/day; scoped pointer update. | 126 | `(account_id, day)` | 3/3; 0/1 | `FOREIGN KEY (account_id, day, capture_id) REFERENCES olbia.asset_captures(account_id, day, id)` | — |
| `asset_holdings` — Ordered immutable holdings and historical values belonging to a capture. | 451 | `(capture_id, "position")` | 9/9; 7/1 | `FOREIGN KEY (capture_id) REFERENCES olbia.asset_captures(id)` | — |
| `assistant_thread_selection` — Single personal active selection with a real thread FK. | 1 | `(id)` | 3/4; 2/0 | `FOREIGN KEY (thread_id, owner) REFERENCES olbia.conversation_threads(id, owner)` | — |
| `bank_import_candidates` — Ordered historical reconciliation candidate assertions; do not join to mutable current values. | 39 | `(kind, content_sha256, row_position, "position")` | 5/7; 3/1 | `FOREIGN KEY (kind, content_sha256, row_position) REFERENCES olbia.bank_import_rows(kind, content_sha256, "position")` | — |
| `bank_import_rows` — Ordered parsed source rows and frozen selection assertions. | 484 | `(kind, content_sha256, "position")` | 8/17; 14/1 | `FOREIGN KEY (kind, content_sha256) REFERENCES olbia.bank_imports(kind, content_sha256)` | — |
| `bank_imports` — Content-addressed source import, provider extraction state and actual application result. | 15 | `(kind, content_sha256)` | 8/23; 20/0 | — | `textract_answers` |
| `card_profiles` — Card profile/cycle dates; tombstones preserve liability history. | 3 | `(id)` | 7/9; 6/0 | — | — |
| `conversation_threads` — Session metadata; native AgentCore owns discovery/transcript. | 35 | `(id)` | 7/7; 4/1 | — | — |
| `ingestion_retry_attempts` — Request-time tuple with optional historically present UUID, failure and completed movement facts. | 3 | `(exception_id, requested_at)` | 3/13; 6/1 | `FOREIGN KEY (exception_id) REFERENCES olbia.ingestion_review_exceptions(id)`; `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)` | — |
| `ingestion_review_claims` — Proven source suppression tuple linked to its exception. | 4 | `(source_token, extractor_version, reason)` | 5/6; 2/0 | `FOREIGN KEY (exception_id, source_token, reason) REFERENCES olbia.ingestion_review_exceptions(id, source_token, reason)` | — |
| `ingestion_review_exceptions` — Immutable original email/error/extraction assertions; bounded discard lifecycle. | 8 | `(id)` | 9/13; 9/1 | — | — |
| `installment_entries` — Ordered schedule/status and typed capture/bank/legacy provenance. | 108 | `(movement_id, installment_index)` | 5/12; 8/1 | `FOREIGN KEY (evidence_import_kind, evidence_content_sha256, evidence_row_position) REFERENCES olbia.bank_import_rows(kind, content_sha256, "position") MATCH FULL`; `FOREIGN KEY (movement_id) REFERENCES olbia.installment_plans(movement_id)` | — |
| `installment_evidence_candidates` — Possible bank-row provenance for genuinely ambiguous retained schedule evidence. | 10 | `(movement_id, installment_index, import_kind, content_sha256, row_position)` | 5/5; 0/0 | `FOREIGN KEY (movement_id, installment_index) REFERENCES olbia.installment_entries(movement_id, installment_index)`; `FOREIGN KEY (import_kind, content_sha256, row_position) REFERENCES olbia.bank_import_rows(kind, content_sha256, "position")` | — |
| `installment_plans` — One installment plan per movement with typed source/financial contract. | 20 | `(movement_id)` | 6/7; 5/0 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)` | — |
| `ledger_bulk_members` — Ordered immutable operation/movement membership and historical values. | 221 | `(operation_id, "position")` | 8/11; 5/1 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)`; `FOREIGN KEY (operation_id) REFERENCES olbia.ledger_bulk_operations(id)` | `previous_tags`, `next_tags` |
| `ledger_bulk_operations` — Immutable command/patch plus bounded apply/undo lifecycle facts. | 43 | `(id)` | 7/9; 6/0 | — | `selection_assertion`, `change_assertion` |
| `ledger_movement_warnings` — Current warning membership; no duplicate authoritative array. | 8 | `(movement_id, "position")` | 3/3; 1/0 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)` | — |
| `ledger_movements` — Current financial decision; original bank assertions remain independent observations. | 504 | `(id)` | 12/31; 9/0 | `FOREIGN KEY (category_id) REFERENCES olbia.spend_categories(id)`; `FOREIGN KEY (id, primary_observation_id) REFERENCES olbia.ledger_observations(movement_id, id) DEFERRABLE INITIALLY DEFERRED` | — |
| `ledger_observation_warnings` — Ordered immutable capture warnings. | 0 | `(observation_id, "position")` | 3/3; 1/0 | `FOREIGN KEY (observation_id) REFERENCES olbia.ledger_observations(id)` | — |
| `ledger_observations` — Append-only capture facts, parser identity and original evidence. | 527 | `(id)` | 14/27; 12/2 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)` | `source_metadata` |
| `ledger_revisions` — Immutable audited changes linked to movement and optional bulk operation. | 420 | `(id)` | 5/8; 2/0 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)`; `FOREIGN KEY (operation_id) REFERENCES olbia.ledger_bulk_operations(id)` | `changes` |
| `ledger_tags` — Current movement/tag membership. | 83 | `(movement_id, "position")` | 3/3; 2/1 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)` | — |
| `liability_capture_replacements` — Immutable debt capture supersession relationship. | 3 | `(previous_capture_id)` | 4/4; 1/1 | `FOREIGN KEY (card_id, day, replacement_capture_id) REFERENCES olbia.liability_captures(card_id, day, id)`; `FOREIGN KEY (card_id, day, previous_capture_id) REFERENCES olbia.liability_captures(card_id, day, id)` | — |
| `liability_captures` — Immutable card-debt capture; zero is a valid paid-off balance. | 25 | `(id)` | 10/10; 7/1 | `FOREIGN KEY (card_id) REFERENCES olbia.card_profiles(id)` | — |
| `liability_daily_captures` — One selected liability capture per card/day. | 22 | `(card_id, day)` | 3/3; 0/1 | `FOREIGN KEY (card_id, day, capture_id) REFERENCES olbia.liability_captures(card_id, day, id)` | — |
| `merchant_rules` — Merchant classification with nullable catalog assignment. | 174 | `(merchant_key)` | 4/6; 3/0 | `FOREIGN KEY (category_id) REFERENCES olbia.spend_categories(id)` | — |
| `month_plans` — Explicit month configuration; empty parent stops inheritance. | 6 | `(month)` | 3/3; 2/0 | — | — |
| `monthly_email_preparations` — Immutable actual prepared content and report/analysis evidence. | 3 | `(delivery_kind, month)` | 8/14; 9/0 | — | `report_facts`, `report_analysis` |
| `monthly_email_receipts` — Append-only real provider receipt linked to preparation; derives sent state. | 3 | `(delivery_kind, month)` | 4/4; 1/0 | `FOREIGN KEY (delivery_kind, month) REFERENCES olbia.monthly_email_preparations(delivery_kind, month)` | — |
| `payslip_lines` — Ordered SAT source lines; immutable historical payroll assertions. | 192 | `(payslip_uuid, "position")` | 7/7; 4/0 | `FOREIGN KEY (payslip_uuid) REFERENCES olbia.payslips(uuid)` | — |
| `payslips` — Immutable CFDI identity, payment date, source totals and XML evidence. | 19 | `(uuid)` | 13/16; 10/0 | — | — |
| `planned_payments` — Ordered configured payments belonging to that month. | 8 | `(month, id)` | 6/6; 5/1 | `FOREIGN KEY (month) REFERENCES olbia.month_plans(month)` | — |
| `source_claims` — Capture-specific idempotency identity and proven outcome/financial links; unresolved historical suppression explicit. | 532 | `(capture_source, token)` | 4/11; 6/0 | `FOREIGN KEY (movement_id) REFERENCES olbia.ledger_movements(id)`; `FOREIGN KEY (movement_id, observation_id) REFERENCES olbia.ledger_observations(movement_id, id)` | — |
| `spend_categories` — Effective category catalog; no permanent defaults overlay. | 13 | `(id)` | 3/3; 2/0 | — | — |
| `web_push_subscriptions` — Native subscription identity, transport keys, privacy preference and lifecycle. | 1 | `(subscription_id)` | 9/9; 6/1 | — | — |

### JSON decisions

`ledger_observations.source_metadata` preserves genuinely source-specific immutable metadata, not current financial fields. `ledger_revisions.changes` preserves before/after assertions. `ledger_bulk_operations.selection_assertion`/`change_assertion` preserve the actual immutable selection/change request, and `ledger_bulk_members.previous_tags`/`next_tags` preserve historical before/after tag assertions rather than joining current membership. `bank_imports.textract_answers` preserves original provider extraction metadata. `monthly_email_preparations.report_facts`/`report_analysis` preserve the actual prepared report/analysis. Current financial fields, operational lifecycle and child collections are relational; none of these JSON facts drives a document-store authority.

### Historical assertions versus current relationships

`bank_import_rows.selected_movement_id` and `bank_import_candidates.movement_id` are frozen historical text assertions, deliberately not current-ledger FKs. In this snapshot all two selected IDs and 39 candidate IDs resolve, but that does not convert historical decisions into current mutable relationships. The imported parent/header/ordered-row relationships are enforced. Captures/revisions/replacement links use actual native identities. Financial repair requires source evidence and an audited domain mutation, not casting text or inventing parents to make a schema pass.

`source_claims` explicitly retains two historical_missing and three unresolved_suppression outcomes; no absent movement/observation is fabricated. Installment provenance retains 19 direct bank-row cases, five ambiguous cases (ten candidate rows), two legacy-backfill cases and 82 entries with no asserted provenance. Rejected financial/schedule history stays present and excluded according to existing financial rules.

## Removed migration relations

The accepted cleanup removed 24 historical domain copies plus `projection_state` and `command_receipts`. None is a fallback or financial authority. DynamoDB remains retained, deletion protected and backed by PITR. The deployed bootstrap, catalog checks and financial verifiers no longer recreate or read these relations. The [explicit retirement allowlist](../services/ledger/src/dsql/catalog.ts) bounds deletion; no native table is discovered as a deletion target by a naming pattern.

## Storage/control relations

The three current controls have seven columns, three PKs and five validated CHECKs. The [completed native control slice](autonomous-runs/2026-10-03-sql-control-invariants.md) validates the five native CHECKs and scopes the existing mutable control columns. Marker 20 is active after reviewed deployment and independent acceptance.

| Table | Rows | Actual identity and meaning | Current gap / disposition |
| --- | ---: | --- | --- |
| `schema_migrations` | 21 | `version`; applied-at required; reviewed bootstrap alone writes facts. | Validated positive-version CHECK; cleanup marker 21 follows successful removal; version history remains normal schema bookkeeping. |
| `runtime_state` | 1 | `id=storage`; persisted authority mode and changed-at required. | Validated identity/finite-mode CHECKs; existing operator UPDATE scoped to mode/changed_at. Preserve reviewed dynamodb/paused/sql modes. |
| `application_barrier` | 1 | `id=storage`; generation required; native OCC ordering dependency. | Validated identity/nonnegative-generation CHECKs; existing application/operator/projector UPDATE scoped to generation. |

`movement_months` is the single view: a direct UNION of current native movement-derived month membership and installment-entry months. It has no stored payload, source checkpoint or independently writable aggregate. Financial read consumers use this SQL relationship.

## Original evidence review and financial boundaries

Six original S3 files were freshly downloaded and SHA-256 verified outside Git. Relevant complete PDF pages were visually reviewed; real CSV/email parsers and actual retained revisions were inspected. The five equal-signature pairs from the initial audit have the following outcomes:

- Three pairs are separate printed bank-statement rows; one pair has distinct CSV bank transaction IDs and row identities. Preserve those source distinctions.
- The remaining pair consists of separate email notices corroborated by two distinct posted CSV transactions. Exact email-to-bank one-to-one identity is unproven and authorization/posted amounts differ. The two CSV-linked financial records are already rejected through immutable status revisions; the two email financial records are accepted. All four records are not counted as accepted spending.
- No confirmed duplicate capture justifies merging/deleting these five pairs. Date-only timestamp/merchant/amount is a comparison signature, never a unique event identity. This review does not claim every historical transaction or bank charge is correct.

The former 15 dangling category assignments were restored through ten audited operations (13 NULL, two prior valid assignments), preserving all earlier revisions and adding 15 category-only revisions. Current native category FKs and gates pass. See [the completed category record](autonomous-runs/2026-10-01-category-integrity.md). Missing historical claim targets and overloaded installment provenance now have explicit native semantics as described above; uncertainty was preserved rather than replaced with fabricated relationships.

## Acceptance and remaining work

[#207](https://github.com/DavidCs9/personal-finance-system/pull/207) passed required quality, linear squash merge, [deploy-production](https://github.com/DavidCs9/personal-finance-system/actions/runs/37222201133) and independent October 4 acceptance. The deployed gate verified 504 movements, 527 observations and 420 revisions, plus all planning/payroll, wealth, import, notification, assistant and review/retry families, with zero mismatches before and after removal. Original S3 checks and both fully rolled-back native write smokes pass.

All 38 domain tables and their 4,251 rows are exact. Current native columns, constraints, indexes, the view and all role privileges are exact. Controls preserve SQL authority and existing version history; marker 21 is added. Ordinary minute-scheduled expiry transactions advance the operational barrier without editing domain facts. No financial repair or deletion occurred. DynamoDB remains ACTIVE/deletion-protected with 35-day PITR; native DSQL backups and original S3 objects remain protected.

Private real data, original-file verification and exact catalog/data acceptance receipts remain outside Git under /Users/decs/.local/share/olbia-normalization/2026-10-04-clean-dsql/. See [the complete run](autonomous-runs/2026-10-04-clean-dsql-catalog.md) for bounds and operational details. Further financial reconciliation requires new source evidence or an explicit financial decision where identity remains unproven. Do not manufacture missing history or reintroduce retired migration tables.
