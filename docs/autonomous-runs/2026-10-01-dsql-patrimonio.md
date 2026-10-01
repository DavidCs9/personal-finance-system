# DSQL Patrimonio migration — 2026-10-01

## Objective and completion criteria

Project all retained canonical wealth/liability snapshots and audit versions, preserve full identities/content/evidence, verify every retained account/day/month independently, and deploy shadow then guarded SQL reads through separate linear PRs, quality and deploy-production. Include API, assistant investment history, reports/reminders and supporting cards. DynamoDB remains write authority and strong freshness reference.

## Constraints

Read repository/autonomous/product/UI/Patrimonio and DSQL guidance before implementation. Preserve all financial algorithms, Chihuahua boundaries, carry-forward, zero liabilities, staleness, August 2026 monthly-history start, fund derived from payroll and last-good sync behavior. No manufactured production records or test notifications, local deployment, direct source mutations, source replacements, SQL write cutover or unrelated state migration. Reverify default IAM identity with STS immediately before production operations. User's three local AWS-auth guidance edits remain in original checkout, untouched; implementation uses an isolated worktree based directly on refreshed origin/main.

## Progress and next steps

Completed shadow rollout (#158), independent real-data acceptance, separate guarded rollout (#159) and repeated production reconciliation/verification. Final documentation records the completed state; remaining dependencies belong to later phases.

## Decisions

### D1 — Reuse native capture and separate canonical/audit tables
- Context: Same-day replacement must retain audit versions without multiplying balances; snapshots are flat source envelopes, not ledger payloads.
- Evidence and uncertainty: Production inventory after STS verification: 120 wealth canonical rows (three liquid accounts, 2026-08-06–2026-10-01), four wealth versions, 22 liability canonical rows (three cards), three liability versions, three card profiles. All 149 snapshots/versions reference S3 evidence; native holdings currencies include MXN, USD, SOL and RENDER. No retained zero liability exists, so exercise that contract locally. Investment history has no separate persisted entity: it derives Bitso/IBKR canonical snapshots. No audit UI/API consumer exists.
- Alternatives and tradeoffs: New replication/dual writes add failure paths. A single table with a kind flag risks mixing balances/versions. Four additive tables preserve source distinctions with explicit reads; existing native unfiltered mapping, checkpoint/OCC, replay and daily reconciliation already cover ordering/recovery.
- Decision and reason: Schema/transformer v3 adds four tables. Preserve source SK as canonical row identity, original versionId for audits, whole source_item/JSONB holdings/evidence/FX and promoted bigint/date columns. Add source_item to existing cards with explicit additive ALTER to preserve envelope timestamps for supporting card reads. Extend narrow SELECT grants. Existing writers and domain algorithms remain unchanged.
- Consequences, verification, and revisit conditions: Retained history is all retained source canonical rows plus retained audit keys, not missing intermediate captures absent from DynamoDB. Verify all content/evidence hashes, daily replacement/replay/deletion/OCC and existing gates. No fake fund rows.
- Status: Validated by local SQL/adversarial tests and full independent production shadow gate.

### D2 — One SQL statement and freshness comparison for Patrimonio inputs
- Context: Current/history/as-of calculations need canonical asset/liability history and card profiles; repeated guards inside historical loops would multiply outage latency.
- Evidence and uncertainty: Existing connector reader timeouts are bounded (1.5s connection, 3s query). Product calculations already derive balances/history in domain code. Report facts need several as-of months; assistant investment history currently loads each account separately.
- Alternatives and tradeoffs: Per-snapshot/account guards amplify SQL failures; custom circuit breaker adds state. One UNION ALL statement reads the complete canonical input bundle, then a strong source comparison preserves confirmed writes and source-only rollback.
- Decision and reason: Guard complete source inputs once per bundle, retaining complete envelopes. Reuse that selected bundle across monthly report as-of evaluations; load assistant market histories once. Independent verification uses explicit source/SQL bundles, never fallback, and exercises every retained day/month/account/holding/audit/evidence plus deterministic reports/reminders.
- Consequences, verification, and revisit conditions: Source reads remain until write authority cutover. One failure abandons SQL for the whole bundle; fund/payroll retains its separate existing guard. Test query counts for outage and no extra external notifications. Revisit if actual consumer structure needs a wider shared boundary.
- Status: Validated: one bounded attempt in SQL outage tests; production current/history/report/position comparisons passed.

### D3 — Preserve native FX precision
- Context: A promoted numeric FX column must not silently round otherwise preserved source metadata.
- Evidence and uncertainty: Revalidated official DSQL supported types: unqualified numeric defaults to (18,6), unlike local PostgreSQL. Source FX rates are finite JavaScript numbers; monetary totals remain integer bigint. Real-data current rates fit, but later rates could exceed six decimals.
- Alternatives and tradeoffs: Specify a fixed decimal scale (still a rounding bound); omit promoted FX (less explicit schema); double precision matches the existing JS-number source contract, while JSONB/source_item retain the original decimal JSON representation.
- Decision and reason: Use native double precision for promoted FX only; preserve every monetary amount in bigint and full original FX metadata/holdings in JSONB. This changes no financial calculation.
- Consequences, verification, and revisit conditions: Verify exact source FX values via independent column/content checks and native deployed gate; revisit only if source FX becomes an exact decimal string contract.
- Status: Validated native documentation, local SQL and deployed column/complete-content comparisons.

## Verification results

### Implementation checkpoint

Four additive source tables, source-key support, same existing checkpoint/OCC/reconciliation/replay, card-envelope ALTER, narrow reader grants and shadow flag on API/probe/agent/monthly-close/month-end-reminder implemented. Whole canonical inputs use one SQL statement/guard; report reuses inputs and yearly payroll; assistant market histories load once. Source-only manual/sync writes and notification behavior are unchanged. Independent gate compares all source content/promoted columns, every retained day/month/history/holding, deterministic report/reminder output and original S3 hashes; movement/planning/payroll gate remains.

- Nine new SQL integration tests passed; 24 projector/schema tests passed, including four new adversarial snapshot/audit families. Existing 22 focused planning/payroll/as-of/assistant/report tests passed.
- Private local PostgreSQL real-data projection: 152/152 records equal after two reconciliation passes, zero mismatches (149 snapshot/audit records + three cards). This is local evidence, not a production rollout claim.

## Pre-PR verification

- Full workspace suite passed: 409 tests (including nine Patrimonio integration tests and four extra adversarial source-key concurrency tests); nine Python recovery tests passed. All workspace checks, web build and infrastructure synth passed.
- Synthesized source/retained resource comparison against the deployed template after STS verification: all ten DynamoDB/DSQL/KMS/bucket/event-source-mapping resources are byte-for-byte structurally unchanged. Five participating runtimes have shadow wealth mode and the existing native reader endpoint. Daily balance push remains on its previous flags because it does not consume these entities.
- DSQL supported SQL/ALTER/data types/IAM/Streams recovery revalidated in current official documentation. Double-precision FX change was checked locally with the full real inventory and focused SQL tests after modification.
- Existing monthly history labels and order are preserved exactly. A test initially assumed closing-day labels; corrected its expectation to the existing month-start labels without changing the algorithm. Month-close as-of day exclusion passed.
- Next: shadow PR, required quality/CLEAN/MERGEABLE, linear squash merge and deploy-production; independent production verification before guarded PR.

## Shadow delivery checkpoint

[PR #158](https://github.com/DavidCs9/personal-finance-system/pull/158) passed required quality, was CLEAN/MERGEABLE and squash merged as `d098c56523a6a3596ae42442ef66884ce878331b` at 15:10:52 UTC. [Shadow deploy-production run](https://github.com/DavidCs9/personal-finance-system/actions/runs/36882229551) is in progress. Guarded promotion is not authorized by parity until this real production gate passes. Original checkout still has exactly the three unrelated AWS-auth guidance edits; no original worktree files were modified.

Native read-only diagnostics after bootstrap: schema versions [1,2,3]; olbia_reader has exactly eleven SELECT table grants, no mutation grant; additive cards.source_item is JSONB and both FX columns are double precision. STS immediately before diagnostics confirmed default codex-local-admin/account 225989371926. CloudFormation completed; deployed reconciliation `deploy-36882229551-1` started at 15:16:02 UTC. Complete backfill/financial/evidence gate still pending.

## Shadow production verification and promotion decision

Shadow deploy-production run 36882229551 succeeded. Reconciliation ran 15:16:02–15:19:20 UTC: projected/equal 3,560, lag/mismatch zero. Full independent gate verified all 149 canonical/audit snapshot records and three card envelopes/columns, 95 as-of and daily/history overviews, 21 months, 193 market/position results, 21 deterministic monthly reports, 95 reminder renderings and 149 original S3 SHA-256 files, zero mismatches. Patrimonio elapsed 29,183 ms; combined gate 60,482 ms. Existing six plans/19 payroll details/XML hashes, 22 monthly/compensation/Patrimonio checks, three payroll years and 492 movement details/21 feeds/summaries/19 ranges also passed with zero mismatches.

Read-only component verification: six successful API/agent reads, six equal wealth comparisons, source selected in shadow; all five functions Successful/shadow with prior planning guarded flags. CloudFormation UPDATE_COMPLETE; unchanged mapping Enabled/OK; eight DSQL alarms OK. Native EXPLAIN showed Index Only Scan for both wealth inputs/audit (single samples: 2.703 ms/0.99022 DPU and 1.116 ms/0.03765 DPU).

The shadow acceptance gate passed with real financial/evidence data, so proceed with a separate guarded promotion PR based directly on refreshed origin/main. Only wealth mode changes; financial algorithms, source authority, other flags, grants/schema/resources and recovery remain. No notifications, source mutations or manufactured records were used. No natural new Patrimonio capture was manufactured to test Streams; support/recovery/concurrency is covered by the deployed unfiltered native mapping and meaningful local adversarial/repeated-capture tests.

Guarded promotion local checks: nine focused Patrimonio SQL tests passed; web build/synth passed; all ten protected resources remain unchanged and all five participating runtimes synthesize guarded wealth mode. Only the flag and evidence/status documentation differ from shadow. Next: required remote quality, CLEAN/MERGEABLE linear merge, deploy-production and repeat independent native verification.

## Guarded delivery checkpoint

[PR #159](https://github.com/DavidCs9/personal-finance-system/pull/159) passed required quality, was CLEAN/MERGEABLE and squash merged as `8320e36c93d19235dee664b78eec90e65fa9c4e0` at 15:27:10 UTC. Production deployment and repeated independent verification pending; no guarded completion claim yet. Final evidence will be delivered by a documentation PR from refreshed origin/main.

Final evidence branch created directly from refreshed origin/main after the guarded merge. Production component probes invoke Lambda service/tool runtimes directly; they do not test API Gateway JWT authentication, send scheduled workers or call sync refresh mutations. Scheduled close/reminder results are checked by the shared deterministic functions in the independent deployed probe, without SES/Web Push. Existing authentication and delivery contracts are unchanged.

Guarded deployment run 36884373746 completed CloudFormation UPDATE_COMPLETE and began reconciliation `deploy-36884373746-1` at 15:31:40 UTC. Native deployed template confirms every one of the ten protected source/retained definitions matches the pre-phase template exactly. Six API/agent component reads produced six equal wealth comparisons selecting SQL, zero mismatch/error; all five participating functions Successful/guarded-sql. Existing mapping Enabled/OK and eight DSQL alarms OK. Final independent production reconciliation/financial/evidence gate remains pending at this checkpoint.


### Final guarded production acceptance

[Guarded deploy-production run 36884373746](https://github.com/DavidCs9/personal-finance-system/actions/runs/36884373746) succeeded for merged PR #159. Deployed reconciliation `deploy-36884373746-1` ran 15:31:40–15:34:57 UTC (09:31:40–09:34:57 America/Chihuahua), with 3,560 projected/equal comparisons across both passes, zero lag and zero mismatches. Its versioned private recovery report reached `done`. These are comparison counts, not distinct table-row counts.

The deployed independent gate returned `verified: true`, wealth `guarded-sql`, and zero mismatches: 120 canonical asset snapshots, four asset audit versions, 22 canonical liabilities, three liability audit versions and three card envelopes/columns; 95 as-of days and daily/history overviews, 21 months, 193 investment/position checks, 21 deterministic reports, 95 reminder renderings, and SHA-256 equality for all 149 original S3 evidence files. Whole content and promoted columns are verified independently of freshness fallback. Wealth elapsed 30,313 ms; full combined gate 64,538 ms.

Existing movement/planning/payroll regression gates passed: six stored plans, 19 CFDIs/details/XML hashes, 22 plans/summaries/compensation/wealth closes, three payroll years, current payroll-derived overview, 492 movement details, 21 feeds/summaries and 19 ranges, zero mismatches. Native wealth input/audit EXPLAIN used Index Only Scan (single samples: inputs 2.716 ms / 1.02240 DPU, audit 0.754 ms / 0.06123 DPU); these observations are not latency guarantees.

Six API/agent component reads recorded six equal comparisons selecting SQL, zero errors/mismatches. All five participating functions reported Successful/guarded-sql; CloudFormation UPDATE_COMPLETE, mapping Enabled/OK, eight DSQL alarms OK. All ten protected retained/source resource definitions exactly match the pre-phase deployed template. Schema 1/2/3 and bootstrap 5 are deployed with exactly eleven SELECT-only reader table grants. STS was checked immediately before production operations, including final native reconciliation evidence retrieval, and confirmed default codex-local-admin/account 225989371926.

## Outcome and remaining work

The requested Patrimonio migration is complete: retained backfill, continuous projection/recovery, independent financial/content/evidence verification, API/assistant/report/reminder SQL consumers, narrow grants, bounded guarded fallback and separate verified shadow/guarded production releases. Full workspace 409 tests, nine Python recovery tests, checks/build/synth and required remote quality passed. Original checkout still contains exactly David's three unrelated AWS-auth guidance edits, untouched.

DynamoDB remains the authority for every domain write and strong freshness guard. Remaining source dependencies are enumerated in [Patrimonio migration](../dsql-patrimonio.md): standalone card cycle/validation/writes, categories/rules, movement worker/dedupe/import decisions, CFDI claims, bulk operations, ingestion/retry state, delivery/subscription state and assistant conversations. SQL write-authority cutover, DynamoDB retirement, unrelated state migrations and infrastructure-tool changes remain later phases. No outstanding product decision or user approval is required for this completed scope.

No production financial records or notifications were fabricated; sync refreshes were not invoked for testing. Natural post-rollout captures were not forced, so repeated/manual/confirmed/sync-failure/transaction/recovery/outage/rollback behavior is supported by meaningful local tests and the existing deployed unfiltered mapping/reconciliation, rather than a fabricated live capture. No source history, identities, evidence or financial algorithm was changed.
