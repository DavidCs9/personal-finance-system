# Legacy financial reader guard — 2026-10-02

## Objective and completion criteria

David authorized continued autonomous normalization. Before the coherent native ledger release, deploy a narrow guard that prevents old financial reader bundles from treating retained financial envelopes as current authority after marker 14. Complete PR/quality/linear merge/deploy-production and independent unchanged-data acceptance.

## Constraints

Olbia must feel born in SQL and belongs solely to David. This is a rollout prerequisite, not the native ledger domain. Preserve financial data, retained evidence and existing resources. No local production deployment or direct financial writes. Use immediate STS identity before production diagnosis/acceptance.

## Decision

The core branch's attempted CloudFormation ordering exposed a real cycle: API → AgentCore → mutation gateway/function → API. The existing writer guards prevent old writes, but not stale old reads. Instead stage marker-14 checks before old SQL feeds/details and every SDK source/all-event reader. After activation, old readers return the established MigrationPausedException; before activation their behavior remains unchanged. Only schema_migrations SELECT is added to the product SQL reader. No new authority flag, resource or permanent financial adapter is introduced. The final native release retires these old readers entirely.

## Progress and verification

Prepared on a fresh fetched origin/main at 63e24ea in an isolated managed worktree, preserving the unfinished core branch. Marker 14 remains inactive. Fresh independent SELECT-only acceptance proves every row in all 19 prerequisite tables unchanged. Implementation/actual reader tests, full quality checks and reviewed deployment remain pending.

## Outcome and remaining work

Active. Finish this prerequisite, independently accept unchanged data, then rebase and release the complete native ledger. Continue the unbounded normalization goal.

Local verification: the new actual PostgreSQL reader case exercises ten direct/configured/source paths after marker 14 and proves no financial SQL/SDK fallback or data mutation; ordinary pre-activation feed/detail/source reads remain exact. All 550 workspace tests pass across 82 files (including 288 API cases), all workspace typechecks pass, 20 Python deployment/recovery cases pass and full synthesis preserves all 15 protected data/identity/network definitions. An existing SQL-failure fixture needed to let the new metadata guard read succeed before injecting financial SQL failure; the test still proves the original error propagates and only one financial feed query is attempted. No application behavior was weakened to satisfy it. Production marker 14 remains absent and all 19 prerequisite tables match the accepted private baseline. Next PR/quality/CLEAN-MERGEABLE/linear merge/deploy-production and post-smoke SELECT-only acceptance.
