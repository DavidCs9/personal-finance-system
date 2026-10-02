# Routine SQL deployment cleanup — 2026-10-01

## Objective and completion criteria

Remove completed cutover steps from routine deployment, keep one complete SQL verification pass, update current operating instructions, and deliver through PR/quality/linear merge/deploy-production. Preserve DynamoDB, its dated backup/PITR, native SQL backups and the working application adapter.

## Constraints

David explicitly authorized the proposed small cleanup. Olbia remains his personal system. No local release, source mutation, authority transition or resource removal. Use the attached isolated worktree; preserve the original checkout's three guidance edits. AWS diagnosis uses default/codex-local-admin/us-east-2 with STS immediately before each production operation, as explicitly instructed in this conversation.

## Progress and next steps

Fetched origin/main and created codex/dsql-deployment-cleanup directly from 1baea36f27919855c177c1cb0957dce7744bc54c. Confirmed completed cutover and subsequent UI capture MOCK-01 in SQL, absent from DynamoDB. Removed all three cutover-script calls and the duplicate verification step from routine deployments. The single gate checks SQL authority first and never invokes pause/activation/backup actions. Local checks and required quality passed. [PR #172](https://github.com/DavidCs9/personal-finance-system/pull/172) was CLEAN/MERGEABLE and squash merged as 21aea94b4553cccc84cf70e10a1a8130fec50c1a. [Production workflow 36960441683](https://github.com/DavidCs9/personal-finance-system/actions/runs/36960441683) completed successfully with one verification pass. Actual acceptance and timing are recorded below.

## Decisions

### D1 — Keep one complete SQL verification gate

- Context: The completed cutover pipeline still contains pause/source-backup/SQL-backup/activation calls and two full verification passes. David is concerned about a 22-minute run.
- Evidence: Workflow 36946527155 took 86 seconds for quality and 1,274 seconds for deployment. Initial historical gate 422 seconds; final SQL gate 256 seconds; SQL backup/activation 380 seconds; pause 64 seconds. Routine runs already skip the actual backup/pause in SQL mode, but still repeat the full gate.
- Alternatives: Retain both passes; weaken routine coverage to a small smoke; or remove completed transition steps while preserving one full SQL envelope/relational, financial/public/evidence and rolled-back write gate.
- Decision and reason: Use one full gate. Check persisted authority is SQL before starting verification, so unexpected authority fails visibly without copying DynamoDB into SQL or activating anything. Use an explicit sql execution name; retain native recovery infrastructure and historical cutover script/tests for the recorded migration.
- Consequences and verification: Expected complete workflow about 7–9 minutes based on measured steps, with deployment variability. Required quality remains intact. Test SQL success and unexpected-authority, native invocation, reconciliation, read-gate and write-smoke failures. Measure actual production result rather than claim the estimate as delivered performance.
- Status: validated by focused failure tests, required quality, native production gates and measured timing.

## Verification results

Baseline measured from native GitHub job timestamps; no production financial data changed. All 20 Python recovery/cutover/routine-verification tests passed, including six new real-shell tests for SQL success and failure containment. Shell syntax and diff checks passed. Required quality passed all 448 workspace tests and 20 Python tests, checks, web build and synth. Production verification passed: 4,910 comparisons, zero lag/mismatch, 499 movement details and all financial/public/original-evidence families; native write smoke verified=true/rolledBack=true. Complete run 7 minutes 56 seconds.

## Outcome and remaining work

Cleanup and required production acceptance are complete. Normal deployments now preserve SQL authority, perform one complete SQL verification pass and omit completed pause/source-backup/activation phases. DynamoDB, dated/native backups and the working SQL adapter remain retained. The final documentation evidence update records delivered results; no functional step remains.

### Native recovery and infrastructure checkpoint

Read-only diagnosis during workflow 36960441683 confirms SQL authority, 16 healthy store runtimes, both source stream mappings Disabled and eight migration alarms OK. All 329 deployed resource definitions exactly match the post-cutover template, including DynamoDB/encryption/PITR, S3 evidence, the cluster and native backup vault/role/plan/selection. The dated DynamoDB backup remains AVAILABLE and the completed SQL backup remains COMPLETED. No local release, source-data edit or authority change occurred. Production's one SQL verification pass is running; its final result and timing remain pending.

### Final production acceptance and measured timing

[Workflow 36960441683](https://github.com/DavidCs9/personal-finance-system/actions/runs/36960441683) completed successfully at 21:38:03 local on 2026-10-01. Created-to-completion duration: **7 minutes 56 seconds**. Quality: 88 seconds; deploy-production: 383 seconds; the single SQL gate: 284 seconds. The earlier cutover workflow took 22 minutes 46 seconds end to end; this first cleaned run was 14 minutes 50 seconds shorter (about 65%). This compares a routine deployment with the completed one-time cutover, not identical workloads or a guaranteed time for every future CloudFormation change.

One SQL reconciliation execution completed with projected=0, equal=4,910, lag=0, mismatch=0. The independent probe verified 499 movements/details, financial/public contracts and retained original evidence with zero mismatches in 128,669 ms. The native real-record write smoke returned verified=true/rolledBack=true. No pause, backup-source or activation step ran. No DynamoDB record was modified, no test financial event committed, and SQL authority was preserved. All 448 workspace tests and 20 Python tests, checks, web build and synth passed in required quality.

Production definitions/recovery checkpoint above confirms all 329 resource definitions unchanged, eight migration alarms OK, dated DynamoDB backup AVAILABLE and completed SQL backup retained. Original checkout's three unrelated guidance edits remain preserved. Private native execution/log captures remain outside Git under /tmp/olbia-dsql-operational; only safe counts/timings are recorded here.
