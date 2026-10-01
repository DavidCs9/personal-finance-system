# DSQL remaining domain reads — 2026-10-01

## Objective and completion criteria

Complete category/rule, standalone card/cycle and read-only worker movement consumers. Deploy shadow through PR/quality/linear merge/deploy-production, verify real data independently of fallback, then promote through a separate guarded PR and repeat verification. Record final evidence and remaining DynamoDB dependencies.

## Constraints

DynamoDB retains every write and authoritative validation/acceptance/dedupe/reconciliation/mutation decision, plus strongly consistent freshness reads. Preserve default categories, rule precedence, complete card metadata, Chihuahua boundaries, financial algorithms and notification behavior. No manufactured financial records, test notifications, local deployments, source replacements, operational-state migration or SQL write cutover. Use default IAM credentials and verify expected STS identity immediately before production operations. Original checkout's three AWS-auth guidance edits are untouched; this worktree starts at refreshed origin/main 9978187.

## Progress and next steps

Read repository/autonomous/product/UI and migration guidance. Created isolated managed worktree and shadow branch. Inspect all consumers and real inventory; implement proportional guarded readers and independent verification, test and complete phased production delivery.

## Decisions

Pending consumer inspection. Current user AWS-auth instructions override older committed login guidance; do not alter the unrelated original edits.

## Verification results

Initial main state matches completed Patrimonio PRs #158–#160. Original checkout has exactly AGENTS.md, docs/dsql-migration-plan.md and docs/dsql-migration-runbook.md modified.

## Outcome and remaining work

In progress; no new production rollout claimed.

### D1 — Reuse projected catalogs/rules/cards and preserve source-only decisions
- Context: These entities already project into SQL; moving authoritative reads would expand migration scope and let lag affect acceptance or classification.
- Evidence and uncertainty: Fresh production scan after verified default STS found 12 persisted category entries (13 effective defaults), 174 rules, no pattern rules, three cards and 492 movements. Rule ties depend on ascending source-key order; official DSQL uses C collation/UTF-8. Real pattern coverage is absent and needs local adversarial tests.
- Alternatives and tradeoffs: New schema/envelopes duplicate retained data; broad replacement of shared readers risks validation and mutation decisions. Existing payloads plus cards.source_item satisfy all read-only contracts.
- Decision and reason: No schema/transformer change. Bootstrap 6 adds SELECT on exactly categories/rules and associates existing card-cycle worker. Explicit strong paginated source readers remain for rule classification, card max-three/liability validation and all movement mutation/manual-dedupe reads. Catalog/rule API, category analytics/assistant/report and standalone card/cycle reads use a new shadow flag. Existing worker/assistant movement readers get a separate shadow flag, leaving API movement guarded mode intact.
- Consequences, verification, and revisit conditions: Verify complete metadata, effective defaults, source key ordering, exact/pattern precedence, deletion/lag/failure and independent columns/content. SQL failure or mismatch selects source; source failure propagates. Revisit only for write-authority phase.
- Status: Implemented; validation in progress.

### D2 — Share financial inputs and verify deterministic notifications without delivery
- Context: SQL attempts inside month/day/card loops multiply outage latency; existing reminder only reads Patrimonio and has no movement input.
- Evidence and uncertainty: Monthly close already requests one four-month movement feed and one wealth bundle. Daily push selects one monthly feed; card-cycle selects cards once before reminder/subscription loops. Assistant compare_months previously selected two monthly feeds. Reader connection/query bounds remain 1.5s/3s.
- Alternatives and tradeoffs: A custom circuit breaker adds state; per-loop selection adds latency. Reuse selected bundles and unchanged domain functions.
- Decision and reason: Assistant comparison loads both months once. Worker flags reuse existing shared movement selection and card selection outside loops. Independent gate compares explicit SQL/source categories/rules/cards/columns and movement inputs, assistant aggregates/ranges, full monthly facts plus deterministic email rendering, daily push and all card reminder dates/content modes including leap/short February. Existing Patrimonio gate covers reminder rendering and evidence without sending.
- Consequences, verification, and revisit conditions: No scheduling/delivery/idempotence behavior changes. Existing native capture/recovery/OCC suffice; no custom telemetry beyond established domain mismatch counters or new replication service. Test SQL call counts on outage and preserve financial algorithms.
- Status: Implemented; validation in progress.

## Pre-PR verification checkpoint

- Full workspace suite passed 414 tests before the two final boundary/source-only additions; seven focused SQL domain tests now pass. All workspace checks, nine Python recovery tests, web build and infrastructure synth passed. Final API suite passed 232 tests, bringing the workspace total to 416; final web build/synth also passed after the additional tests and refined comparison input sharing.
- Private local PostgreSQL projected 189 retained catalog/rule/card records plus the unpersisted default category: 190/190 keys matched after two reconciliation passes, zero mismatches. Native read-only DSQL queries confirmed 13 categories, 174 rules and three cards, source order matches UTF-8 C collation, schema rows [1,2,3], current eleven SELECT grants before rollout.
- All ten protected DynamoDB/DSQL/KMS/S3/mapping resource definitions match the pre-phase deployed template exactly. Synth flags: API ledger guarded/domain shadow; agent ledger/domain shadow; daily ledger shadow; report ledger/domain shadow; cycle domain shadow. Existing planning/wealth remain guarded.
- Review found a subtle risk when sharing distant comparison months: a union could widen each month's MSI +/-24-month window. The shared bundle now reapplies the existing per-month feed scope before calculating each side and preserves invalid-month rejection. A dedicated distant-month regression passes. Financial algorithms are unchanged.
- Source-only movement/card decision regressions pass. Default/rule pagination, exact/longest/tied patterns, stale add/edit/delete, full card timestamp/issuer data, rollback/no-SQL, source failure, independent corruption detection and one-attempt outage loops pass.
- Initial standalone card parser tests exposed an eager environment import. Card configured reads now load their adapter on demand so pure input parsing retains its existing environment-free contract; full tests passed after correction.
- Native docs revalidated SQL/UTF-8 C collation/IAM/Streams recovery. No new schema/projection/recovery gap exists; only existing bootstrap extends grants/association.
- Next: shadow PR/quality/CLEAN/MERGEABLE, linear merge and deploy-production; independent production gate must pass before guarded promotion.

## Shadow delivery checkpoint

[PR #161](https://github.com/DavidCs9/personal-finance-system/pull/161) passed required quality and CLEAN/MERGEABLE, squash merged as 3be4454e045d79c8fe489b138d0656488b2381a5 at 18:14:05 UTC (12:14:05 America/Chihuahua). [Shadow production workflow](https://github.com/DavidCs9/personal-finance-system/actions/runs/36905311537) is running. Guarded branch starts directly from refreshed origin/main; flags will change only after independent shadow acceptance. Original checkout's three AWS-auth edits remain untouched.

Shadow CloudFormation UPDATE_COMPLETE. Native schema [1,2,3], thirteen exact SELECT-only grants; source UTF-8 ordering confirmed. Nine deployed API/agent component reads produced twelve equal shadow comparisons (five worker movement comparisons), zero SQL errors/mismatches. All seven participating runtimes Successful with expected flags. Unchanged mapping Enabled/OK, eight DSQL alarms OK, all ten protected deployed resource definitions match baseline. One initial probe supplied incompatible month/range parameters; the application rejected it as specified. Corrected the probe to the existing contract; the full component pass succeeded, with no application change.

Reconciliation deploy-36905311537-1 ran 12:20:17–12:23:52 America/Chihuahua (18:20:17–18:23:52 UTC), SUCCEEDED/done with 3,570 projected/equal comparisons, zero lag and mismatch. Independent deployed financial/content/evidence gate remains pending; no guarded flag change yet.

### D3 — Reuse monthly feeds in the independent daily verification loop
- Context: Production probe is progressing, but native timestamps show roughly 14–17 seconds between monthly plan comparisons while it verifies daily message content. Rebuilding two feeds for every day repeatedly computes source financial dates.
- Evidence and uncertainty: Native logs show equal outcomes, no SQL/source error. Inspection confirms daily feeds depend on month and source/SQL payloads, not the daily clock. The daily clock only affects summarizeMonthFeed/message output. Probe timeout is ten minutes; this is verification CPU cost, not an extra product SQL timeout.
- Alternatives and tradeoffs: Leave redundant work and wait several minutes; drop date checks (unacceptable); reuse the exact monthly feeds once, keeping every day/content-mode comparison.
- Decision and reason: Hoist source/SQL month feeds outside the daily loop. Same payloads/month/parser, unchanged clocks/financial algorithms and number of comparisons. Include this verification-only optimization with promotion; the shadow gate still verifies the original equivalent calculations before promotion.
- Consequences, verification, and revisit conditions: Focused independent corruption/content/daily tests must pass unchanged, followed by repeated production gate. No runtime consumer or notification behavior changes; revisit only if a feed becomes day-dependent.
- Status: Validating.

### D4 — Recover explicit shadow acceptance from the deployed read-only probe
- Context: Native Lambda END/REPORT confirms the shadow verifier completed in 329.018 seconds at 18:29:34 UTC without a logged error; deploy-production remains waiting for its synchronous invoke response at 18:38 UTC. A successful Lambda execution alone cannot prove the returned mismatch count.
- Evidence and uncertainty: Native comparisons are equal and reconciliation passed, but running Actions job logs are unavailable (HTTP 404). The long synchronous invocation may have lost its caller connection; this remains an inference until Actions returns.
- Alternatives and tradeoffs: Promote based on platform completion (insufficient); wait without independent evidence; invoke the existing deployed read-only verification capability and obtain explicit counters independently.
- Decision and reason: Run the unchanged deployed verifier locally with the default verified identity and a bounded long invocation timeout. No source/SQL data mutation, notification delivery or local code deployment. Keep flags shadow until the explicit independent result and deployment status are established.
- Consequences, verification, and revisit conditions: Capture only safe counters in repository evidence, private outputs outside Git. Investigate workflow outcome and use native CLI connection options if its invocation failed.
- Status: Investigating.

## Explicit shadow acceptance and promotion decision

The separately invoked deployed gate returned StatusCode 200, verified=true and zero total/planning/wealth/domain mismatches. It observed 494 movements (initial investigation observed 492; live ingestion continued), 21 feeds/summaries, 19 ranges and 494 details. New domain: 12 persisted/13 effective categories, 174 rules, three complete cards, 498 merchant checks, 20 months, 60 assistant checks, 20 full report/email comparisons, 1,212 daily messages, 606 cycle dates and 240 cycle messages. Existing planning/payroll gate passed 22 plans/summaries/compensation/wealth closes, 19 payroll details/evidence files. Existing Patrimonio gate passed 149 retained records/evidence files, 95 as-of overviews/reminders, 193 investment checks and 21 reports. Total elapsed 315.758s; new domain 250.328s. Native new-domain scans are Index Only Scan, total DPU estimates categories 0.00697/rules 0.19838/cards 0.00535.

D3 focused seven SQL tests and API type check passed after sharing identical monthly verification feeds. D4 recovered explicit acceptance through the deployed capability. The shadow Actions job has already completed quality, CDK deployment and reconciliation; its final synchronous caller still waits after Lambda completion. Cancel only that stalled Actions run now, preserving deployed shadow state and recorded independent acceptance. This avoids its concurrency lock delaying the separately reviewed guarded deployment. This is not a successful Actions conclusion claim; the final guarded workflow must complete its own full gate. AWS documents caller disconnect risks for long synchronous invocation: https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html. Exact network cause remains unproven.

Proceed with guarded flags in a separate PR, leaving DynamoDB authority and freshness unchanged. Repeat all deployed checks after promotion.

### D4 resolution — Shadow workflow completed before cancellation

Before cancellation took effect, Actions completed successfully. The cancellation request returned "Cannot cancel a workflow run that is completed"; no run was cancelled. Downloaded final job logs confirm verified=true, 494 movements, identical domain/content/evidence counts and zero mismatches, elapsed 319.747s (domain 259.139s). The earlier intended cancellation is superseded. The delayed synchronous caller ultimately returned; exact network/retry cause remains unproven and requires no infrastructure change. Both CI and independent local invocation establish shadow acceptance.

D4 status: validated. D1/D2 shadow behavior and independent real-data parity validated. D3 local tests validated; repeated optimized production gate remains required.
