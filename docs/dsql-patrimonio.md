# DSQL Patrimonio migration

Schema/transformer version 3 adds retained canonical asset/liability snapshots and their audit versions to the existing projection. Bootstrap provider version 5 applies additive DDL and narrow SELECT grants. DynamoDB remains the write authority and strong freshness reference. Shadow deployment and independent real-data verification precede a separate guarded promotion PR.

## Source and consumer inventory

| Source / writer | SQL projection / consumer |
| --- | --- |
| `USER#owner / WEALTH_SNAP#accountId#day`; `persistWealthSnapshot` from manual Cajita, API refresh and scheduled Bitso/IBKR sync | `wealth_snapshots`; latest balance, embedded holdings, per-account daily history, total monthly net-worth history, historical as-of balances |
| `USER#owner / WEALTH_VER#accountId#day#capturedAt`; same-day replacement stores the previous canonical | `wealth_versions`; retained audit content, original versionId/supersededAt/evidence; excluded from every balance and investment series |
| `USER#owner / LIAB_SNAP#cardId#day`; `createCardLiabilitySnapshot` manual capture | `liability_snapshots`; latest liability per configured card, zero-paid and historical carry-forward |
| `USER#owner / LIAB_VER#cardId#day#capturedAt`; previous same-day liability | `liability_versions`; retained prior captures for audit, excluded from balances |
| `USER#owner / CARD#id`; existing card save/delete | Existing `cards` gains `source_item` through explicit additive ALTER; supporting profile/creation/update timestamps preserved |
| `USER#owner / PAYROLL#month#UUID` | Existing guarded payroll derives Fondo and its running history; no persisted fund snapshot |

Inventory observed 2026-10-01: 120 asset canonical snapshots across Cajita/Bitso/IBKR (2026-08-06–2026-10-01), four asset versions, 22 liability canonical snapshots for three cards, three liability versions and three cards. All 149 snapshot/audit records reference original S3 evidence. Full private records stay outside Git. These are observed counts, not live counters. No retained zero liability existed in this inventory; local SQL tests exercise zero-paid captures.

Investment-history data is **not another persisted entity**: the assistant derives its `market_investments` scope from Bitso/IBKR canonical snapshots. It excludes Cajita, Fondo and liabilities and preserves carry-forward, mixed-as-of coverage, positions/native currencies and observed-value/FX limitations. No existing public audit-history endpoint/UI exists. Explicit source/SQL audit readers serve verification without adding an unrequested product surface.

| Runtime / path | Migrated reads |
| --- | --- |
| API `GET /wealth` | Current assets/liabilities/net, account holdings/daily history and total monthly history |
| API assistant aggregate routes / agent-tools `wealth_snapshot` | Same current Patrimonio service |
| API assistant / agent-tools `investment_history` | One canonical bundle per request, then Bitso/IBKR/account/position/range/as-of calculations |
| Monthly close email | One bundle shared by current/prior closing-day evaluations; existing deterministic report facts and staleness rules |
| Month-end balance reminder | Current Patrimonio and supporting card profiles; unchanged deterministic email content/delivery |
| Deployed read verification | Independent full content/columns, every retained day/month/history/holding/audit, report/reminder facts and S3 SHA-256 |

Daily balance push reads monthly spend/planning/payroll, not Patrimonio snapshots. Card-cycle push and standalone `GET /cards` remain on their existing source readers. Source-only card validation/max-three/save/delete remains authoritative; no SQL dependency is added to deciding whether to accept a manual liability capture. Sync workers persist only DynamoDB/S3 and keep their existing last-good behavior, alerts and schedules.

## Projection, history and recovery

Four separate tables preserve canonical versus audit identities. Canonical `row_id` is the original SK (there was no canonical payload ID); audit `row_id` and promoted `version_id` retain the original versionId. PK/SK remain unchanged. Whole flat source envelopes are retained in JSONB `payload` and `source_item`; holdings, quantities/native currencies, optional metadata, evidence references and FX remain complete. Day is date, captured/superseded instants retain milliseconds, totals are bigint. Promoted FX is double precision matching the original finite JS-number contract; JSONB retains the original JSON. Unqualified DSQL numeric defaults to (18,6), so it would silently round some rates.

Existing native unfiltered Streams mapping, checkpoint/OCC current-source reread, retries, S3 failure destination/replay and daily paginated source/target reconciliation cover every new key. Backfill uses the deployed auditable reconciliation state machine, not source writes or stale historical images. Complete retained history means every canonical and audit record still present in DynamoDB; this cannot recover intermediate captures that the source itself did not retain. No source resource, key, stream, index, TTL, protection, algorithm or write path changes.

Canonical same-day replacement does not add a new balance; the prior version remains separate audit history. Assets/card balances carry forward in the existing domain algorithms. Total comparable monthly history still starts August 2026; account histories remain daily. Month-close selects only snapshots with day <= closing day and payroll with FechaPago <= that day; October 1 syncs cannot affect September close. Fondo remains derived from payroll, with the existing year/reset semantics.

## Reads, latency and rollback

`wealthReadMode` in the stack supplies `DSQL_WEALTH_READ_MODE` to API, agent-tools, monthly close, month-end reminder and probe. `dynamodb` skips SQL; `shadow` compares and returns strong source results; `guarded-sql` returns SQL only on complete input equality, falling back on mismatch/error. Source failures propagate. Existing movement/planning flags remain unchanged.

One UNION ALL SQL statement reads canonical assets, liabilities and supporting cards from one SQL snapshot. The guard compares ordered snapshots/holdings/evidence and complete public card records to strongly consistent paginated source reads. Monthly reports reuse that selected bundle for both closing days and read payroll once per relevant year. Investment queries load their bundle once for both providers. Existing bounded reader connector timeouts (1.5s connection / 3s query) therefore do not multiply across historical days/accounts; a failed bundle abandons its SQL branch. The independent deployment gate never uses fallback to conceal differences.

Rollback: reviewed PR sets wealthReadMode to `dynamodb`, then quality → CLEAN/MERGEABLE → linear squash/rebase merge → deploy-production. Projection, schema/history and recovery remain available. Never change Lambda configuration locally or run manual production DDL.

Reader grants add SELECT on exactly four snapshot/audit tables and existing cards to the prior six tables, with schema USAGE. Runtime readers have cluster-scoped DbConnect and no SQL mutation/admin grants. Existing probe gains GetObject access only to `wealth-manual/*` and `wealth-api/*` evidence prefixes. No new resource or runtime IAM reader association is required.

## Verification and remaining dependencies

The approved deployment job first backfills/reconciles with zero lag/mismatch, then invokes the read-only deployed gate. The Patrimonio gate compares full envelopes and promoted columns independently, all retained audit keys, every retained snapshot day plus financial/month boundaries, every account's assets/liabilities/net/holdings/history, daily/monthly market and position history, deterministic close/reminder output, and original S3 evidence hashes. Existing movement/planning/payroll/XML gates continue. Results contain counts/modes/timings and allowlisted native EXPLAIN metrics; private payloads/IDs/sums stay in AWS or local private scratch. No notifications or manufactured financial records are sent for testing. Concurrent real changes can require a repeat pass: verification is observed equality, not an atomic cross-engine snapshot.

Remaining DynamoDB dependencies: every domain writer and freshness guard; card cycle API/push/validation/writes; category/rule reads and writes; movement dedupe/import/reconciliation decisions and other worker movement readers; CFDI dedupe; bulk-edit operation entities; ingestion/source/receipt/retry/import state; report/reminder delivery records; push/subscription state; assistant thread indices. SQL write authority, DynamoDB retirement and unrelated state/infrastructure-tool migrations remain later phases.

Run evidence: [autonomous record](autonomous-runs/2026-10-01-dsql-patrimonio.md). Native capabilities revalidated: [SQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html), [additive ALTER](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html), [data types](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html), [IAM/SQL grants](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/authentication-authorization.html), [native Streams recovery](https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html). The documented native DDL bootstrap gap remains; no duplicate capture/telemetry/retry service was introduced.
