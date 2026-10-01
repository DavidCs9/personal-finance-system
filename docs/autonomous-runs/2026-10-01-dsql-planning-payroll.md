# DSQL planning and payroll migration — 2026-10-01

## Objective and completion criteria

Project real monthly planning and payroll history continuously into DSQL, verify identical plans, income, monthly calculations and payroll-derived Patrimonio, then deploy shadow and guarded SQL reads through PR/quality/linear merge/deploy-production.

## Constraints

DynamoDB remains write authority and freshness reference. Preserve IDs, CFDI dedupe, S3 evidence, history, source resources and financial algorithms. No local deployments or direct DynamoDB mutations. Patrimonio entity migration, SQL write cutover, DynamoDB retirement and infrastructure-tool changes remain out of scope.

## Progress and next steps

- Read required repository, autonomous, product, migration and UI/Patrimonio guidance. Clean checkout; branch `codex/dsql-planning-payroll` created directly from refreshed `origin/main`.
- Production inventory: six plans (2026-04 through 2026-09), including four explicit empty lists and two nonempty lists; 19 CFDIs across 2026-01 through 2026-09, including extraordinary payroll. All source owner/month/UUID identities match their keys; XML references remain in S3. Full private inventory is outside Git.
- AWS setup was updated by David during this run: default long-lived IAM user codex-local-admin has AdministratorAccess and no permissions boundary. Preserve his unrelated edits to AGENTS.md and migration authentication guidance.
- Inspect source records, readers/writers and existing projector/recovery; extend additive schema and guarded readers; verify locally; ship shadow and verify real history before promotion.

## Decisions

### D1 — Extend the existing source reconciliation and guard
- Context: Payroll evidence lives partly in the source envelope; plans have no payload ID and carry forward the latest prior record, including explicit empty lists. Existing source writes have no common monotonic version.
- Evidence and uncertainty: Existing projector rereads strongly consistent current source inside checkpoint OCC transactions; native Streams, recovery and deployed reconciliation already cover ordering and backfill. Production inventory pending.
- Alternatives and tradeoffs: A new replication service or dual writes adds failure paths; extending existing keyed reconciliation preserves its tested ordering and recovery. SQL-only reads would hide confirmed writes during lag.
- Decision and reason: Add planning/payroll tables and source-key support to the existing projector. Preserve full envelopes/evidence and use the existing SQL-first, strongly consistent source comparison before selecting SQL. Deploy comparison mode first and promote only after production equivalence passes.
- Consequences, verification, and revisit conditions: Extra source reads remain until write authority moves. Verify carry-forward/empty lists, all payroll fields, evidence, income/fund calculations, duplicate imports, lag/error/rollback and recovery; reconsider only if real source contracts expose a gap.
- Status: Provisional, inventory and verification pending.

### D2 — Cover existing planning/payroll consumers together
- Context: API monthly state, summaries and Patrimonio are also called by agent tools, daily balance push, monthly close and month-end balance reminders. Leaving those workers on source-only reads would leave this data migration incomplete.
- Evidence and uncertainty: These workers reuse the same service functions. The agent proxy and investment sync workers do not read payroll or plans. Required SQL operations are SELECT on the two new tables, with the same source guard; movement read mode in workers remains unchanged.
- Alternatives and tradeoffs: API-only rollout leaves known consumers unmigrated; enable the same separate planning flag and native reader grants on all four relevant workers, plus API/probe, covers them without changing their notifications, writes or financial algorithms.
- Decision and reason: Roll out planning/payroll shadow and guarded modes together on API, agent tools, daily balance push, monthly close and month-end reminders. Extend SELECT-only grants by exactly the two tables; no admin/write privileges. Production probes compare deterministic report/Patrimonio results without sending emails or pushes.
- Consequences, verification, and revisit conditions: Verify synthesized dependency graph and identity grants, deployed configurations and all shared calculations. No manufactured production writes or notification sends for testing.
- Status: Provisional.

### D3 — Guard the complete income derivation
- Context: Income can query up to 24 prior months. Guarding every inner query independently would repeat SQL connection timeouts during an outage and could exceed the API/agent timeout even though DynamoDB remains healthy.
- Evidence and uncertainty: The existing income algorithm walks prior ordinary payroll when the selected month is empty. The connector supplies bounded connection/query timeouts, but repeated sequential calls multiply that bound.
- Alternatives and tradeoffs: Add a custom circuit breaker (extra state and recovery semantics); compare each inner query (possible timeout amplification); compare the complete income result with independent SQL/source readers (one failure abandons the SQL branch, then derives current source results).
- Decision and reason: Reuse the existing guard around the complete income derivation; standalone monthly/year/detail payroll reads remain guarded. This preserves the financial algorithm and avoids introducing connection-health state.
- Consequences, verification, and revisit conditions: Test a SQL outage with an empty month and prior-month traversal, asserting only one SQL connection attempt before source fallback. Source reads still fail openly when unavailable.
- Status: Provisional.

## Verification results

- Full workspace checks passed. Initial full suite: 395 tests passed; the added gate test brings the targeted suite to eight passing tests. Nine Python recovery tests passed; build and synth passed.
- Private local PostgreSQL verification used all 25 real source records: six plans, 19 CFDIs, duplicate reconciliation and 14 months; zero mismatches in complete stored content, monthly payroll, income/compensation and running fund history. This is local SQL evidence, not a production deployment claim.
- Synthesized production resource comparison: DynamoDB table, DSQL cluster, all four event source mappings, encryption key and all three buckets match the deployed definitions exactly.

## Outcome and remaining work

In progress.
