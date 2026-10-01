# DSQL operational state — 2026-10-01

## Objective and completion criteria

Project remaining retained durable operational state, migrate genuinely read-only consumers, deliver shadow and guarded phases through separate PRs and approved production jobs, and independently verify complete envelopes, public contracts, expiration/deletion and all existing financial/evidence/content gates.

## Constraints

DynamoDB remains every write authority, freshness reference and acceptance/dedupe/retry/reconciliation/apply/undo/delivery/cleanup/mutation decision. Preserve native S3 evidence, Cognito and AgentCore memory. No fabricated production records, actual test retries/notifications, manual deployment, reverse replication or source retirement. Default IAM profile, account 225989371926, codex-local-admin, us-east-2; STS immediately before production operations. Original checkout's three guidance edits remain untouched. Isolated worktree begins at refreshed origin/main 11abb61.

## Progress and next steps

Read repository/autonomous/product/UI guidance and previous DSQL phase evidence. Inspecting exact writers/readers, retained production envelopes and TTL semantics before choosing additive schema and narrow read boundaries. Current phase not yet implemented or delivered.

## Decisions

Significant decisions will be recorded before implementation.

## Verification results

Original checkout has exactly AGENTS.md, docs/dsql-migration-plan.md and docs/dsql-migration-runbook.md modified; preserved. Refreshed main ends at prior verified evidence PR #163.

## Outcome and remaining work

Implementation, local adversarial verification, shadow delivery/acceptance, separate promotion/reverification and final evidence remain.

### D1 — Retained operational envelopes and explicit read boundaries
- Context: Operational records mix display data with authoritative retry/apply/delivery and native-discovery decisions. Broad replacement would change acceptance during SQL lag.
- Evidence and uncertainty: Strong production scan found 29 entity types; nine additional operational families cover every remaining retained item. Observed: 541 normal claims, three exception claims, seven exceptions, three retries, 15 imports, 43 applied bulk operations, three email delivery records, one subscription and 36 assistant index/active records. No separate persisted receipt, notification, conversation transcript or bulk-batch entity exists. PDF GET advances Textract; thread GET/list backfills native indices. Top-level TTL occurs only on 35 thread indices in this retained snapshot; pending bulk previews use TTL, applied/undone operations remove it but retain payload expiration.
- Alternatives and tradeoffs: One catch-all table obscures operational boundaries; duplicating native receipts/memory adds an unneeded service; replacing shared GETs risks mutation decisions. Nine additive tables preserve exact source identities/envelopes with useful promoted metadata and reuse native Streams/OCC/recovery.
- Decision and reason: Project claims, exception claims, exceptions, retries, imports, bulk operations, delivery records, subscriptions and thread/active indices. Retain full envelopes (including unknown fields) in JSONB. Preserve authoritative DynamoDB callers. Select only exception listing/raw-source reference, terminal PDF preview display, owner subscription display and thread metadata display after source-owned backfill/discovery. No new public histories/endpoints.
- Consequences, verification, and revisit conditions: Independently compare full retained envelopes and promoted metadata; compare public display/order/limit contracts; adversarial tests exercise all status/TTL/deletion transitions and source-only callers. Native services retain evidence/memory/authentication. Status: provisional.

### D2 — Preserve retained expired envelopes without making them live
- Context: Native TTL deletion is asynchronous. Dropping retained source content based on projector wall-clock would make transformation nondeterministic and lose envelope parity; treating it as live could resurrect expired records.
- Evidence and uncertainty: AWS TTL docs confirm expired items can remain and TTL removal/extension can reactivate them before deletion. Only top-level numeric expiresAt is physical TTL; bulk payload.expiresAt is apply deadline and survives applied audit history.
- Alternatives and tradeoffs: Custom SQL cleanup duplicates native deletion and creates competing authority. Deterministic raw projection plus explicit as-of filtering preserves retained evidence and native deletion semantics.
- Decision and reason: Project every still-retained source envelope including TTL, filter top-level expired records in display consumers at one captured clock, and remove SQL rows on source deletion through existing tombstones/current-source reread. Never infer physical expiry from nested bulk deadlines or recreate missing source history.
- Consequences, verification, and revisit conditions: Verify boundary clocks, TTL extension/removal, native REMOVE and delayed stale replay locally. Expired envelopes are retained parity evidence, not restored live product records. Already deleted history cannot be recovered or claimed. Status: provisional.

### D3 — Limit product operational grants separately from verification
- Context: Independent verification must read claims, retries, operations and delivery state, while product display consumers only need four operational tables.
- Evidence and uncertainty: Existing shared reader role has thirteen financial SELECT grants; extending it with all nine operational tables would give every financial runtime unnecessary access to dedupe/delivery records. Native IAM-to-SQL roles already support scoped association.
- Alternatives and tradeoffs: Broad shared SELECT is simpler but unnecessary; separate verifier role adds only native SQL grants/association and one bounded pool, with no new service or customer access framework.
- Decision and reason: Product olbia_reader gains SELECT only on exceptions/imports/subscriptions/thread indices. Deployed read-only probe additionally connects as olbia_operational_verifier with SELECT on exactly nine operational tables. Existing source IAM permissions and write paths stay unchanged.
- Consequences, verification, and revisit conditions: Assert exact native grants and IAM association after each rollout; test that runtime readers receive no SQL mutation/admin/claim/delivery grants. Status: provisional.

## Investigation checkpoint

Private real-data PostgreSQL replay initially exposed retained legacy retry SK=DISPATCH alongside current DISPATCH#requestId. Both patterns are now covered and tested. Final local retained replay: 652 operational envelopes, 1,304 equal comparisons across two passes and zero independent column/envelope mismatches. No source records changed. Native TTL, JSONB/bigint, OCC and Streams recovery docs revalidated. Node 24.19.0 bundled runtime is used for final checks to match CI/production (shell default was Node 20).

## Pre-PR checkpoint

- Node 24 full workspace suite passed 438 tests (28 web, 55 domain, 239 API, 20 ingestion, 73 ledger, nine notify, 14 infrastructure), all workspace type checks, web build and infrastructure synth. Nine Python recovery tests passed. Focused operational/thread verification is repeated after final review adjustments; required PR quality remains pending.
- Local real retained replay: 652 envelopes, 1,304 equal comparisons, zero independently calculated promoted-column/envelope mismatches. Retained legacy retry keys included. Full private records stay outside Git.
- All ten protected DynamoDB/DSQL/KMS/S3/mapping resource definitions match pre-phase deployed template exactly. Synth API/probe operational shadow, all existing financial flags guarded. Source mapping/configuration unchanged.
- D1/D2/D3 locally validated; native production grants/compatibility/parity, shadow acceptance, guarded promotion and final evidence still pending. No production writes, notifications, retries or local deployments occurred.
