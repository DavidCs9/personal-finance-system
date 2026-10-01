# DSQL ledger read migration — 2026-09-30

## Objective and completion criteria

Implement and deploy SQL movement/monthly-summary reads, compare real results with DynamoDB, enable a reversible guarded read mode, and preserve immediate visibility of confirmed writes. David authorized this next migration step; DynamoDB remains write authority. Complete the required PR/quality/linear merge workflow and production verification.

## Constraints

- Sole private owner; preserve current financial calculations, API payloads, provenance and Resumen / Movimientos / Patrimonio semantics.
- PR/main/deploy-production only; no local code deployment, direct source data mutation, destructive cleanup or fake financial writes.
- Preserve all source data and existing resources. SQL reader role must be read-only.
- Keep remaining entity migration and SQL write-authority cutover out of this phase.

## Progress and next steps

- Read repository/autonomous/product/UI guidance and AWS CDK, serverless and JS SDK skills. Clean checkout; branch codex/dsql-ledger-read-path starts from refreshed origin/main.
- Existing month queries scan up to 49 GSI partitions and are shared with summary/analytics/assistant consumers. Import reconciliation uses a separate allStoredEvents function and must remain on DynamoDB.
- Implemented SQL feed/detail adapter, strongly consistent paginated source guard, native SELECT-only SQL role, read-only verification Lambda and deployment gate. No source table or stream mapping changes in the synthesized template.
- Local financial, failure and pagination tests pass. Infrastructure validation caught a construct-wide bootstrap dependency cycle; corrected by ordering only the Lambda resource after bootstrap. No deployment was attempted with the invalid definition.
- Shadow implementation [PR #152](https://github.com/DavidCs9/personal-finance-system/pull/152) passed required quality, was CLEAN/MERGEABLE and squash merged as `6aab86a1d52a47fa131c05e4b45c3cc01b1cb85f`. Approved [production run 36804153681](https://github.com/DavidCs9/personal-finance-system/actions/runs/36804153681) passed quality, deployment, stored-row parity and public read comparison.
- Next: promote guarded-sql through a second PR/quality/deployment, repeat real-data verification and check the actual API's SQL selection and native health.

## Decisions

### D1 — Guard asynchronous SQL reads with the authoritative source
- Context: Replication and the existing GSI are asynchronous. A SQL-only response can temporarily hide a confirmed creation, edit, month move or deletion. There is no atomic snapshot across the two engines or native cross-engine freshness barrier.
- Evidence and uncertainty: AWS documents that GSIs cannot provide strongly consistent reads; base-table Get/Query/Scan can provide per-item strong consistency. Scan is not a global snapshot. The personal ledger contains 491 movements at the last verified snapshot; real latency/cost must be measured after deployment.
- Alternatives and tradeoffs: Rely on a fixed delay or iterator age (cannot prove freshness); add source-wide versions to every writer/outbox (large write-path change); use a temporary strongly consistent source comparison and choose SQL only when complete public results match (extra source read work, but complete coverage of existing writers and safe fallback).
- Decision and reason: Implement reversible dynamodb/shadow/guarded-sql modes limited to the API read path. Guarded month reads compare SQL against a paginated, strongly consistent base-table movement scan; detail reads compare against strongly consistent source queries. Matching SQL responses can be served; mismatch or SQL errors return current source data. Import/dedupe decisions remain on the existing source path. This is domain migration comparison code, a documented gap in native capabilities, not a custom replication service.
- Consequences, verification, and revisit conditions: This remains dependent on DynamoDB and is not the final SQL-only architecture. It guarantees visibility of writes completed before source reads begin, not a global atomic snapshot during concurrent mutation. Test pagination, newly created/moved/deleted records, revision/observation changes, SQL outage and exact public results. Measure real latency; revisit the source guard when SQL becomes write authority.
- Status: Validated in shadow production. Source scan 477 ms; configured current-month/detail comparison 420 ms (one probe invocation, not a latency percentile). Guard remains temporary until SQL write authority.

## Verification results

- API: 208 tests passed, including five new suites exercising real PostgreSQL queries, financial contracts, create/edit/month-move/delete/provenance freshness, SQL failure/rollback and native source pagination.
- Ledger: 52 tests passed, including SELECT-only reader grant checks. Infrastructure: 14 tests passed after dependency correction.
- Final complete workspace run: 386 tests passed; nine recovery-script Python tests passed. All workspace type checks passed; synthesis and deployment verification shell syntax passed; diff whitespace check passed.
- Synthesized source table, DSQL cluster and existing stream mappings match their previous definitions exactly. New probe uses Node 24, a ten-minute timeout and read-only source/SQL grants.
- Shadow production: 491 full movement payloads/details, 21 feeds, 21 monthly summaries, 19 ranges and one missing detail matched; zero mismatches. Entire probe 19,782 ms; source scan 477 ms; SQL feeds averaged 43 ms; legacy all-month range 938 ms; configured current-month/detail reads 420 ms. These are one-run measurements, not representative percentiles.
- Shadow stored-row reconciliation SUCCEEDED: projected/equal 3,200, lag/mismatch zero. The enabled original stream mapping reported OK and all eight DSQL alarms were OK before this rollout.
- Native current-month plan used Index Scan and Index Only Scan, 12.080 ms execution, estimated 1.73730 total DPU (0.01267 compute / 1.72463 read / zero write). No index or schema changes were needed.

### D2 — Prove read equivalence before promotion
- Context: Local PostgreSQL tests cannot prove DSQL IAM, real SQL behavior or equivalence across David's actual historical months and details.
- Evidence and uncertainty: The existing deployment gate verifies stored rows, not the public feed or summary contract. Native SQL roles support SELECT-only grants; CloudWatch EMF supports domain counters, while Lambda already supplies platform failures/latency.
- Alternatives and tradeoffs: Enable unverified SQL directly; rely on operator SQL scripts; deploy a read-only verification Lambda alongside shadow reads, run it in the approved job, then promote in a second reviewed PR after it passes.
- Decision and reason: First deploy shadow mode and a SELECT-only reader role, with a deployed real-data verification capability for every actual movement/detail/month plus representative empty/range cases and shared monthly calculations. Then promote guarded-sql through PR/quality. Use a few low-cardinality EMF domain counters; native Lambda metrics remain the platform telemetry.
- Consequences, verification, and revisit conditions: Two deliberate rollouts. Verification returns only counts, timings and native EXPLAIN DPU/plan metrics, never payloads or financial sums in public logs. Monthly planning/payroll stay sourced from DynamoDB and reuse existing calculations.
- Status: Shadow rollout validated against the real DSQL engine and actual historical ledger; guarded promotion pending.

## Outcome and remaining work

In progress. The completion gate includes real-engine query equivalence and successful approved deployment, not only local PostgreSQL tests.
