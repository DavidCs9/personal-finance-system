# DSQL migration — 2026-09-30 (America/Chihuahua)

## Objective and completion criteria

Implement the planned DSQL coexistence delivery end to end and leave a PR ready to merge: regional cluster, schema/IAM bootstrap, continuous projection, historical reconciliation, recovery, parity verification, tests, and an operational runbook. Confirm required `quality`, `CLEAN`, and `MERGEABLE` before closing the run. Do not merge or manually deploy.

## Constraints

Follow `AGENTS.md`, the product north star, and `docs/dsql-migration-plan.md`. David Castro is the sole owner. Preserve DynamoDB's existing identity, data, indexes, stream, encryption, TTL, PITR and retention. Product writes/reads, dedupe, reconciliation and notifications continue using DDB. Production code deploys only through the approved PR/main/`deploy-production` workflow. Real-data validation is welcome; this cloud session has no AWS identity or secrets configured. No UI changes or primary-database cutover are included in this coexistence delivery.

The initial base was `0141593`. The final fetch brought in `dbdbddb` (#144), which introduced `AUTONOMOUS_RUN_RULES.md` while this run was underway. This record was created immediately after reading those new rules. D1–D6 reconstruct earlier decisions from the implementation and commentary and revalidate them; they were not recorded before implementation. Subsequent decisions/checkpoints are recorded as they occur.

## Progress and next steps

- Implemented cluster, retained/private recovery, schema and runtime SQL role, native async indexes, gated mapping, replay and resumable/daily reconciliation.
- Covered movements, observations, revisions, categories/rules, card profiles, tags and MSI. Preserved source envelopes, existing IDs, evidence, states, amounts and day/instant precision.
- Added automatic post-deploy verification through the existing Actions role and deployment job; only verification counters appear in public logs.
- Completed a clean `npm ci`, 370 tests, ledger/web/infra type checks, web build, synth and shell/diff validation. Final infrastructure tests also passed after adding the SNS resource policy.
- Rebased onto current `origin/main` without conflicts. Next: publish this record with the PR, wait for required CI, inspect review/mergeability and close the record.

## Decisions

### D1 — Coexistence scope and production activation

- Context: “End to end” must provide a usable migration delivery without prematurely changing the database that determines financial acceptance.
- Evidence and uncertainty: The migration plan explicitly recommends capturing/projecting while DDB remains authoritative; read promotion needs parity and write promotion is a later decision. AWS is not configured in this session.
- Alternatives and tradeoffs: Deliver only a plan (insufficient); implement the coexistence path including recovery/backfill/verification; also cut over product reads/writes before production parity (would violate the plan's integrity gates).
- Decision and reason: Deliver the full coexistence path as a merge-ready PR, with real-engine checks in the approved deployment workflow. Keep product authority in DDB.
- Consequences, verification, and revisit conditions: No claim that SQL is already active. Deployment, stream evidence and zero-discrepancy historical checks are required before later promotion. Primary-database migration remains a later phase.
- Status: Validated against current plan and repository constraints; productive activation remains pending merge/deployment.

### D2 — Ordering without source versions

- Context: Writers do not share a monotonic revision, and replay/backfill must never restore stale edits or deleted items.
- Evidence and uncertainty: Inspected all relevant key patterns and mutation/capture/import writers. Native DSQL snapshot isolation/OCC rejects concurrent writes to the same checkpoint; DDB supports consistent GetItem. Sequence numbers are not global versions.
- Alternatives and tradeoffs: Add versions to every writer (larger intrusive change); order by timestamp/shard sequence (unsafe across bootstrap/shards); read SQL first, then current DDB, and always write a per-key checkpoint in the same transaction as the projection.
- Decision and reason: Use the final protocol with official connector retries. The only extra SQL retry handles a first-insert `23505` on `projection_state_pkey`, which the connector's OCC classification does not cover.
- Consequences, verification, and revisit conditions: Additional source reads and checkpoint writes. Older workers conflict and re-read; tombstones and recreation converge to current state. Forced interleavings test first/existing checkpoints and deletion during backfill. Real-engine behavior is verified after deployment.
- Status: Validated locally with PostgreSQL SQL tests, an OCC model and the actual connector callback retry path; real DSQL execution pending deployment.

### D3 — Historical discovery and missed deletions

- Context: Snapshot images cannot be compared to newer source versions because those versions do not exist.
- Evidence and uncertainty: This is a personal system. Production cardinality was not measured because no AWS identity is attached. PITR export/native DSQL loader cannot supply transformation or comparable modification versions.
- Alternatives and tradeoffs: Import raw PITR images (unsafe); use export only for discovery (adds resources/jobs); paginate a keys-only scan and re-read live source inside each SQL transaction, then scan target checkpoints for deletions.
- Decision and reason: Use the bounded keys-only scan for this personal volume; no snapshot content is written directly to SQL. Step Functions stores cursors, retries pages, and verifies both sides. Include defaults from the shared domain.
- Consequences, verification, and revisit conditions: Higher read cost than bulk loading, no global snapshot, and a four-hour native job bound. Verify every row/envelope/relationship and bank/Mi parte totals by month/currency; classify source activity as lag. If cardinality/cost grows, use PITR export to enumerate keys while retaining the safe write protocol.
- Status: Validated with multi-page historical load, missed deletion repair and parity tests; volume/cost assumption remains provisional until deployment.

### D4 — Native failure recovery and retention gaps

- Context: Streams retains only 24 hours; partial batch failures must survive expiry and a prolonged invocation outage must be repairable.
- Evidence and uncertainty: Native S3 destinations retain the full batch in the documented escaped `payload` field. SQS/SNS metadata destinations do not retain equivalent content. Destination retention does not archive events Lambda never fetched.
- Alternatives and tradeoffs: Add a custom archive/outbox/Kinesis for all changes; use native Streams retries, S3 failures, replay and a daily two-sided reconstruction.
- Decision and reason: Choose native retention/failure capabilities plus current-state reconciliation, proportional to the existing personal system. Preserve recovery objects and report versions.
- Consequences, verification, and revisit conditions: Lost intermediate mutations during a retention gap cannot be reconstructed unless source observations/revisions still retain them. Block read promotion across any gap. Monitor native age, failure and delivery metrics; reconsider Kinesis only for a concrete retention requirement.
- Status: Validated locally for retained-payload replay and deletion repair; operational alarms and SNS confirmation pending deployment.

### D5 — Bootstrap privileges and relational dependencies

- Context: CloudFormation provisions a cluster but has no native SQL-schema/IAM association resource. Multi-item source changes can arrive independently.
- Evidence and uncertainty: Verified official CloudFormation, SQL, roles, types and async-index documentation. Runtime does not need admin privileges. Existing financial identities cannot be invented to satisfy relational constraints.
- Alternatives and tradeoffs: Permanent admin runtime access (too broad); standalone manual SQL bootstrap (outside approved rollout); scoped deployment-only Provider plus a non-admin SQL role. Add FKs now (arrival-order risk) or preserve independent entity convergence first.
- Decision and reason: Use additive/resumable bootstrap and explicit IAM-role association, native async indexes and a non-admin smoke before mapping activation. Omit FKs until dependency ordering is solved. Delete never drops data.
- Consequences, verification, and revisit conditions: Runtime roles can modify only projection tables and cannot mutate DDB. SQL coexistence does not promise source multi-item atomicity. Future schema migrations must add explicit DDL and increment bootstrap version; real IAM/schema checks gate activation.
- Status: Validated by synth, infrastructure IAM/dependency/retention checks and SQL tests; real-engine bootstrap pending deployment.

### D6 — Keep private data out of public verification logs

- Context: The repository is public; using David's real data for validation does not authorize publishing it.
- Evidence and uncertainty: Driver errors may contain failing values. Parity reports contain monthly/currency totals. Native logs/metrics already expose infrastructure failures.
- Alternatives and tradeoffs: Print raw failures/aggregates for convenience; keep encrypted reports in AWS and print only codes and verification counters.
- Decision and reason: Keep source payloads and totals in private DSQL/S3/Step Functions, suppress unsafe driver logging, sanitize uncaught maintenance failures, and omit financial aggregates from Actions output.
- Consequences, verification, and revisit conditions: Operators diagnose using retained private execution reports and native metrics. Tests verify reports omit raw movement payloads and public-path failures do not expose driver detail.
- Status: Validated locally; production IAM/access remains part of deployment verification.

### D7 — Adopt the newly available autonomous rules before PR publication

- Context: The final rebase brought new run-record rules from main after the implementation was already prepared.
- Evidence and uncertainty: Verified #144 adds only `AGENTS.md` guidance and `AUTONOMOUS_RUN_RULES.md`; no code or schema changed during rebase.
- Alternatives and tradeoffs: Stop despite completed authorized work; omit the new record; document the timing, reconstruct/revalidate prior choices, then continue with the new rules.
- Decision and reason: Create this record before PR creation, preserve the new guidance, and continue verification/closure. Do not pretend the earlier decisions were written contemporaneously.
- Consequences, verification, and revisit conditions: Include this record in the PR and link it in the final handoff. Update status at CI/review checkpoints and keep prior decisions intact.
- Status: Validated; record created and attached to the implementation.

## Verification results

- Clean dependency installation: `npm ci` passed.
- Required tests: 370 passed across web/domain/ingestion/API/ledger/notify/infrastructure, including 18 new migration tests.
- Type checks: ledger, web and infrastructure passed.
- Web production build and CDK synth passed; existing unrelated CDK deprecation warnings remain.
- Infrastructure safety test: source table before/after unchanged; runtime has no DDB mutations, no SQL admin and no recovery deletion; mapping waits for bootstrap; alarm actions/topic policy are present.
- Full-stack template comparison against initial main template: `MetadataTable30E05F1F` and all three existing Lambda event-source mappings exactly unchanged. Table JSON SHA-256: `fba364d225dd458f3076df9e15961f2725ac20106381eec122fd05cc7780220c`.
- `git diff --check` and `bash -n infrastructure/scripts/verify-dsql-deployment.sh` passed.
- Production data, DSQL engine and IAM have not been inspected/executed from this session. Bootstrap and post-deploy job are the approved real-engine checks.
- Required remote `quality` and final PR mergeability: pending PR publication and CI.

## Outcome and remaining work

Implementation and local verification complete. The PR must still pass remote `quality` and show `CLEAN`/`MERGEABLE` before the merge-ready handoff. No manual deployment or merge occurred. After an approved merge: confirm SNS subscription, inspect real-engine bootstrap and historical job, verify normal stream-delivered operations, then decide the later read-promotion phase described in the migration plan. See [runbook](../dsql-migration-runbook.md).
