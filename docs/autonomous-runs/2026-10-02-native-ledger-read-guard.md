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

Local verification: the new actual PostgreSQL reader case exercises ten direct/configured/source paths after marker 14 and proves no financial SQL/SDK fallback or data mutation; ordinary pre-activation feed/detail/source reads remain exact. The initial full run passed 549 of 550 cases; one existing SQL-failure fixture remains under correction before the suite can be claimed passing, all workspace typechecks pass, 20 Python deployment/recovery cases pass and full synthesis preserves all 15 protected data/identity/network definitions. An existing SQL-failure fixture needed to let the new metadata guard read succeed before injecting financial SQL failure; the first correction still failed because a parallel category failure returned before the financial availability check completed. The fixture now selects actual SQL authority and injects only the financial query failure, so the assertion waits for the intended failure. Validation of that correction is pending. No application behavior was weakened to satisfy it. Production marker 14 remains absent and all 19 prerequisite tables match the accepted private baseline. Next PR/quality/CLEAN-MERGEABLE/linear merge/deploy-production and post-smoke SELECT-only acceptance.

Final local correction accepted: all 13 affected domain/financial-reader cases pass, including the original financial failure/single-query assertions under actual SQL authority. Combined with the preceding full run's unchanged passing cases, all 550 workspace tests are verified. API typecheck after the correction also passes. The guard's full synthesis is deployable, all 15 protected definitions are unchanged, and no cyclic ordering is included. The earlier prematurely stated suite result is corrected above. PR and required remote quality are next.


PR [#188](https://github.com/DavidCs9/personal-finance-system/pull/188) passed required quality in 37071700909 (all 550 cases remotely), was CLEAN/MERGEABLE and squash-merged as `e0199a0be35bf3a8187a2e3568c048a57f367952`. Fresh immediate pre-merge acceptance preserved every row in all 19 tables with marker 14 absent. Production workflow 37071965530 is running. Deployed gates and independent post-smoke acceptance are still required before this prerequisite is complete.
