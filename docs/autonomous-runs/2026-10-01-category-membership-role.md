# Category mutation SQL role — 2026-10-01

## Objective and completion criteria

During the authorized category integrity rollout, repair a production authorization gap in catalog membership reads. Complete required PR/quality/merge/deploy verification, then resume the auditable repair and native relationship work recorded in the category integrity run.

## Constraints

Follow the binding SQL-native and single-owner north stars, preserve previous revisions and financial values, and release exclusively through reviewed PR and deploy-production. No direct production schema or financial writes.

## Progress and next steps

#174 deployed successfully: SQL reconciliation, independent financial/evidence probes and rollback smoke passed with zero mismatches. Seven of ten audited undo operations succeeded. An operation restoring `otros` failed before mutation with SQL connection access denied; a repeat returned the same error. Remaining operation state and payloads will be rechecked after the fix. Native relationship work is preserved in a Git stash on `codex/category-relationships`.

## Decisions

### D1 — Use the mutation role for category membership

- Context: Mutation Gateway Lambdas have the `olbia_application` SQL identity. Membership validation introduced a read through `olbia_reader`, which this write-only runtime cannot assume. Null restores bypassed the query, revealing the gap only on the first nonnull restore.
- Evidence and uncertainty: Infrastructure grants the application identity and catalog SELECT to mutation runtimes. API transactions already supply that identity through AsyncLocalStorage; standalone Gateway calls lack an enclosing transaction and selected the reader identity. Repeated access denied is consistent with this wiring, not stale financial data.
- Alternatives and tradeoffs: Grant every mutation runtime the product-reader role, or perform write validation through the already-authorized application client.
- Decision and reason: Use `applicationStoreClient()` for membership. It reuses a current transaction and otherwise selects the correct existing write identity. No additional IAM grants or broader product-reader authority are needed.
- Consequences, verification, and revisit conditions: Integration tests must exercise membership outside an API transaction and prove it never opens a reader identity. Recheck the failed operation after deploy, retry the same idempotent undo and verify all financial fields and original revisions.
- Status: Validated in production.

## Verification results

All 455 workspace tests passed; API type check and CDK synthesis passed. The regression test exercises standalone membership with the product-reader identity unavailable, and confirms membership uses the application connection. No infrastructure policy change is required. PR #175 passed required quality, was CLEAN/MERGEABLE, squash-merged as `c7764b7` and deployed through workflow `36965735387`. SQL/financial/evidence/rollback gates passed with zero mismatches. Standalone nonnull undo calls now succeed; all remaining audited restorations completed without duplicate revisions.

## Outcome and remaining work

Complete. The role gap is fixed and production-verified. The category integrity run continues with native rule/relationship deployment.
