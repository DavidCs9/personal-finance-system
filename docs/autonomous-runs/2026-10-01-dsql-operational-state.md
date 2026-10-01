# DSQL operational state — 2026-10-01

## Objective and completion criteria

Project remaining retained durable operational state, migrate genuinely read-only consumers, deliver shadow and guarded phases through separate PRs and approved production jobs, and independently verify complete envelopes, public contracts, expiration/deletion and all existing financial/evidence/content gates.

## Constraints

DynamoDB remains every write authority, freshness reference and acceptance/dedupe/retry/reconciliation/apply/undo/delivery/cleanup/mutation decision. Preserve native S3 evidence, Cognito and AgentCore memory. No fabricated production records, actual test retries/notifications, manual deployment, reverse replication or source retirement. Default IAM profile, account 225989371926, codex-local-admin, us-east-2; STS immediately before production operations. Original checkout's three guidance edits remain untouched. Isolated worktree begins at refreshed origin/main 11abb61.

## Progress and next steps

Implementation, local adversarial verification, shadow delivery/acceptance, separate guarded promotion and full production re-verification are complete. Final evidence is assembled below. Eligible operational displays now use guarded-sql; all source authority and freshness guards remain.

## Decisions

D1–D3 were recorded before implementation and are validated by local adversarial tests and both independent production gates.

## Verification results

Original checkout has exactly AGENTS.md, docs/dsql-migration-plan.md and docs/dsql-migration-runbook.md modified; preserved. Refreshed main ends at prior verified evidence PR #163.

## Outcome and remaining work

The authorized operational-projection/read-only phase is achieved. No implementation or production verification remains. This documentation-only evidence change follows the required PR/quality/linear merge workflow. DynamoDB remains all write and decision authority; subsequent write-authority work requires the prerequisites in docs/dsql-operational-state.md and separate authorization.

### D1 — Retained operational envelopes and explicit read boundaries
- Context: Operational records mix display data with authoritative retry/apply/delivery and native-discovery decisions. Broad replacement would change acceptance during SQL lag.
- Evidence and uncertainty: Strong production scan found 29 entity types; nine additional operational families cover every remaining retained item. Observed: 541 normal claims, three exception claims, seven exceptions, three retries, 15 imports, 43 applied bulk operations, three email delivery records, one subscription and 36 assistant index/active records. No separate persisted receipt, notification, conversation transcript or bulk-batch entity exists. PDF GET advances Textract; thread GET/list backfills native indices. Top-level TTL occurs only on 35 thread indices in this retained snapshot; pending bulk previews use TTL, applied/undone operations remove it but retain payload expiration.
- Alternatives and tradeoffs: One catch-all table obscures operational boundaries; duplicating native receipts/memory adds an unneeded service; replacing shared GETs risks mutation decisions. Nine additive tables preserve exact source identities/envelopes with useful promoted metadata and reuse native Streams/OCC/recovery.
- Decision and reason: Project claims, exception claims, exceptions, retries, imports, bulk operations, delivery records, subscriptions and thread/active indices. Retain full envelopes (including unknown fields) in JSONB. Preserve authoritative DynamoDB callers. Select only exception listing/raw-source reference, terminal PDF preview display, owner subscription display and thread metadata display after source-owned backfill/discovery. No new public histories/endpoints.
- Consequences, verification, and revisit conditions: Independently compare full retained envelopes and promoted metadata; compare public display/order/limit contracts; adversarial tests exercise all status/TTL/deletion transitions and source-only callers. Native services retain evidence/memory/authentication. Status: validated by local adversarial checks and both production gates.

### D2 — Preserve retained expired envelopes without making them live
- Context: Native TTL deletion is asynchronous. Dropping retained source content based on projector wall-clock would make transformation nondeterministic and lose envelope parity; treating it as live could resurrect expired records.
- Evidence and uncertainty: AWS TTL docs confirm expired items can remain and TTL removal/extension can reactivate them before deletion. Only top-level numeric expiresAt is physical TTL; bulk payload.expiresAt is apply deadline and survives applied audit history.
- Alternatives and tradeoffs: Custom SQL cleanup duplicates native deletion and creates competing authority. Deterministic raw projection plus explicit as-of filtering preserves retained evidence and native deletion semantics.
- Decision and reason: Project every still-retained source envelope including TTL, filter top-level expired records in display consumers at one captured clock, and remove SQL rows on source deletion through existing tombstones/current-source reread. Never infer physical expiry from nested bulk deadlines or recreate missing source history.
- Consequences, verification, and revisit conditions: Verify boundary clocks, TTL extension/removal, native REMOVE and delayed stale replay locally. Expired envelopes are retained parity evidence, not restored live product records. Already deleted history cannot be recovered or claimed. Status: validated by local adversarial checks and both production gates.

### D3 — Limit product operational grants separately from verification
- Context: Independent verification must read claims, retries, operations and delivery state, while product display consumers only need four operational tables.
- Evidence and uncertainty: Existing shared reader role has thirteen financial SELECT grants; extending it with all nine operational tables would give every financial runtime unnecessary access to dedupe/delivery records. Native IAM-to-SQL roles already support scoped association.
- Alternatives and tradeoffs: Broad shared SELECT is simpler but unnecessary; separate verifier role adds only native SQL grants/association and one bounded pool, with no new service or customer access framework.
- Decision and reason: Product olbia_reader gains SELECT only on exceptions/imports/subscriptions/thread indices. Deployed read-only probe additionally connects as olbia_operational_verifier with SELECT on exactly nine operational tables. Existing source IAM permissions and write paths stay unchanged.
- Consequences, verification, and revisit conditions: Assert exact native grants and IAM association after each rollout; test that runtime readers receive no SQL mutation/admin/claim/delivery grants. Status: validated by local adversarial checks and both production gates.

## Investigation checkpoint

Private real-data PostgreSQL replay initially exposed retained legacy retry SK=DISPATCH alongside current DISPATCH#requestId. Both patterns are now covered and tested. Final local retained replay: 652 operational envelopes, 1,304 equal comparisons across two passes and zero independent column/envelope mismatches. No source records changed. Native TTL, JSONB/bigint, OCC and Streams recovery docs revalidated. Node 24.19.0 bundled runtime is used for final checks to match CI/production (shell default was Node 20).

## Pre-PR checkpoint

- Node 24 full workspace suite passed 438 tests (28 web, 55 domain, 239 API, 20 ingestion, 73 ledger, nine notify, 14 infrastructure), all workspace type checks, web build and infrastructure synth. Nine Python recovery tests passed. Focused operational/thread verification is repeated after final review adjustments; required PR quality remains pending.
- Local real retained replay: 652 envelopes, 1,304 equal comparisons, zero independently calculated promoted-column/envelope mismatches. Retained legacy retry keys included. Full private records stay outside Git.
- All ten protected DynamoDB/DSQL/KMS/S3/mapping resource definitions match pre-phase deployed template exactly. Synth API/probe operational shadow, all existing financial flags guarded. Source mapping/configuration unchanged.
- D1/D2/D3 locally validated; native production grants/compatibility/parity, shadow acceptance, guarded promotion and final evidence still pending. No production writes, notifications, retries or local deployments occurred.

## Shadow delivery checkpoint

PR #164 passed required quality and CLEAN/MERGEABLE and was squash merged. The approved main workflow owns deployment; operational mode remains shadow. Guarded branch starts directly from refreshed origin/main. No guarded flag changes until explicit native reconciliation/read gate acceptance. Final focused API type check and 15 operational/thread tests passed after review adjustments; required CI quality passed the complete suite.

## Shadow native inspection (before backfill acceptance)

- Main commit 8f1be255dc35d8e63be33e30a64ee9b869874d7d; approved [workflow 36915582121](https://github.com/DavidCs9/personal-finance-system/actions/runs/36915582121) stack deployment succeeded. Reconciliation/read gate still running.
- Native SQL reports migration versions 1/2/3/4, exactly 17 product SELECT grants and nine operational-verifier SELECT grants. Verifier association is exclusively the deployed read probe; no additional product mutation/admin grants.
- CloudFormation UPDATE_COMPLETE; all ten protected resource definitions equal the pre-phase production template. Projector mapping Enabled/OK; all eight native alarms OK. Seven financial reader runtimes retain guarded-sql; only API/probe operational flags are shadow.
- Direct deployed Lambda component GETs for exceptions/subscriptions returned HTTP 200 and safely selected source on mismatch while historical operational backfill was incomplete. These are pre-acceptance fallback observations, not a failed parity claim or promotion approval. Repeat after reconciliation. Direct component invocation does not test the API Gateway JWT authorizer. Thread discovery endpoint is intentionally not invoked because it can backfill native indices; independent metadata/public rendering checks cover the read-only SQL boundary.

## Shadow acceptance and promotion decision

[PR #164](https://github.com/DavidCs9/personal-finance-system/pull/164) and [workflow 36915582121](https://github.com/DavidCs9/personal-finance-system/actions/runs/36915582121) succeeded, including quality and deploy-production. Reconciliation: projected 4,874; equal 4,874; lag zero; mismatch zero. Independent gate: verified=true, total mismatches zero; operational mode shadow, all 652 retained envelopes, 98 strong source pages / 14 target pages, 54 public responses, 59 configured reads and 114 expiration checks, operational mismatches zero (4,287 ms). Full gate 108,328 ms.

Existing gates passed again: 494 movements/details; 21 feeds/summaries and 19 ranges; six stored plans / 19 CFDIs with 19 original XML evidence files; 120 wealth snapshots, four wealth audit versions, 22 liabilities, three liability audit versions, three cards and all 149 original evidence hashes; 13 effective categories and 174 rules. Domain checks included 60 assistant calculations, 20 reports, 1,212 daily messages and 240 cycle messages; wealth checks included 21 reports / 95 reminders. No notifications, actual retries/deliveries or source mutations invoked. These counts are observations, not fixed targets.

Native SQL counts now match all nine retained family counts. Four display-table EXPLAIN ANALYZE VERBOSE results use Index Only Scan (execution 0.483–0.785 ms; 0.00525–0.21571 DPU); numeric query evidence stays outside Git. Direct deployed exception/subscription component GETs returned HTTP 200, shadow/equal, no mismatch/error and source selected, as intended.

D1/D2/D3 validated by local adversarial tests, full real retained reconciliation, independent shadow raw/promoted/public/expiry gates and exact native grants. Decision before flag edit: promote only API/probe operational display mode to guarded-sql in a separate PR; preserve all source decision/write/freshness authority, schema/capture/resources and other flags. Roll back that flag through the same approved PR workflow if guarded verification fails; never release locally or change the source to obtain parity. Guarded verification and final evidence still pending.

## Guarded delivery checkpoint

[PR #165](https://github.com/DavidCs9/personal-finance-system/pull/165) passed required quality, CLEAN/MERGEABLE and squash merged at 2026-10-01T19:52:20Z as dc9a5a824b4a294a6b4f7ecdcb9f9ad88fa525fe. Promotion changes only API/probe operational flag and evidence docs. Infrastructure typecheck/synth passed, all ten protected definitions equal the shadow production template, all other flags unchanged. Final evidence branch starts directly from refreshed origin/main; no production release from the local machine. Approved guarded production workflow, complete re-verification and final native/component health checks remain pending.

## Guarded native/component inspection (independent gate pending)

Approved [workflow 36917474660](https://github.com/DavidCs9/personal-finance-system/actions/runs/36917474660), head dc9a5a824b4a294a6b4f7ecdcb9f9ad88fa525fe, passed quality and completed CloudFormation update. Stack UPDATE_COMPLETE; both API/probe operational flags guarded-sql, all other financial flags still guarded-sql across seven runtimes, every update Successful. All ten protected definitions equal pre-phase, mapping Enabled/OK, all eight alarms OK.

Native versions 1/2/3/4, product 17 SELECT grants, operational-verifier nine SELECT grants and its exclusive probe IAM association unchanged. Native counts match nine retained families. Four operational display table plans use Index Only Scan (execution 0.444–0.773 ms, 0.00517–0.21558 DPU).

Direct deployed exception/subscription component GETs both return HTTP 200 with guarded-sql/equal, SqlSelected=1, Mismatch=0, SqlError=0. Entire responses equal saved post-backfill shadow responses. This proves actual component selection, not the JWT authorizer. No native thread discovery/backfill invoked. Historical reconciliation and full independent guarded gates still pending; these successful spot checks do not substitute for them.

## Final guarded acceptance

[Workflow 36917474660](https://github.com/DavidCs9/personal-finance-system/actions/runs/36917474660) completed successfully with required quality and deploy-production. Reconciliation finished 2026-10-01T20:00:12Z (14:00:12 America/Chihuahua): projected 4,874, equal 4,874, lag zero, mismatch zero. Independent guarded gate: verified=true, total mismatches zero; operational gate 4,120 ms and complete gate 107,861 ms. Raw comparisons independently precede configured fallback.

| Operational result | Shadow | Guarded |
| --- | --- | --- |
| Retained complete envelopes / independently promoted columns | 652 | 652 |
| Strong source pages / SQL keyset pages | 98 / 14 | 98 / 14 |
| Public-response comparisons | 54 | 54 |
| Configured item reads | 59 | 59 |
| Expiration boundary checks | 114 | 114 |
| Operational / total mismatches | 0 / 0 | 0 / 0 |
| Reconciliation lag / mismatches | 0 / 0 | 0 / 0 |

Guarded retained-family counts: claims 541, exception claims three, exceptions seven, retries three, imports 15, bulk operations 43, delivery records three, subscriptions one, assistant thread/active indices 36. Counts are observed retained state, never fixed acceptance targets or a claim to restore already-deleted history.

All existing financial/evidence/content gates passed again: 494 movement details, 21 feeds/summaries, 19 ranges; six stored plans, 19 stored CFDIs and original XML files; all 149 retained Patrimonio evidence hashes plus canonical/audit snapshots; 13 effective categories, 174 rules and three cards. Domain comparisons repeated 498 merchant checks, 60 assistant calculations, 20 reports, 1,212 daily messages, 606 cycle-day inputs and 240 cycle messages. Wealth comparisons repeated 95 daily overviews/reminders, 193 investment checks and 21 reports. No test notifications or actual retries/deliveries were sent.

Post-gate native health rechecked: UPDATE_COMPLETE, all seven reader runtimes Successful with appropriate guarded flags, all ten protected resource definitions equal pre-phase, mapping Enabled/OK and all eight native alarms OK. Native schema versions 1/2/3/4, transformer 4, bootstrap provider 7. Product reader has exactly 17 SELECT grants; operational verifier exactly nine SELECT grants and one exclusive probe association. No SQL mutation/admin grants for those readers.

## Final scope, rollback and next phase

Shadow [PR #164](https://github.com/DavidCs9/personal-finance-system/pull/164), guarded [PR #165](https://github.com/DavidCs9/personal-finance-system/pull/165) and their approved main workflows establish the delivered phase. Quality passed 438 workspace tests plus nine recovery tests; all local workspace typechecks/build/synth and meaningful concurrency/replay/TTL/tombstone/corruption/outage checks passed. Original checkout still contains only its three unrelated guidance changes; none were copied, committed or overwritten.

Genuinely read-only exception/raw-source, terminal PDF preview, subscription and assistant-index displays are guarded. Every acceptance/dedupe/retry dispatch/import poll/apply/undo/prepare/send/recipient/cleanup/native-discovery/mutation decision remains explicitly source/native. S3 evidence, Cognito and native AgentCore memory remain in their services. Complete bulk/import/delivery/audit envelopes are projected without creating new public histories or mirroring native transcripts.

Rollback only API/probe operationalReadMode to shadow or dynamodb through PR → quality → CLEAN/MERGEABLE → linear squash/rebase merge → deploy-production; preserve schema/capture and other guarded flags. Source failure still propagates and SQL mismatch/failure falls back. No write-authority cutover, reverse replication, guard removal or DynamoDB retirement occurred. The complete source dependency inventory and concrete prerequisites for the next write-authority phase are in [operational-state guide](../dsql-operational-state.md#remaining-dynamodb-dependencies-and-next-phase-prerequisites). No unresolved decision or user approval is required for this completed phase.
