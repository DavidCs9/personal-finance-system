# DSQL remaining domain reads

This phase completes read-only category/rule, standalone card/cycle and worker/assistant movement consumers. Shadow deployed in PR #161 and independent production parity passed; this separate promotion selects guarded SQL after freshness equality. DynamoDB remains every domain write authority and the strong freshness reference. Schema/transformer stays version 3; bootstrap provider 6 extends SELECT grants on two existing tables and associates the existing card-cycle runtime. No new table, projection, index, source resource or financial algorithm is needed.

## Consumer inventory and source boundaries

| Reader / runtime | Selected inputs and behavior |
| --- | --- |
| API `GET /categories`, `GET /categories/rules` | Effective defaults over persisted categories; complete public rules in ascending source SK order |
| API analytics and assistant aggregate routes; agent-tools `month_snapshot`, `spend_by_category`, `compare_months` | Selected category names and selected movement feeds; unchanged MSI/Mi parte/uncertainty algorithms |
| Agent-tools `spend_by_merchant`, `list_movements`, `plan_month_scenario` | Existing movement readers now enabled in guarded mode on the separate runtime; category names where applicable |
| API `GET /cards` | Complete public card profiles including issuer, created/updated milliseconds, name and both cycle days |
| Card-cycle push | Cards selected once before per-day reminder/subscription loops; unchanged clamping, message modes, tags and delivery |
| Monthly close | One four-month movement feed and category list, existing shared Patrimonio/payroll inputs; unchanged prior closing-day facts, deterministic fallback HTML/text and AI rules |
| Daily balance push | One movement feed per summary; existing selected planning/payroll, unchanged calculation/messages/delivery |
| Month-end reminder | No movement or category dependency. Existing guarded Patrimonio bundle already includes supporting cards; full deterministic rendering remains covered by the independent Patrimonio gate |
| API/assistant current wealth, investment history | Existing guarded wealth/planning behavior; no extra standalone-card SQL call inside the wealth bundle |

The inspected inventory contained 12 persisted catalog entries, 13 effective categories, 174 rules, no pattern rules, three cards and 492 movements. These are observed counts on 2026-10-01, not live counters. Source records remain private outside Git. Exact matching still precedes pattern matching, longest original pattern length wins, and equal-length patterns retain ascending DynamoDB source-key precedence. SQL explicitly uses native UTF-8 C collation. Category sort remains sortOrder then Spanish name; card order remains Spanish name then ID. Missing projected defaults are a mismatch, never silently filled by the SQL adapter.

| Authoritative or operational reader | Remaining DynamoDB dependency |
| --- | --- |
| `resolveCategoryForMerchant`, category seed/backfill scripts | Source-only rules for classification/mutation decisions; scripts are operational tools, not product read consumers |
| `saveCard`, `createCardLiabilitySnapshot` | Explicit strong `listCardsDynamo` for max-three and capture validation; save/delete use source Get/Put/Delete |
| `events/mutations`, `events/manual-entry` | Explicit source detail for acceptance, rejection, schedule edits, personal share/tags and manual dedupe; SQL never decides whether to mutate |
| `allStoredEvents`, statement/CSV preview/apply, ledger observed-event reconciliation | Existing source candidates/claims/receipts for financial reconciliation and acceptance; no SQL selection |
| Category catalog/rule save and event categorization | Existing source validation/Get/Update/revisions; response-only category listing may use freshness guard |
| Bulk-edit preview/apply/undo | Strong source movement snapshot/conditional transactions and operation entities; category ID validation remains existing domain contract |
| Plan saves, CFDI import/dedupe, wealth/manual/sync writers | Existing DynamoDB transactions and source validation, S3 original evidence; projected read contracts already guarded |
| All freshness comparisons | Strong paginated base-table source reads; movement feed scan and detail partition, category/rule queries, cards, planning/payroll and wealth bundles |
| Ingestion/exceptions/import/retry state | Source identity/receipts/dedupe, failure/retry/import workflow records and authoritative capture decisions |
| Reports/reminders | Prepared/sent records and idempotent acceptance/retry decision; never read from SQL |
| Push/notify | Active subscriptions, cleanup, notification/delivery state and source capture result; new-movement notification uses accepted capture directly and has no independent movement query to migrate |
| Assistant | Conversation/thread indices and active state in DynamoDB; native AgentCore conversation/memory remains unchanged |
| Projector/maintenance/replay | Strong source current-item reconstruction and source/target verification; native Streams/checkpoints/OCC/recovery retained |

S3 evidence, Cognito access and native AgentCore memory remain their existing providers. Operational-state migrations, SQL write cutover, reverse replication and DynamoDB retirement remain future phases.

## Selection, latency and rollback

`domainReadMode` configures `DSQL_DOMAIN_READ_MODE` on API, agent-tools, monthly-close and card-cycle push. `workerLedgerReadMode` configures `DSQL_LEDGER_READ_MODE` on agent-tools, daily balance and monthly-close. The API's previously verified guarded movement flag is unchanged; the probe independently verifies the new domain flag and all movement calculations. Reminder has no new movement input or flag.

Both new flags deployed first in `shadow` and now select `guarded-sql` after independent acceptance. `dynamodb` skips SQL, `shadow` compares and returns source, and `guarded-sql` returns SQL only after complete equality with the strong source result. Mismatch/SQL error falls back, source failure propagates. Arrays and optional/zero values retain the serialized public contract. No cross-engine atomic snapshot is claimed.

Each catalog/rule/card selection uses one SQL query. Reports share their four-month movement feed; assistant comparison shares one two-month feed; daily push selects once per summary; cycle push selects once before reminder/subscription loops. Wealth still reads cards in its single bundle using explicit source readers for its guard. Existing 1.5s connection/3s query bounds apply; a failed branch aborts that input selection instead of retrying SQL across days/cards/months. Planning/payroll and wealth keep their previously bounded aggregate guards. This correctness step still incurs source reads and is not a claim of lower latency.

Rollback sets either flag to `dynamodb` in a reviewed PR, then required quality, CLEAN/MERGEABLE, linear squash/rebase merge and deploy-production. Existing movement/planning/wealth flags, schema/history/projection and recovery remain. No local Lambda configuration change or manual deployment.

## Grants, recovery and independent verification

`olbia_reader` gains SELECT on exactly `categories` and `merchant_category_rules`, for thirteen table grants total. Card-cycle gains cluster-scoped DbConnect and SQL reader association without admin/SQL mutation grants. Existing runtime source permissions remain for established writes/subscription cleanup; the deployed verification function remains source-read-only. Bootstrap provider 6 applies the reviewed grants; schema/transformer stays 3. Native unfiltered Streams, current-source checkpoint/OCC, tombstones, replay and both-direction daily reconciliation already cover all source keys. No recovery redesign or extra telemetry service is needed.

The approved deployment job reconciles source/SQL first, then invokes the independent deployed gate. New verification compares effective category defaults/overrides, all rules/public fields/original envelope/promoted columns, complete cards/public/envelope/promoted columns, exact rule resolution for all actual merchant/key/pattern examples, explicit source/SQL movement inputs and assistant aggregates/ranges. It compares full monthly facts and deterministic fallback subject/HTML/text, every daily push calculation/message mode, and every card cycle date/message mode, including common/leap February. No SES, Web Push, AI generation, refresh mutations or manufactured financial records are invoked. Existing movement, planning/payroll/XML and all retained Patrimonio/history/audit/S3 gates remain.

Independent raw SQL comparisons happen before configured readers; fallback cannot hide a corrupted projection. Local tests force pagination, stale create/edit/delete, missing defaults/cards, exact/longest/tied rules, SQL outage, source failure, rollback, source-only max-three and movement mutation decisions, and one SQL movement attempt in report/assistant loops. Native EXPLAIN returns only allowlisted scan/time/DPU observations. Counters add low-cardinality categories/merchant-rules/cards query kinds to existing domain comparison metrics; native Lambda/Streams telemetry remains authoritative for platform health.

[Autonomous run record](autonomous-runs/2026-10-01-dsql-domain-reads.md). Native capabilities checked: [SQL support](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html), [C collation/UTF-8](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-migration-guide.html), [IAM/SQL roles](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/authentication-authorization.html), [Streams recovery](https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html). Existing documented bootstrap gap remains; no custom substitute for native capture/authentication/retry was added.

## Production evidence

[Shadow PR #161](https://github.com/DavidCs9/personal-finance-system/pull/161) passed quality/CLEAN/MERGEABLE and deployed through deploy-production. Reconciliation passed 3,570 projected/equal comparisons with zero lag/mismatch. The workflow completed successfully with verified=true and zero mismatches after a delayed synchronous invocation. An independent invocation of the same deployed read-only gate also passed; no cancellation or local deployment occurred.

Independent shadow acceptance returned verified=true and zero mismatches across 494 live movements, 13 effective categories, 174 rules, three complete cards, 498 merchant resolutions, 60 assistant checks, 20 full reports/emails, 1,212 daily messages, 606 cycle dates and 240 cycle messages. Existing movement/planning/payroll/Patrimonio/evidence gates also passed, including all 149 retained evidence hashes. Nine deployed API/agent component reads produced twelve equal shadow comparisons, zero SQL errors/mismatches. Native schema [1,2,3], thirteen exact SELECT-only grants, eight alarms OK, mapping Enabled/OK and ten protected resource definitions unchanged. Initial investigation observed 492 movements; live ingestion explains the later count.

Guarded promotion and repeated production acceptance are pending. The verifier shares each month feed across its daily loop while preserving every clock, calculation and content comparison.
