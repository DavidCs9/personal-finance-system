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
- Rebased onto current `origin/main` without conflicts. Published [PR #145](https://github.com/DavidCs9/personal-finance-system/pull/145). Required `quality` passed; GitHub reported `mergeable=true` and `mergeable_state=clean`. Review submissions and inline threads were empty at the closure checkpoint.

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
- Required tests: 370 passed across web/domain/ingestion/API/ledger/notify/infrastructure, including 20 new migration tests.
- Type checks: ledger, web and infrastructure passed.
- Web production build and CDK synth passed; existing unrelated CDK deprecation warnings remain.
- Infrastructure safety test: source table before/after unchanged; runtime has no DDB mutations, no SQL admin and no recovery deletion; mapping waits for bootstrap; alarm actions/topic policy are present.
- Full-stack template comparison against initial main template: `MetadataTable30E05F1F` and all three existing Lambda event-source mappings exactly unchanged. Table JSON SHA-256: `fba364d225dd458f3076df9e15961f2725ac20106381eec122fd05cc7780220c`.
- `git diff --check` and `bash -n infrastructure/scripts/verify-dsql-deployment.sh` passed.
- Production data, DSQL engine and IAM have not been inspected/executed from this session. Bootstrap and post-deploy job are the approved real-engine checks.
- Required remote `quality`: [Actions run 36790867536](https://github.com/DavidCs9/personal-finance-system/actions/runs/36790867536) passed all installation/tests/checks/build/synth steps on implementation head `71aa4c0be15d13a003819846d0d77b617a044681`. `deploy-production` was correctly skipped for the PR. GitHub confirmed `CLEAN` and `MERGEABLE`.
- This closing update changes only the run record. The latest-head result remains visible in [PR checks](https://github.com/DavidCs9/personal-finance-system/pull/145/checks) and is rechecked before the final handoff; no implementation changed after the successful validation above.

## Outcome and remaining work

Run complete for the requested merge-ready coexistence PR. Implementation, local verification and remote `quality` succeeded, and the PR was `CLEAN`/`MERGEABLE` at the recorded closure checkpoint. No manual deployment or merge occurred. After an approved merge: confirm SNS subscription, inspect real-engine bootstrap and historical job, verify normal stream-delivered operations, then decide the later read-promotion phase described in the migration plan. See [runbook](../dsql-migration-runbook.md).


## Resumed after deployment failure — 2026-09-30 (America/Chihuahua)

PR #145 merged as `e4154cb`. The approved production workflow [36793116033](https://github.com/DavidCs9/personal-finance-system/actions/runs/36793116033) failed at the bootstrap custom resource and completed rollback. The user supplied the failure log. No stream mapping was enabled. The cluster, recovery bucket and log groups were retained and detached. This supersedes the original closure's expectation of successful activation; the earlier code/CI results remain valid but did not prove real-engine compatibility.

### D8 — Bootstrap diagnosis without an attached AWS identity
- Context: The handler erased the underlying exception; the supplied logs only identify the bootstrap stage. A one-second failure suggests a deterministic connection/SQL/privilege issue, but the exact cause is unverified.
- Evidence and uncertainty: The session has no AWS credentials or TCP grants. The production deployment is the only authorized real-engine path. PostgreSQL tests do not validate DSQL-specific startup parameters or IAM associations.
- Alternatives and tradeoffs: Guess and blindly rerun; wait for AWS credentials; audit official DSQL and connector documentation, add safe stage/code diagnostics, and fix any confirmed incompatibilities in a reviewed corrective PR.
- Decision and reason: Use the documented audit and stage/code diagnostics while continuing independent recovery work. Preserve the bootstrap gate and avoid raw driver values/tokens in public logs.
- Consequences, verification, and revisit conditions: Real-engine verification remains the approved deployment gate. Record confirmed defects separately from hypotheses and test the corrected paths.
- Status: Provisional; investigation underway.

### D9 — Recover retained resources after failed creation
- Context: Retained, fixed-name Lambda log groups now collide with fresh creation; recreating the cluster/bucket would also leave duplicates.
- Evidence and uncertainty: CloudFormation explicitly reported DELETE_SKIPPED for these resources. Their physical identifiers are not available in the user log; stack-event history/native import can discover them during approved CI. Production DDB remains authoritative and unchanged.
- Alternatives and tradeoffs: Delete the retained resources (loses evidence and requires destructive access); rename new resources and leave orphans (duplicates/cost and repeated rollback problems); adopt the retained resources using native CloudFormation/CDK facilities in the approved deployment job.
- Decision and reason: Investigate native import/adoption and implement a bounded recovery path for the known failed rollout. Preserve existing data/evidence; future failures must remain recoverable through the same workflow.
- Consequences, verification, and revisit conditions: Recovery must fail closed for missing/ambiguous identities and never modify the source table. Verify import template isolation and resource identities before normal deployment.
- Status: Provisional; recovery design underway before implementation.


### D10 — Native index polling and safe bootstrap diagnostics
- Context: The audit found `SELECT sys.wait_for_job(...)` treating a DSQL procedure as a PostgreSQL function. Existing mocked tests accepted this invalid protocol. Startup `statement_timeout` is also an unnecessary wire-protocol dependency, although its role in this failure is unproven.
- Evidence and uncertainty: AWS async-index documentation calls `sys.wait_for_job` a procedure; AWS-maintained examples use `CALL` and a `succeeded` result. Native `sys.jobs` and `pg_index.indisvalid` provide documented status/readiness checks. DSQL catalog updates can return retryable OCC errors. Original exception remains unavailable.
- Alternatives and tradeoffs: Switch to CALL (simple but awkward interruption/resume); poll native catalog/job state (bounded, resumes builds with no new job ID); skip readiness (unsafe).
- Decision and reason: Poll readiness and native job failure with a bounded deadline, retry only native OCC classification on autocommit bootstrap statements, and label each failed stage with an allowlisted code. Use client query timeout rather than a server startup parameter; never print raw driver messages/details.
- Consequences, verification, and revisit conditions: Unit tests must model an already-running job, failed job, deadline and OCC. Handler tests must prove stage/code survive while secrets do not. Keep each DDL independently committed and the event mapping gated.
- Status: Provisional; documented protocol defect confirmed, exact production failure stage unverified.

### D11 — Native import isolated from the normal application update
- Context: Native CloudFormation import supports DSQL clusters, S3 buckets and Logs log groups, but disallows simultaneous changes to existing resources.
- Evidence and uncertainty: AWS resource support matrix lists import support for all three types. Existing GitHub role can assume CDK deployment and file-publishing roles; no new permissions need to be installed before recovery. Stack rollback events retain physical identifiers. No live AWS access is available locally.
- Alternatives and tradeoffs: Add a second recovery stack/custom resource framework; invoke CDK import against the whole modified application (would mix updates); build an isolated import template from the currently deployed template plus only matching retained DSQL resources.
- Decision and reason: The approved deploy-production job will run a narrow script using native AWS CLI APIs. It checks identity/status, discovers detached DELETE_SKIPPED resources from native stack events, adds only those definitions, preserves every existing resource/output/parameter, uploads the template through the existing CDK file-publishing role, previews an import-only change set, then imports before normal CDK deployment. No deletes or direct financial operations.
- Consequences, verification, and revisit conditions: Fail closed on ambiguous identifiers, unexpected resource types/dependencies or non-import changes. Reruns skip already-owned resources. Regression fixtures verify rollback recovery, no-op, identity mismatch and protection of the source table. Validate operationally after approved merge.
- Status: Provisional; implementation authorized through existing PR/main workflow.


### Corrective implementation checkpoint

- Fixed the confirmed function/procedure protocol error by polling native index status/readiness, including interrupted builds. Bootstrap retries only native OCC classifications, emits safe stage/code failures, and still gates capture. Removed the unnecessary server startup timeout in favor of a client query deadline. Bootstrap custom-resource version is now 2.
- Added import-only recovery inside deploy-production, using existing CDK roles and native stack-event identities. It validates native identifier schemas, preserves previous parameters, rejects non-import changes, verifies imported physical identities, and skips resources already owned. No additional IAM permissions or local production release.
- Validation: 377 Vitest tests and seven Python tests passed; ledger/web/infrastructure type checks, web build, CDK synth, workflow YAML parsing and diff checks passed. Actual full-stack recovery-template exercise imported exactly eight retained resources while keeping every existing resource unchanged. The source table and all three pre-existing event-source mappings still exactly match the pre-migration template.
- Remaining: publish corrective PR, await required quality and confirm CLEAN/MERGEABLE. AWS engine/IAM/import execution remains unverified locally because the session has no AWS identity. Exact original failure stage cannot be recovered from the discarded exception; approved deployment must establish real activation.
- D8–D11 are validated for code/documentation/local tests; production behavior remains provisional. D6's suppression of bootstrap diagnostic context is superseded by D10's sanitized native exception stages; its restriction on publishing financial values remains in force.

### Corrective PR closure

Published and attached [PR #146](https://github.com/DavidCs9/personal-finance-system/pull/146). Required [quality run 36795592365](https://github.com/DavidCs9/personal-finance-system/actions/runs/36795592365) passed every installation/recovery-test/application-test/check/build/synth step on implementation commit `80821addada726406e3e18cff34c124c480d3144`. Production deployment was correctly skipped for the PR. GitHub reported `mergeable=true` and `mergeable_state=clean`; submitted reviews and inline threads were empty at this checkpoint. This closing change updates only this record; latest-head quality and mergeability are rechecked before handoff through [PR checks](https://github.com/DavidCs9/personal-finance-system/pull/146/checks).

The requested corrective implementation is complete as a merge-ready PR. No merge, manual deployment, destructive cleanup or AWS production operation occurred in this session. The approved main deployment must import the eight retained resources, pass bootstrap/IAM and finish historical parity before SQL activation is claimed. The original failure's exact exception is irretrievable from the sanitized first-rollout log; confirmed protocol defects and rollback recovery are fixed, and future failures identify their safe stage/code. Continue any operational follow-up in this same record.
