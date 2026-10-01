# DSQL movement reads

The completed [domain-read phase](dsql-domain-reads.md) enables guarded SQL for read-only categories/rules, standalone cards/cycles and worker/assistant movement consumers after separate verified shadow and promotion PRs. Its consumer inventory supersedes earlier remaining-read lists; all writes, authoritative decisions and strong freshness references remain in DynamoDB. Production evidence and rollback are recorded there.

This phase moves movement feeds and details to SQL while DynamoDB remains the write authority. It preserves existing public payloads, Chihuahua month boundaries, Mi parte (including zero), MSI calculation and ordering, movement states, revision history and observation evidence. Monthly summaries reuse the existing financial calculation with the selected feed; the subsequent [planning/payroll phase](dsql-planning-payroll.md) adds their own guarded SQL readers. Original evidence stays in S3.

## Rollout and rollback

`ledgerReadMode` in `infrastructure/lib/personal-finance-v1-stack.ts` configures the API and the read verification Lambda together. Change it only through PR, required `quality`, linear merge and `deploy-production`:

| Mode | Response | SQL behavior |
| --- | --- | --- |
| `dynamodb` | Source feed/detail | Does not connect to SQL. Feed uses the existing GSI adapter; detail uses a paginated strongly consistent base-table query. |
| `shadow` | Strongly consistent source feed/detail | Query SQL and compare complete public results; record equal/mismatch/error outcomes. |
| `guarded-sql` | SQL when public results match the source; otherwise the source | Same comparison, with automatic fallback on mismatch or SQL failure. Source failures propagate. |

The [first rollout](https://github.com/DavidCs9/personal-finance-system/actions/runs/36804153681) passed in `shadow`: 491 movement details, 21 monthly feeds/summaries and 19 ranges matched with zero mismatches. The [second rollout](https://github.com/DavidCs9/personal-finance-system/actions/runs/36805323711) enabled `guarded-sql` and passed the same gate with 492 actual movements and zero mismatches. Actual deployed API feed/detail/summary reads returned HTTP 200 and recorded SQL selection. A reviewed change to `dynamodb` is the full rollback. No local Lambda configuration change or manual code deployment is needed.

Only the API Lambda opts into this read mode. Its existing shared movement queries also supply monthly summaries, analytics and assistant read routes. Separate import/dedupe reconciliation and other Lambdas retain their existing DynamoDB reads. Categories, cards, merchant rules and all remaining application entities retain their current source reads in this phase.

## Freshness and its cost

SQL is an asynchronous projection. Native stream age or a completed backfill cannot prove that a particular user response includes a just-confirmed creation, edit, month move or deletion. A GSI cannot supply a strongly consistent comparison.

The temporary guard queries SQL first, then reads the authoritative base table with native SDK pagination and `ConsistentRead=true`. Month/range feeds scan movement payloads from the source table; details query the movement's partition including all revisions and observations. Canonical comparison preserves public array order and financial values. SQL is returned only when the complete serialized public result matches.

This supplies per-item strong consistency for writes completed before the source read begins. It is not an atomic snapshot across concurrent mutations or across the two databases. Every guarded feed still incurs a source-table scan and both database reads. This is a reversible correctness step toward the SQL write cutover, not DynamoDB retirement or a claim of improved latency. Measure its real latency with the verification probe and native Lambda metrics; remove the source dependency only after SQL owns domain writes and the remaining entities migrate.

## Permissions and verification

The official DSQL connector obtains native IAM tokens, verifies TLS and uses a bounded pool and query/connection timeouts. `olbia_reader` has schema USAGE and SELECT only on `movements`, `movement_observations`, `movement_revisions` and `msi_installments`. API/probe identities have cluster-scoped `dsql:DbConnect`, without SQL admin or projection write grants. Existing API domain write permissions remain for existing DynamoDB mutations; the verification Lambda has read-only source permissions.

`personal-finance-v1-dsql-read-verification` is a deployed, read-only capability. After reconciliation, the approved deployment job checks full source/SQL payload equivalence, every actual movement detail, each actual financial/installment month, monthly calculations, adjacent month ranges, empty boundary months, a missing detail, the legacy GSI contract, and the configured read mode. Native `EXPLAIN ANALYZE VERBOSE` supplies DPU/plan observations. The gate fails if comparison fails. Its response contains counts, timings and allowlisted plan metrics, without financial payloads, IDs or sums.

CloudWatch EMF records `SqlSelected`, `SourceSelected`, `Mismatch` and `SqlError` in `Olbia/DsqlReads`, with the low-cardinality `Query` dimension (`month` / `detail`). Mode and outcome appear in each structured event. Platform latency/errors remain native Lambda metrics. A mismatch can be normal during stream lag and automatically selects source data; sustained mismatches require projection diagnosis using the existing reconciliation/recovery runbook.

Monthly planning/payroll now have a separate rollout flag and verification gate, including payroll-derived Patrimonio and relevant worker consumers; see [planning/payroll migration](dsql-planning-payroll.md). The subsequent [Patrimonio phase](dsql-patrimonio.md) also migrated retained canonical/audit records and its API/assistant/report/reminder consumers to guarded SQL. DynamoDB remains write authority and freshness reference.

See [schema reference](dsql-schema.md), [projection runbook](dsql-migration-runbook.md) and [rollout evidence](autonomous-runs/2026-09-30-dsql-read-migration.md).
