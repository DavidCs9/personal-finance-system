# Pragmatic SQL write cutover — 2026-10-01

## Objective and completion criteria

Complete SQL writer/authoritative-consumer implementation, then one coordinated production cutover through PR/quality/deploy-production. Keep the existing DynamoDB table and a dated native backup; use native DSQL backup. Verify retained data, financial/evidence behavior and meaningful write/transaction invariants. Preserve S3, Cognito and AgentCore native services.

## Constraints and explicit revised authorization

David authorized the pragmatic cutover on 2026-10-01: he can pause purchases/add later and accepts losing up to one day of events. This supersedes previous requirements for continuously mirrored writes and immediate lossless SQL→DDB rollback. No continuous reverse replication, dual authority or per-family shadow/promotion cycles. A pause and manual recovery are acceptable; the accepted event gap does not authorize loss of retained historical data or broken financial algorithms. Do not erase/replace DynamoDB or modify unrelated original-checkout guidance edits. Production code only PR → quality → CLEAN/MERGEABLE → linear squash/rebase merge → deploy-production. Default IAM account 225989371926/codex-local-admin/us-east-2, STS immediately before production operations; no credentials in Git/chat/logs.

## Progress and next steps

Reused clean attached worktree, fetched origin/main and started codex/dsql-write-cutover directly from refreshed main. Read autonomous/product/UI and applicable AWS skills. Inventorying all domain writer/query command shapes, runtime clients, retry dispatch and deployment gating before selecting the smallest implementation.

## Decisions

### D1 — Accept a bounded pause and non-instant rollback
- Context: Continuous SQL→DDB CDC/recovery would add infrastructure and operating burden for one user's small system.
- Evidence and uncertainty: David explicitly accepts up to one day of missed events, can pause shopping and add events later. All retained families are already projected and independently verified. Retaining DynamoDB preserves pre-cutover content, not new acknowledged SQL writes.
- Alternatives: Maintain continuous reverse replication and a synchronization barrier; or retain dated backups and accept pause/manual recovery after a SQL issue.
- Decision and reason: Use the latter as explicitly authorized. Preserve DynamoDB and take a native backup before activation. Implement all remaining SQL writers, coordinate one cutover and stop source projector/reconciliation before SQL authority. Keep scheduled side effects paused during the transition.
- Consequences and verification: Pre-cutover retained parity and post-cutover SQL/write/financial verification remain required. Fix forward in SQL; reverting can lose the accepted one-day event window or require a deliberate copy-back. No ongoing reverse replication framework.
- Status: approved by explicit user direction; implementation verification pending.

## Verification results

Previous operational phase: shadow #164, guarded #165 and evidence #166 merged; schema/transformer 4, bootstrap 7; zero mismatches across all retained operational/financial/evidence gates. Original checkout has exactly AGENTS.md, docs/dsql-migration-plan.md and docs/dsql-migration-runbook.md modified and preserved.

## Outcome and remaining work

SQL write implementation, local/native verification, native backup, coordinated cutover and final evidence remain.

### D2 — Preserve existing workflows through a bounded SQL document store
- Context: Roughly two hundred existing command call sites encode proven financial/ingestion/audit behavior. Rewriting each domain workflow and re-running separate promotions would lengthen this personal migration.
- Evidence and native gap: Native DSQL provides PostgreSQL JSONB, ACID/OCC, IAM and transaction retries. DynamoDB SDK commands cannot execute against DSQL; a native ORM does not translate their existing conditions/updates. Existing projection_state already retains exact original envelopes and keys, alongside relational query tables. Inspected command inventory uses Get/Put/Update/Delete/Query/Scan/BatchGet/TransactWrite and a small expression subset.
- Alternatives: Rewrite every repository function; introduce a general DynamoDB emulation service; or an Olbia-only in-process command adapter that fails closed on unsupported expressions and updates current envelopes plus relational rows atomically.
- Decision: Use the bounded adapter over existing native driver/JSONB/transactions. projection_state becomes the authoritative SQL envelope ledger after activation. Reuse projectRows to maintain relational tables within the same transaction, without asynchronous SQL self-replication. Preserve SDK-shaped results/errors only for the commands actually used here. No general customer/storage framework, new server or ORM.
- Verification: Exercise all inspected expression forms, atomic cancellation/idempotent retry, OCC collisions, deletes/recreation, real retained replay and all existing domain tests. Native rolled-back real-record smoke before activation. Keep individual movement revision and card/wealth read-write sequences in one SQL transaction where necessary.
- Status: provisional.

### D3 — One deployed authority switch and native backup
- Context: Lambda updates are gradual; switching each function's environment independently could mix SQL/DDB authority during a rollout.
- Decision: Deploy all runtimes with one persisted SQL authority flag initially DynamoDB. A deployed operator capability can pause mutations; the approved cutover workflow backs up, disables old capture/stream retry dependencies, runs final reconciliation and verification, then activates SQL once. Every application command checks authority; SQL mutations depend transactionally on the authority row. SQL mode never falls back to DDB. Product roles cannot change the flag.
- Native preference: AWS Backup provides DSQL full-cluster backups and schedules; use it directly. Retain native DDB backup/table. Replace stream-only retry dispatch with the existing SQS queue, retaining queued jobs and recovery.
- Verification: Read-only/paused behavior, stale invocation barrier, role grants, native backup completion and final historical parity before activation; full SQL verification after activation. Side-effecting workers skip while paused. Accepted event gap is bounded by David's explicit one-day tolerance; never claim transparent lossless rollback.
- Status: provisional.

### Implementation checkpoint

Implemented the bounded native SQL store, exact retained-envelope updates with changed-row relational maintenance, conditions/updates, transactional claims, ten-minute bulk-token receipts and same-transaction domain audit chains. Routed all deployed document-client factories; product SQL mode never falls back. Added schema 5/bootstrap 8 authority/control grants, IAM-only pause/activation/rolled-back real-record smoke, native seven-day daily SQL backups, CI-only dated DDB backup/final sync/activation workflow and SQL retry/TTL recovery using existing dispatcher/SQS. SQL-authoritative maintenance only verifies envelopes/relational tables; stale stream/replay cannot rewrite them. The cutover revision removes source-write IAM grants and disables source capture/schedules. Retired direct DDB mutation scripts; original checkout edits preserved.

Local complete suite passed 446 tests before the additional authority-permission test; focused ledger passed all 82 tests afterward (447 total expected), nine recovery tests passed, all workspace checks passed, web build/synth passed. SQL transactional/condition/pagination/token/audit rollback tests and SQL-only stale-delivery/reconciliation proof passed. Current rollout remains SQL_AUTHORITY=false, so this implementation cannot activate writes. Native deployed gates and approved cutover remain pending. D2/D3 remain provisional until native verification; no production actions in this implementation checkpoint.


### Implementation PR delivery and cutover preparation

[PR #167](https://github.com/DavidCs9/personal-finance-system/pull/167) passed quality/CLEAN/MERGEABLE and was squash merged as 227cad2116a18ed10222eb7eb291bf78d8501ab2. Production [workflow 36942976797](https://github.com/DavidCs9/personal-finance-system/actions/runs/36942976797) is running. Private local replay exercised all 2,430 retained real envelopes through SQL Put/Update/remove/Get and complete relational parity: zero unsupported families, zero mismatches. No source payloads committed. Nine protected definitions preserve identities/settings; retry mapping only adds explicit Enabled=true, and encryption policy adds native backup role access without replacing the key.

Cutover branch starts directly from refreshed origin/main. Preparing SQL_AUTHORITY=true, but do not merge/publish activation until implementation deployment, historical/read gates and native rolled-back write smoke pass. Original checkout still has exactly its three unrelated guidance edits.

Cutover review caught two supplemental legacy DynamoDB write grants (API and AgentCore mutation target) beyond grantReadWriteData; the cutover removes both. The AgentCore mutation target needs the SQL application writer role, while the aggregation tools/probe remain envelope readers. This correction is part of the coordinated cutover bootstrap and no SQL writes were active beforehand. Template checks cover all 13 writer identities, source mapping/schedule disablement and seven protected data/queue definitions.

### Native implementation acceptance and approved cutover

Implementation [workflow 36942976797](https://github.com/DavidCs9/personal-finance-system/actions/runs/36942976797) completed successfully. Reconciliation projected/compared 4,890 keys: zero lag/mismatch. Independent reads/evidence and native rolled-back real-record SQL create/update/delete/recreation/cancellation/parity smoke passed. Schema versions 1–5; product cannot change authority; probe is SELECT-only; one operator identity controls activation. Native backup supports DSQL in us-east-2; daily cron at 08:00 UTC retains seven days. All 16 enabled runtimes updated successfully, seven protected data/queue definitions equal, source mappings Enabled, eight alarms OK, authority still DynamoDB.

[PR #168](https://github.com/DavidCs9/personal-finance-system/pull/168) passed required quality/CLEAN/MERGEABLE and was squash merged at 2026-10-02T00:05:23Z (2026-10-01 local) as 43c6e42c87771c3052553b830bbedef18d5fb1c7. [Cutover workflow 36944213554](https://github.com/DavidCs9/personal-finance-system/actions/runs/36944213554) is running. SQL activation/final backups/post-cutover verification remain pending. Evidence branch starts directly from refreshed origin/main; no manual release or source-data mutation.

Implementation gate details: 496 movements/details; 19 original CFDI XMLs; 149 Patrimonio evidence hashes; six plans; 13 effective categories, 174 merchant rules, three cards; 656 operational envelopes; zero mismatches in all independent financial/operational/public-response gates. Complete gate 114,669 ms. Native write smoke returned verified=true/rolledBack=true. Private safe gate captures are under /tmp/olbia-dsql-operational; no financial payloads added to Git.

### D4 — Bootstrap native encrypted-backup permission without a local release
- Context: Cutover workflow 36944213554 paused writers successfully, then stopped before CloudFormation because native CreateBackup requires kms:Decrypt on the existing encryption key. The deployment role had the new DDB backup permission but lacked this key permission. No backup or SQL activation occurred; the deployed implementation and retained data remain intact, authority paused.
- Evidence: Native AccessDeniedException specifically names kms:Decrypt on the existing data key and the Actions deployment role. First implementation historical/read/native-write gates passed; DynamoDB/S3/cluster/PITR definitions remain unchanged.
- Alternatives: Manually modify IAM (forbidden by repository release rules); deploy an additional preliminary flag-disabled permission rollout; or keep pre-deploy pause and take the DDB backup immediately after the reviewed infrastructure update, before final reconciliation/activation.
- Decision: Add only existing-key decrypt to the deployment role through PR. Split the CI pause and DDB backup into pre-/post-deploy stages. The infrastructure update retains every source data definition and removes application DDB writes; it does not modify financial records. The dated native DDB backup remains mandatory before historical sync and SQL activation. This avoids another migration promotion cycle and a local permission shortcut.
- Verification: Required quality and reviewed synth; source definitions unchanged, scoped key grant present, mode paused, DDB backup AVAILABLE, final historical/read gate, SQL native backup COMPLETED, native rolled-back smoke, activation and post-SQL gate. Native backup failure keeps authority paused.
- Status: provisional; implementing the reviewed fix and resuming the paused cutover.


### Reviewed backup fix delivery

[PR #169](https://github.com/DavidCs9/personal-finance-system/pull/169) passed required quality/CLEAN/MERGEABLE and was squash merged as ee868546b0147f184560695a76b696f4aff2ae8e at 2026-10-02T00:17:05Z (2026-10-01 local). [Resumed production workflow 36945212405](https://github.com/DavidCs9/personal-finance-system/actions/runs/36945212405) owns deployment and native backups. Fourteen Python recovery/cutover tests pass, including pre-deploy pause without backup, required post-deploy source backup, SQL backup/smoke before activation, failure containment and preservation of established SQL authority. Synth confirms decrypt is scoped only to the existing data key. Authority remains paused pending deployment, backups and final verification; no local release/IAM change occurred.

### D5 — Complete native encrypted-backup permissions
- Context/evidence: Workflow 36945212405 successfully deployed the cutover configuration and scoped decrypt policy, then stopped at native source backup because GenerateDataKey was also required. Authority remains paused; no SQL activation or backup occurred. Both source mappings are disabled and source-write policies removed by the approved stack, so the retained financial source is stable.
- Native documentation: [AWS Backup encryption](https://docs.aws.amazon.com/aws-backup/latest/devguide/encryption.html) explicitly requires both kms:Decrypt and kms:GenerateDataKey for encrypted DynamoDB backup. The first fix matched the first reported denial rather than verifying the complete native requirement.
- Alternatives: Add only another action; use CDK's native grantEncryptDecrypt on the existing key; or manually change IAM (forbidden).
- Decision/reason: Use the standard native CDK encrypted-key grant on the single existing key, with a regression assertion covering both required permissions and that resource scope. Preserve the corrected pause/deploy/backup/final-sync ordering. No key replacement, direct source mutation or local IAM release.
- Verification: Required quality, static native grant/resource assertions, deployed source backup AVAILABLE, SQL backup COMPLETED and full before/after activation gates. Keep the pause on failure.
- Status: provisional. D4's decrypt-only permission is superseded; its reviewed ordering correction remains valid.
