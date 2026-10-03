# Native push subscriptions — 2026-10-03

## Objective and completion criteria

Continue David's indefinite normalization goal until he stops it. **Olbia must feel born in SQL; David is its sole owner.** Normalize the complete subscription registry: native identity/endpoint/key fields, constraints, registration/removal, product listing, every notification reader and expired-endpoint cleanup, migration/grants/verification/rollback smoke, required PR quality/linear merge/deploy-production and independent real-data acceptance. Preserve Web Push delivery and current amounts/private behavior. No real notification is sent for verification.

## Constraints and baseline

Root AGENTS, autonomous rules and product north star apply. Preserve real data privately outside Git, financial accuracy, original evidence, provider-managed capabilities and deployment exclusively through the required GitHub Actions workflow. Wealth #191 is merged at `7deb683f8a74d6a89861fe8a47db701208dbf7cb`; workflow `37102460847` and independent exact-data/constraint/permission acceptance now pass. All 151 original S3 files also pass a fresh authenticated rehash. Wealth is complete; this next slice can proceed through its own quality/deployment/acceptance workflow.

The fresh SELECT-only operational audit at `2026-10-03T06:14:49.682Z` has one push subscription, 36 thread records, three deliveries, eight exceptions, four exception claims and three retries. The single subscription has one owner, HTTPS endpoint, exact SHA-256 endpoint identity, valid base64url key material, supported content mode and active state. Its full private baseline is at `/Users/decs/.local/share/olbia-normalization/2026-10-03-operational-audit/snapshot-private.json` (directory 700/file 600). No values or endpoints enter public logs or Git.

## D1 — Normalize the registry before broader operational state

- Context: Financial domains are native; remaining operational entities still use envelopes. Subscriptions have direct consumers across API, observed movements, daily balance/card reminders and both wealth syncs.
- Evidence/uncertainty: One actual valid endpoint is present. The endpoint digest is already the public subscription identity; Web Push key material is opaque provider data. No missing record or shared-account requirement is evidenced.
- Alternatives: Normalize thread discovery/AgentCore pointers or exceptions/retries first, versus completing this bounded integration registry. The latter covers every writer/reader with a small natural relationship shape while preserving the more involved operational state machines for later slices.
- Decision: Choose push subscriptions. Use a typed native registry with the existing subscription identity and unique endpoint; keep opaque native Web Push endpoint/key values as fields, rather than further splitting key components or introducing another push provider. Preserve the existing owner authentication and active/private semantics without a tenant framework. Use existing native Node hashing and SQL constraints/transactions, not a custom SQL hash function or document adapter.
- Consequences/verification: Exact migration and public metadata/notification input parity, native owner filtering, key/endpoint/identity validation, renewal/deletion and failed/expired delivery paths. Exercise sends only with injected test transport; live smoke rolls back SQL and performs no provider IO.
- Status: Provisional; complete native model and release pending.

## D2 — Stage all old subscription reads/writes and delivery entry points before activation

- Context: #190/#191 used a deployed guard to prevent old wealth bundles from reading/writing frozen state after activation. Subscription consumers span shared notify code and direct API operational reads; a writer-only guard could continue sending to stale endpoints or using stale privacy preferences.
- Evidence: Legacy registration/listing/removal use SDK commands. Expired endpoints are removed from the send loop with a direct DeleteCommand. Product listing can select source or projected envelopes, and the generic operational verifier reads those paths. All use the existing SQL authority and schema marker permissions.
- Alternatives: Order new handlers before activation with reverse dependency edges, or deploy a separate guard first. Prior core work proved dependency ordering can create infrastructure cycles; the staged guard is established and verified.
- Decision: Prepare a prerequisite PR from fresh `origin/main` that guards every legacy subscription reader, registration/removal and shared delivery entry point when marker 16 is active. Freeze legacy push mutations inside the existing store transaction/barrier. Reuse the existing maintenance response and shared SQL client; the marker is not created by this prerequisite. Notify declares its actual ledger dependency to share the guard. Generic retained recovery inventory remains available to isolated verification.
- Consequences/verification: Before-marker behavior remains exact; after-marker reads cannot fall back, delivery performs no transport/secret IO, old writes and mixed/enclosing transactions roll back. Test the actual notify paths, SQL product selection and store commands. Required quality/deployment and independent unchanged-data proof precede native activation.
- Status: Provisional; guard implementation and prerequisite acceptance pending.

## Progress and next steps

Branch `codex/sql-push-cutover-guard` starts directly from fetched `origin/main` at wealth merge `7deb683`. Prepare and verify the guard while wealth deploys. Wealth acceptance remains the immediate release prerequisite. Then release/accept the guard and implement the full native subscription boundary; do not declare a guard or a schema-only foundation to be domain completion.


Guard verification checkpoint: all 666 workspace tests and every workspace typecheck pass. Three actual store integration cases preserve before-marker registration/update/delete, freeze all late mutation forms and retain the old recovery record, and prove whole mixed/enclosing transactions, command receipts and barrier updates roll back. Three notify cases cover ordinary registration/listing/410 cleanup, all post-marker registry/delivery entry points with zero document/secret/transport IO, and sanitized fail-closed driver errors. Two API read cases block SQL/configured reads in every source/shadow/guarded mode without fallback and preserve ordinary pre-marker/other-family reads. Corrected the pre-marker test to reuse its supplied native SQL snapshot rather than accidentally opening an unconfigured pool. No marker 16 or native registry is introduced by the guard. Infrastructure synthesis/protected-resource checks, guard PR/deployment and independent unchanged-data acceptance remain next.


Guard release preparation accepted: synthesis succeeds and all 44 protected production resource definitions are unchanged. Fresh authenticated SELECT-only preflight at `2026-10-03T06:33:31.661Z` preserves a private comparison baseline of all 54 non-control tables (6,839 rows), including the exact native wealth/ledger and remaining operational data. Wealth marker 15 is active and push marker 16 absent. Independent post-deployment comparison is prepared at `/tmp/olbia-native-ledger/push-guard-acceptance.mjs`; only aggregates are public. Final fetch/rebase, PR quality/CLEAN/MERGEABLE, linear merge/deploy-production and exact post-smoke acceptance remain required.
