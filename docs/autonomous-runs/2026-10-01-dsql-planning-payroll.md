# DSQL planning and payroll migration — 2026-10-01

## Objective and completion criteria

Project real monthly planning and payroll history continuously into DSQL, verify identical plans, income, monthly calculations and payroll-derived Patrimonio, then deploy shadow and guarded SQL reads through PR/quality/linear merge/deploy-production.

## Constraints

DynamoDB remains write authority and freshness reference. Preserve IDs, CFDI dedupe, S3 evidence, history, source resources and financial algorithms. No local deployments or direct DynamoDB mutations. Patrimonio entity migration, SQL write cutover, DynamoDB retirement and infrastructure-tool changes remain out of scope.

## Progress and next steps

- Read required repository, autonomous, product, migration and UI/Patrimonio guidance. Clean checkout; branch `codex/dsql-planning-payroll` created directly from refreshed `origin/main`.
- Production inventory: six plans (2026-04 through 2026-09), including four explicit empty lists and two nonempty lists; 19 CFDIs across 2026-01 through 2026-09, including extraordinary payroll. All source owner/month/UUID identities match their keys; XML references remain in S3. Full private inventory is outside Git.
- AWS setup was updated by David during this run: default long-lived IAM user codex-local-admin has AdministratorAccess and no permissions boundary. Preserve his unrelated edits to AGENTS.md and migration authentication guidance.
- Implemented additive schema/projection, guarded readers on all existing planning/payroll consumers, and independent financial/evidence verification.
- [PR #155](https://github.com/DavidCs9/personal-finance-system/pull/155) passed required quality, was CLEAN/MERGEABLE and squash merged as `a8f2dcaa92a3f6c9bf83c6585851f4245ffd757d`. [Shadow production run](https://github.com/DavidCs9/personal-finance-system/actions/runs/36874254903) succeeded, including deployed historical reconciliation and independent financial/evidence checks.
- [Guarded promotion PR #156](https://github.com/DavidCs9/personal-finance-system/pull/156) passed required quality (396 workspace tests, nine Python recovery tests, checks/build/synth), was CLEAN/MERGEABLE and squash merged as `1c10c16313eaec5aabd43fa232b1d6558db46b7b` at 14:27:59 UTC. [Guarded deployment](https://github.com/DavidCs9/personal-finance-system/actions/runs/36876545927) succeeded. All six participating functions now use guarded planning reads; movement mode stays unchanged. Final evidence and roadmap/runbook status are delivered by a documentation PR based directly on refreshed origin/main.

## Decisions

### D1 — Extend the existing source reconciliation and guard
- Context: Payroll evidence lives partly in the source envelope; plans have no payload ID and carry forward the latest prior record, including explicit empty lists. Existing source writes have no common monotonic version.
- Evidence and uncertainty: Existing projector rereads strongly consistent current source inside checkpoint OCC transactions; native Streams, recovery and deployed reconciliation already cover ordering and backfill. Production inventory pending.
- Alternatives and tradeoffs: A new replication service or dual writes adds failure paths; extending existing keyed reconciliation preserves its tested ordering and recovery. SQL-only reads would hide confirmed writes during lag.
- Decision and reason: Add planning/payroll tables and source-key support to the existing projector. Preserve full envelopes/evidence and use the existing SQL-first, strongly consistent source comparison before selecting SQL. Deploy comparison mode first and promote only after production equivalence passes.
- Consequences, verification, and revisit conditions: Extra source reads remain until write authority moves. Verify carry-forward/empty lists, all payroll fields, evidence, income/fund calculations, duplicate imports, lag/error/rollback and recovery; reconsider only if real source contracts expose a gap.
- Status: Validated by local real-data/SQL tests and the deployed historical/financial/evidence gate.

### D2 — Cover existing planning/payroll consumers together
- Context: API monthly state, summaries and Patrimonio are also called by agent tools, daily balance push, monthly close and month-end balance reminders. Leaving those workers on source-only reads would leave this data migration incomplete.
- Evidence and uncertainty: These workers reuse the same service functions. The agent proxy and investment sync workers do not read payroll or plans. Required SQL operations are SELECT on the two new tables, with the same source guard; movement read mode in workers remains unchanged.
- Alternatives and tradeoffs: API-only rollout leaves known consumers unmigrated; enable the same separate planning flag and native reader grants on all four relevant workers, plus API/probe, covers them without changing their notifications, writes or financial algorithms.
- Decision and reason: Roll out planning/payroll shadow and guarded modes together on API, agent tools, daily balance push, monthly close and month-end reminders. Extend SELECT-only grants by exactly the two tables; no admin/write privileges. Production probes compare deterministic report/Patrimonio results without sending emails or pushes.
- Consequences, verification, and revisit conditions: Verify synthesized dependency graph and identity grants, deployed configurations and all shared calculations. No manufactured production writes or notification sends for testing.
- Status: Validated by local integration tests, synthesis, all six deployed shadow configurations, and API/agent component reads. Scheduled workers share these verified services; no notifications were sent for testing.

### D3 — Guard the complete income derivation
- Context: Income can query up to 24 prior months. Guarding every inner query independently would repeat SQL connection timeouts during an outage and could exceed the API/agent timeout even though DynamoDB remains healthy.
- Evidence and uncertainty: The existing income algorithm walks prior ordinary payroll when the selected month is empty. The connector supplies bounded connection/query timeouts, but repeated sequential calls multiply that bound.
- Alternatives and tradeoffs: Add a custom circuit breaker (extra state and recovery semantics); compare each inner query (possible timeout amplification); compare the complete income result with independent SQL/source readers (one failure abandons the SQL branch, then derives current source results).
- Decision and reason: Reuse the existing guard around the complete income derivation; standalone monthly/year/detail payroll reads remain guarded. This preserves the financial algorithm and avoids introducing connection-health state.
- Consequences, verification, and revisit conditions: Test a SQL outage with an empty month and prior-month traversal, asserting only one SQL connection attempt before source fallback. Source reads still fail openly when unavailable.
- Status: Validated: SQL outage test attempts connection only once before deriving provisional source income.

## Verification results

- Full workspace checks passed. Initial full suite: 395 tests passed; final API suite: 216 tests passed, including eight planning/payroll SQL integration tests (total 396 across the latest workspace results). Nine Python recovery tests passed; build and synth passed.
- Private local PostgreSQL verification used all 25 real source records: six plans, 19 CFDIs, duplicate reconciliation and 14 months; zero mismatches in complete stored content, monthly payroll, income/compensation and running fund history. This is local SQL evidence, not a production deployment claim.
- Before rollout, original stream mapping Enabled/OK and all eight DSQL alarms OK.
- Synthesized production resource comparison: DynamoDB table, DSQL cluster, all four event source mappings, encryption key and all three buckets match the deployed definitions exactly.
- Production schema versions 1 and 2 coexist; six plan and 19 payroll rows are present. Native SQL grants show exactly SELECT on the two new tables and the four existing movement tables, with no SQL write grant to the reader.
- Shadow reconciliation execution `deploy-36874254903-1` succeeded (2026-10-01 14:15:42–14:18:48 UTC): projected/equal 3,262; lag 0; mismatch 0.
- Deployed independent probe: planning mode shadow; six stored plans/19 payroll records; 22 plans, summaries, compensation results and full Patrimonio closes; three payroll years; current full Patrimonio; 19 details/19 original XML SHA-256 checks; one missing lookup; zero mismatches (11,737 ms planning verification). Existing movement gate also passed 492 movements/details, 21 feeds/summaries and 19 ranges, zero mismatches.
- Native EXPLAIN: both plan and annual payroll use Index Only Scan. Plan execution 0.522 ms/0.01229 DPU; payroll 0.635 ms/0.12961 DPU (single diagnostic samples, not latency guarantees).
- Seven read-only deployed component invocations succeeded: prior/current inherited plan, monthly summary, lowercase CFDI detail, current Patrimonio, agent month and agent Patrimonio. All planning comparisons equal and selected source in shadow; movement summary selected SQL as configured. These test Lambda service/runtime identities directly, not API Gateway authentication.
- Guarded promotion checks: 13 planning/payroll and infrastructure safety tests passed, infrastructure type check/build/synth passed, and all 10 protected resources remain identical. Remote quality repeated the full workspace suite (396 tests) and nine Python recovery tests successfully.
- Production guarded component checks: seven invocations succeeded with 12 equal comparisons, all selecting SQL and zero mismatch/error; all six functions report Successful/guarded-sql. Source versions 1/2 and six/19 row counts remain intact; reader grants remain SELECT only on the exact six tables.
- Guarded reconciliation execution `deploy-36876545927-1` succeeded (2026-10-01 14:32:23–14:35:28 UTC): projected/equal 3,262; lag 0; mismatch 0. Its independent probe again verified all six plans/19 payroll records, 22 plans/summaries/compensation/Patrimonio closes, three payroll years, current Patrimonio, 19 details/XML hashes and the missing lookup; zero mismatches, planning verification 11,629 ms. Both query shapes still use Index Only Scan (plan 0.467 ms/0.01224 DPU; payroll 0.611 ms/0.12960 DPU, individual diagnostic samples). Existing movement gate also passed with zero mismatches.
- Final native health: CloudFormation UPDATE_COMPLETE, original mapping Enabled/OK and all eight DSQL alarms OK. No local deployment, Lambda update, direct source data mutation, manufactured financial record, source resource replacement or test notification occurred. Ordering/confirmed-update/delete/duplicate/lag/outage/rollback guarantees were exercised in meaningful SQL integration and adversarial concurrency tests; the deployed pipeline uses the existing unfiltered native stream/recovery/daily reconciliation. No new natural plan/payroll source mutation was needed or manufactured during this run.
- Documentation relative links and diff whitespace checks passed. Financial source/SQL payloads and XML remain outside Git and public logs; audit evidence is the deployed execution's private versioned progress object and the sanitized Actions gate results.

## Outcome and remaining work

Completed: versioned additive planning/payroll schema; retained historical backfill; continuous projection through the existing capture/recovery mechanisms; guarded SQL readers on all relevant consumers; independent real-data financial/evidence verification; shadow then guarded production deployments via quality and linear PR merges. DynamoDB remains the source of every domain write and the strong freshness comparison; IDs, evidence and financial calculations are preserved.

Remaining phases: migrate Patrimonio entities/history and other source-only dependencies listed in `docs/dsql-planning-payroll.md`; design/verify SQL write authority and its rollback; retire DynamoDB only after that cutover is separately authorized and verified. Movement reads in the four workers remain in their previous source mode. Infrastructure-tool changes are outside this run. No decision needs user review for this completed phase. David's unrelated local AWS-auth guidance edits remain uncommitted and preserved.
