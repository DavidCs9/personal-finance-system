# Routine SQL deployment cleanup — 2026-10-01

## Objective and completion criteria

Remove completed cutover steps from routine deployment, keep one complete SQL verification pass, update current operating instructions, and deliver through PR/quality/linear merge/deploy-production. Preserve DynamoDB, its dated backup/PITR, native SQL backups and the working application adapter.

## Constraints

David explicitly authorized the proposed small cleanup. Olbia remains his personal system. No local release, source mutation, authority transition or resource removal. Use the attached isolated worktree; preserve the original checkout's three guidance edits. AWS diagnosis uses default/codex-local-admin/us-east-2 with STS immediately before each production operation, as explicitly instructed in this conversation.

## Progress and next steps

Fetched origin/main and created codex/dsql-deployment-cleanup directly from 1baea36f27919855c177c1cb0957dce7744bc54c. Confirmed completed cutover and subsequent UI capture MOCK-01 in SQL, absent from DynamoDB. Removed all three cutover-script calls and the duplicate verification step from routine deployments. The single gate checks SQL authority first and never invokes pause/activation/backup actions. Local shell/failure-path checks passed; reviewing the diff, then required quality and actual production verification.

## Decisions

### D1 — Keep one complete SQL verification gate

- Context: The completed cutover pipeline still contains pause/source-backup/SQL-backup/activation calls and two full verification passes. David is concerned about a 22-minute run.
- Evidence: Workflow 36946527155 took 86 seconds for quality and 1,274 seconds for deployment. Initial historical gate 422 seconds; final SQL gate 256 seconds; SQL backup/activation 380 seconds; pause 64 seconds. Routine runs already skip the actual backup/pause in SQL mode, but still repeat the full gate.
- Alternatives: Retain both passes; weaken routine coverage to a small smoke; or remove completed transition steps while preserving one full SQL envelope/relational, financial/public/evidence and rolled-back write gate.
- Decision and reason: Use one full gate. Check persisted authority is SQL before starting verification, so unexpected authority fails visibly without copying DynamoDB into SQL or activating anything. Use an explicit sql execution name; retain native recovery infrastructure and historical cutover script/tests for the recorded migration.
- Consequences and verification: Expected complete workflow about 7–9 minutes based on measured steps, with deployment variability. Required quality remains intact. Test SQL success and unexpected-authority, native invocation, reconciliation, read-gate and write-smoke failures. Measure actual production result rather than claim the estimate as delivered performance.
- Status: provisional.

## Verification results

Baseline measured from native GitHub job timestamps; no production financial data changed. All 20 Python recovery/cutover/routine-verification tests passed, including six new real-shell tests for SQL success and failure containment. Shell syntax and diff checks passed. Full required quality and production verification remain pending.

## Outcome and remaining work

Cleanup, focused verification, PR quality/merge and successful production workflow remain.
