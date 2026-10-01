# DSQL monthly planning and payroll

The next [domain-read phase](dsql-domain-reads.md) extends read-only categories/rules, standalone cards/cycles and worker/assistant movement consumers. Its consumer inventory supersedes earlier remaining-read lists; all writes and authoritative decisions remain in DynamoDB. Shadow/guarded production evidence is recorded separately.

This phase extends the existing projection to `USER#owner / MONTH#YYYY-MM` and `USER#owner / PAYROLL#YYYY-MM#UUID`. DynamoDB remains the authority for every plan save, CFDI import and dedupe claim. Original XML files remain in S3. At the completion of this phase, Patrimonio snapshots, liabilities and audit versions remained outside SQL; the subsequent [Patrimonio phase](dsql-patrimonio.md) has now projected them and deployed independently verified guarded readers.

## Projection and backfill

SQL schema/transformer version 2 adds only `olbia.monthly_plans` and `olbia.payroll`; bootstrap provider version 4 creates them and extends the reader role. The prior migration row and existing tables/columns/keys/indexes remain. The native source mapping has no entity filters to update: its existing projector now recognizes the two new key patterns. No source resource or stream changes are needed.

The same checkpoint/OCC transaction, current strongly consistent source reread, tombstones, native stream retries/S3 recovery/replay and paginated reconciliation apply to the new entities. The deployed reconciliation state machine backfills retained history and checks complete envelopes, SQL columns and payloads in both directions. No direct source writes or stale snapshot images are used to manufacture projection events. Daily reconciliation continues repairing current state, including deletions.

Plans retain their full payload, including legacy manual income values, payment IDs/order, explicit empty lists and timestamps. Payroll retains UUIDs, all totals/CFDI lines, employer/payment periods, ingestion time and evidence references. No foreign keys, derived fake parents or rewritten IDs are introduced. Primary-key ranges cover plan inheritance and payroll month/year queries; additional indexes are unnecessary at the observed six-plan/19-CFDI volume.

Source writers remain `saveMonthlyPlan` in `services/api/src/months/service.ts` and `persistPayslip` in `services/api/src/imports/cfdi-nomina-flow.ts`, reached by the authenticated monthly-plan save and CFDI preview/commit/import flows. Plan saves keep existing legacy income and return guarded state after the source write. Payroll persistence keeps its existing UUID claim transaction and original XML evidence upload. No extra writer, SQL dedupe claim or dual-write path was added. Shared readers are `getMonthlyPlan`, `incomeFieldsForMonth`, `listPayslipsForMonth`, `listPayslipsForYear` and `getPayslip`; original strongly consistent readers remain explicit for freshness comparison and verification.

## Reads, rollout and rollback

`planningReadMode` in `infrastructure/lib/personal-finance-v1-stack.ts` supplies `DSQL_PLANNING_READ_MODE` to these consumers:

| Runtime | Migrated reads |
| --- | --- |
| API | Monthly plan/income, monthly summary, payroll detail, assistant aggregate routes, current/historical payroll-derived Patrimonio |
| Agent tools | Monthly income/commitments and payroll-derived Patrimonio |
| Daily balance push | Plan, income and monthly calculation inputs |
| Monthly close email | Payroll-derived Patrimonio as of the prior month’s final day |
| Month-end balance reminder | Payroll-derived current Patrimonio |
| Read verification | Explicit independent source/SQL and configured-read comparisons |

The flag is separate from movement read mode. `dynamodb` skips SQL entirely; `shadow` compares but returns source results; `guarded-sql` selects SQL only on full equality and otherwise returns source results. All flag changes follow PR → required quality → linear squash/rebase merge → deploy-production. Deploy shadow, run the real-data gate, and only then promote guarded reads in another PR. Rollback sets planning mode to `dynamodb` through that same workflow; projection/history remain available.

Plan SQL reads preserve the exact latest-prior-record contract, including explicit-empty stops, skipped months/year boundaries and no future inheritance. Reads never materialize a plan. Saves still write only DynamoDB and the returned result uses the freshness guard. Payroll month/year arrays keep FechaPago/UUID order, and case-insensitive detail lookup retains ingestion/evidence data. Income uses the existing ordinary/extraordinary, second-quincena and provisional-income algorithms. The guard compares the complete income derivation so one SQL failure aborts that branch instead of multiplying timeouts across up to 24 prior months. Standalone payroll month/year/detail reads have their own guard. Source failures propagate.

YTD fund, running same-day history, compensation and Patrimonio as-of exclusion use unchanged domain calculations. SQL values come from preserved JSONB contracts; bigint promoted columns are verified without floating-point conversion. Payroll dedupe still uses the existing DynamoDB claim transaction, including during SQL lag/outages.

`olbia_reader` gains SELECT on exactly the two new tables, retaining SELECT on its four movement tables and schema USAGE. API/probe/worker identities receive cluster-scoped DbConnect, with no SQL mutation/admin grants. The probe gains read access only to the existing CFDI XML prefix to verify original hashes. Existing DynamoDB write permissions remain for established domain operations; the probe remains read-only.

## Production verification

The shadow rollout ([PR #155](https://github.com/DavidCs9/personal-finance-system/pull/155), [deployment](https://github.com/DavidCs9/personal-finance-system/actions/runs/36874254903)) passed on 2026-10-01: all 3,262 projected rows matched, with zero lag/mismatch; six stored plans and 19 CFDIs matched complete content. Independent reads verified 22 plans, monthly summaries, compensation results and Patrimonio closes, three payroll years, current Patrimonio, all 19 details and original XML hashes, with zero mismatches. Native plan/payroll queries used Index Only Scan. Seven deployed API/agent component reads also passed shadow comparisons. Guarded promotion keeps the same source equality check and rollback flag.

Guarded promotion ([PR #156](https://github.com/DavidCs9/personal-finance-system/pull/156), [production deployment](https://github.com/DavidCs9/personal-finance-system/actions/runs/36876545927)) succeeded on 2026-10-01. Its deployed reconciliation repeated 3,262 equal rows, zero lag/mismatch, and its independent guarded-read gate repeated all the above financial/evidence checks with zero mismatches. All six functions report guarded planning mode; seven deployed API/agent component reads produced 12 equal comparisons selecting SQL. CloudFormation is UPDATE_COMPLETE, the unchanged native mapping is Enabled/OK, and all eight DSQL alarms are OK. DynamoDB remains write authority and freshness reference.

The existing deployment job first executes the deployed reconciliation capability, then invokes the extended read verification Lambda. Independent SQL/source readers prevent the freshness fallback from concealing a migration mismatch. The gate verifies:

- Every retained plan/payroll envelope, every CFDI detail and original XML SHA-256.
- Every actual financial month plus gaps and empty boundaries: plan carry-forward, income, compensation and full monthly calculations with SQL movement feeds.
- Every relevant payroll year: sorted payroll, YTD fund and running fund history.
- Full Patrimonio balance as of each tested month’s final day, and current Patrimonio including monthly/account history, with only payroll source swapped.
- Configured reads, missing details and native EXPLAIN scan/timing/DPU observations.

Results return counts, modes, timings and allowlisted plan metrics only. Financial payloads, XML, UUIDs and sums stay private. Domain counters reuse `Olbia/DsqlReads`, adding low-cardinality plan/payroll query kinds; platform errors/latency/recovery remain native AWS metrics. Verification observes equivalence across passes, not an atomic cross-engine snapshot. Concurrent real mutations can require a new reconciliation/verification pass.

Remaining DynamoDB dependencies include the guard itself; plan/payroll writes and CFDI dedupe; movement writes/dedupe/import decisions; category/card/rule reads and writes; bulk-operation records; source/receipt/import workflow state; reports/reminder delivery state; push subscriptions; conversations; and all Patrimonio entities/history. Movement reads in the four workers retain their previous source mode. This phase does not move SQL write authority, retire DynamoDB, migrate Patrimonio entities or change infrastructure tools.

Evidence and decisions: [autonomous run](autonomous-runs/2026-10-01-dsql-planning-payroll.md). Recovery procedures: [projection runbook](dsql-migration-runbook.md). Native SQL and access capabilities were checked against [supported SQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html) and [IAM/SQL authorization](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/authentication-authorization.html).
