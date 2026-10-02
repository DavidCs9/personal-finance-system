# Pragmatic SQL write cutover

David approved a short coordinated pause and accepts up to one day of missed events, which he can add later. DynamoDB remains retained with PITR and a dated native backup. This supersedes the earlier continuous reverse-replication and lossless immediate rollback prerequisites. Historical financial records, original evidence and audit correctness remain required.

The implementation PR deployed all writers with SQL authority initially `dynamodb`. The cutover revision changed `infrastructure/lib/storage-cutover.ts` to `SQL_AUTHORITY = true`; persisted authority is now `sql`. All deliveries used PR → required quality → CLEAN/MERGEABLE → squash merge → deploy-production. No local release.

The existing native SQL envelope ledger (`projection_state.source_item`) becomes authoritative. Olbia's bounded adapter preserves existing SDK command conditions/updates and financial workflows, fails closed for unsupported commands/families, and commits derived relational rows in the same transaction. Native transactions/OCC protect claims and audit chains. A single owner barrier serializes writes and authority changes; product identities cannot change authority. Bulk command receipts preserve the existing ten-minute token idempotence contract. Changed-row updates avoid rewriting unchanged MSI schedules.

There is no native DSQL translation for DynamoDB document commands or DynamoDB TTL. The small local adapter covers only inspected Olbia commands. The existing retry dispatcher runs every minute in SQL mode, sends durable pending retries to native SQS, and removes only expired top-level `expiresAt` records. Nested preview expiration stays audit data. Native AgentCore memory remains responsible for assistant content retention. S3 evidence, Cognito, SQS and other native integrations remain in place.

## Verified production state — 2026-10-01

[Production workflow 36946527155](https://github.com/DavidCs9/personal-finance-system/actions/runs/36946527155) completed successfully. SQL now owns application reads, writes and authoritative consumers. Both final historical and post-activation envelope/relational passes checked 4,890 comparisons with zero lag and zero mismatches. Independent financial, operational, public-read and original-evidence gates passed before and after activation, alongside native rolled-back real-record write/conditional/transaction checks. No test financial event was committed.

The dated DynamoDB backup `olbia-pre-sql-36946527155-1` is AVAILABLE. Native DSQL backup job `87c93164-16f3-454d-b143-4951df5724ac` COMPLETED at 18:51:05 local; daily native backups have seven-day retention. DynamoDB remains retained with PITR; original S3 evidence remains intact. All 16 SQL-enabled runtimes updated successfully, source stream mappings are disabled, and all eight migration alarms are OK. Schema is 5, transformer 4, bootstrap 8.

Normal usage can resume. Events missed during the accepted pause may be added later through authenticated Olbia operations. Frozen DynamoDB does not contain new SQL writes, so it is not an immediate lossless rollback target. See the [run record](autonomous-runs/2026-10-01-dsql-write-cutover.md) for test evidence, deployment links and the two native backup-permission failures resolved through reviewed PRs.

## Coordinated workflow

1. Invoke the already-deployed authority operator to pause mutations; allow in-flight native requests to finish. Reads remain available, queued ingestion retries, and scheduled external side effects fail before starting while paused.
2. Deploy the approved cutover revision: disable the DynamoDB projector mapping/daily reconciliation schedule and stream retry mapping, enable scheduled SQL retry recovery, remove application DynamoDB write grants, and allow SQL activation on the internal operator.
3. Take a dated native DynamoDB backup using the reviewed deployment role’s scoped encryption-key permission, then run final historical reconciliation and independent financial, operational, public-read and original-evidence gates while paused. Verify real native SQL create/update/delete/recreation/conditional cancellation using a retained record in an explicitly rolled-back transaction.
4. Complete an on-demand native AWS Backup of the final SQL cluster, then activate the single persisted SQL flag. Subsequent deployments preserve SQL authority.
5. Repeat independent reads and envelope/relational verification against authoritative SQL. SQL reads and writes never fall back to frozen DynamoDB; stale stream/replay reconciliation cannot overwrite SQL after activation. Scheduled native SQL backups have seven-day retention.

Failures before activation leave the last confirmed authority in place, usually paused. Inspect the deployed workflow and retained reconciliation report, fix through another PR, then resume. Retained DynamoDB is a pre-cutover recovery source, not a live mirror of new SQL writes. Prefer fixing SQL forward or restoring native SQL backup to a new cluster through the normal reviewed deployment workflow. A deliberate return to DynamoDB needs a reviewed authority transition and acceptance of the agreed event gap or an auditable copy-back; flipping an old environment flag cannot change authority. Do not delete DynamoDB.

Legacy scripts that directly mutated DynamoDB are retired. Use already-deployed authenticated Olbia API operations for financial corrections so SQL authority and audit history are preserved.
