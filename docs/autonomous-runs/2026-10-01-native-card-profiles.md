# Native SQL card profiles — 2026-10-01

## Objective and completion criteria

Continue David's authorized autonomous normalization work after the completed category slice. Make card profiles authoritative native SQL entities, migrate every profile reader/writer and supporting financial consumer, preserve active-card behavior and liability history, enforce validated liability relationships, and finish reviewed PRs/quality/linear merges/deploy-production/independent live acceptance.

## Constraints

- Olbia is David's private single-owner application and must feel born in SQL. Use domain keys, typed columns and native constraints; no renamed document authority or multiuser frameworks.
- Preserve three active cards maximum, cycle day clamping, zero-paid balances, immutable daily captures/versions, current/as-of Patrimonio and reminders. Read UI/product guides completely before deciding financial behavior.
- All production releases through PR and deploy-production. Local production operations are read-only or existing authenticated/audited domain capabilities after immediate STS identity checks.
- Preserve unrelated work, retained recovery resources and financial history. Raw evidence remains outside Git.

## Progress and next steps

- Re-read autonomous rules and product north star completely; refreshed UI design brief, web AGENTS and Patrimonio guide.
- Category slice completed in #174/#175/#176. Its final run/audit acceptance updates are carried on this new branch for persistence.
- Created `codex/sql-native-card-guard` directly from fetched `origin/main` at `2d7ed0a`.
- Reviewed card CRUD, configured/source/wealth reads, manual liability creation, card-cycle tests and the table audit.
- First deploy a legacy-writer guard and transactional delete; then migrate profiles atomically under the existing native application barrier, migrate consumers and enforce liability FKs. Finish acceptance before selecting another slice.

## Decisions

### D1 — Stage the profile cutover to prevent lost concurrent writes

- Context: A schema copy followed by Lambda replacement can leave a window where old code updates the frozen document representation after the native copy. Even one owner should not lose a legitimate card edit.
- Evidence and uncertainty: Card save already uses the native application transaction/barrier; delete currently relies on the adapter’s implicit transaction rather than an explicit domain wrapper. SQL DDL is separately committed. The installed Aurora DSQL connector supplies native transaction conflict retries. There are three live profiles and 22 current/three versioned liability captures in the audit; fresh preflight is still required.
- Alternatives and tradeoffs: Assume no concurrent edits; pause every financial writer; dual-write both representations; or stage a profile-specific legacy guard and serialize copy/marker with existing card transactions.
- Decision and reason: Deploy a guard first: legacy card writes reject once schema migration 9 exists; delete joins the existing application transaction. The next schema release creates native tables separately, then copies profiles and records migration 9 together under the existing application barrier and official connector transaction retries. Old writers then fail closed until native code replaces them. There is one live profile authority and no dual writing.
- Consequences, verification, and revisit conditions: Card editing may briefly report maintenance during the reviewed cutover; all other financial domains continue. Test a transaction crossing the cutover marker and rollback/retry, deletion atomicity, and no writes after the marker. Verify actual profile parity and financial/evidence gates after deployment.
- Status: Guard implemented and locally validated; reviewed deployment is next.

### D2 — Preserve historical card identity while hiding deleted profiles

- Context: Current deletion removes the profile from reminders/current wealth inputs, but liability snapshots/versions remain. Hard deletion with a new FK would either fail or destroy valid history.
- Evidence and uncertainty: Current readers select cards first and filter liabilities by the selected IDs. The product separates card cycle profiles from balances. No product decision authorizes deleting financial captures with a profile.
- Alternatives and tradeoffs: Cascade/delete liability history, reject profile removal, or retain the card identity with an inactive/deleted timestamp and exclude it from active readers.
- Decision and reason: Native `card_profiles` will retain identity with `deleted_at`; API deletion deactivates the profile and active readers preserve existing behavior. Liability FKs keep historical references intact. Recreation of the same ID reactivates it and preserves existing creation/recreation behavior at the API boundary.
- Consequences, verification, and revisit conditions: Inactive profiles do not count toward the three-card limit or current calculations. No balances become expenses or commitments. Test delete/recreate, as-of calculations and reminders against current contracts; preserve all original evidence and versions.
- Status: Decided; implementation follows guard deployment.

## Verification results

- Guard integration tests: all four passed, covering normal pre-marker editing, blocked post-marker writes with preserved evidence, mixed-transaction rollback, and aborted migration rollback.
- All 466 workspace tests, workspace typechecks and CDK synthesis passed. No infrastructure resource definitions changed.
- Fresh read-only production preflight passed after immediate STS identity verification: three profiles, 22 liability snapshots, three liability versions, zero missing parents, and migration 9 absent. Profile IDs, owner binding, names, days and timestamps satisfy the proposed native constraints. Private evidence is retained outside Git in `/tmp/olbia-native-cards/`.
- Next: PR/quality/linear merge/deploy the guard before releasing the native copy and consumers.

## Outcome and remaining work

Active. Complete the card profile slice end to end, then choose the next bounded item under David's continuing authorization.
