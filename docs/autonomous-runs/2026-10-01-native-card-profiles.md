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
- Guard PR #177 passed required quality, was confirmed CLEAN/MERGEABLE, and was squash-merged. Production workflow `36968893541` completed quality/deploy-production and all live gates successfully. Fresh read-only acceptance confirms all three profiles and 25 liability records remained exactly unchanged, including valid issuer values. The guard prerequisite is satisfied.
- Created `codex/sql-native-card-profiles` directly from fetched `origin/main` after that merge.

## Decisions

### D1 — Stage the profile cutover to prevent lost concurrent writes

- Context: A schema copy followed by Lambda replacement can leave a window where old code updates the frozen document representation after the native copy. Even one owner should not lose a legitimate card edit.
- Evidence and uncertainty: Card save already uses the native application transaction/barrier; delete currently relies on the adapter’s implicit transaction rather than an explicit domain wrapper. SQL DDL is separately committed. The installed Aurora DSQL connector supplies native transaction conflict retries. There are three live profiles and 22 current/three versioned liability captures in the audit; fresh preflight is still required.
- Alternatives and tradeoffs: Assume no concurrent edits; pause every financial writer; dual-write both representations; or stage a profile-specific legacy guard and serialize copy/marker with existing card transactions.
- Decision and reason: Deploy a guard first: legacy card writes reject once schema migration 9 exists; delete joins the existing application transaction. The next schema release creates native tables separately, then copies profiles and records migration 9 together under the existing application barrier and official connector transaction retries. Old writers then fail closed until native code replaces them. There is one live profile authority and no dual writing.
- Consequences, verification, and revisit conditions: Card editing may briefly report maintenance during the reviewed cutover; all other financial domains continue. Test a transaction crossing the cutover marker and rollback/retry, deletion atomicity, and no writes after the marker. Verify actual profile parity and financial/evidence gates after deployment.
- Status: Validated by deployed #177/#178 and independent live acceptance.

### D2 — Preserve historical card identity while hiding deleted profiles

- Context: Current deletion removes the profile from reminders/current wealth inputs, but liability snapshots/versions remain. Hard deletion with a new FK would either fail or destroy valid history.
- Evidence and uncertainty: Current readers select cards first and filter liabilities by the selected IDs. The product separates card cycle profiles from balances. No product decision authorizes deleting financial captures with a profile.
- Alternatives and tradeoffs: Cascade/delete liability history, reject profile removal, or retain the card identity with an inactive/deleted timestamp and exclude it from active readers.
- Decision and reason: Native `card_profiles` will retain identity with `deleted_at`; API deletion deactivates the profile and active readers preserve existing behavior. Liability FKs keep historical references intact. Recreation of the same ID reactivates it and preserves existing creation/recreation behavior at the API boundary.
- Consequences, verification, and revisit conditions: Inactive profiles do not count toward the three-card limit or current calculations. No balances become expenses or commitments. Test delete/recreate, as-of calculations and reminders against current contracts; preserve all original evidence and versions.
- Status: Validated by deployed native CRUD, financial/worker gates and independent history preservation.

### D3 — Make profile columns and liability membership native SQL contracts

- Context: Keeping document-shaped card APIs or allowing null/missing liability parents would leave this domain only partially normalized.
- Evidence and uncertainty: The fresh live baseline has three valid profiles and 25 non-null resolving liability parents. Native DSQL supports CHECK/FK constraints and asynchronous validation of existing tables; the installed official connector supplies transaction conflict retries. Owner predicates preserve the existing access binding, not a multiuser product.
- Alternatives and tradeoffs: Preserve SDK/table arguments and envelope readers; use application-only relationship checks; or migrate card APIs/readers to domain arguments and typed columns with native required-parent CHECKs and FKs.
- Decision and reason: Use `card_profiles(id,owner,name,cut_off_day,payment_due_day,institution,created_at,updated_at,deleted_at)` with validated ID/name/day/issuer constraints. Card CRUD accepts domain arguments only. Every current and versioned liability requires a non-null card ID and a validated FK. Keep the existing barrier to serialize max-three creation, delete/reactivate and liability captures; validate active card membership inside the capture transaction using the application SQL identity.
- Consequences, verification, and revisit conditions: There is no document or fallback profile authority. Wealth still reads its other unnormalized domains through existing contracts, but every wealth path uses native profiles. Keep its complete financial bundle in one SQL statement using typed card columns rather than rebuilding an envelope. Verify migration atomicity/replay, constraints, deletion/reactivation, transaction rollback, zero balances, as-of reports and reminders. Preserve frozen evidence separately from live authority.
- Status: Validated by local checks, reviewed release and native engine acceptance.

## Verification results

- Guard integration tests: all four passed, covering normal pre-marker editing, blocked post-marker writes with preserved evidence, mixed-transaction rollback, and aborted migration rollback.
- All 466 workspace tests, workspace typechecks and CDK synthesis passed. No infrastructure resource definitions changed.
- Fresh read-only production preflight passed after immediate STS identity verification: three profiles, 22 liability snapshots, three liability versions, zero missing parents, and migration 9 absent. Profile IDs, owner binding, names, days and timestamps satisfy the proposed native constraints. Private evidence is retained outside Git in `/tmp/olbia-native-cards/`.
- Native implementation now removes SDK/document profile operations and the retired domain fallback flag, preserves one-statement wealth inputs, and adds validated required-parent relationships plus native rolled-back smoke. Focused tests passed. Broad tests found an expected infrastructure bootstrap-version assertion needing update; the assertion was updated and the focused infrastructure suite passed. The native migration fixture also needed an explicit query result type; workspace typechecks then passed. Final checks passed: all 474 workspace tests, all workspace typechecks, CDK synthesis, and unchanged definitions for all 11 stateful/protected resources (including retained tables, buckets, keys, cluster, vault and secrets). The last domain verification cleanup passed its focused seven tests and API typecheck. Native PR #178 passed required quality, was confirmed CLEAN/MERGEABLE and squash-merged as `4cc8a13d345f29712a08819d85977488913c3e2a`. Fresh immediate pre-merge preflight passed. Production workflow `36970242328` completed quality/deploy-production successfully. Reconciliation, financial/evidence and native rolled-back smoke gates passed with zero mismatches. Independent SQL acceptance before and after the rolled-back smoke confirmed all three profiles copied exactly, every one of 22 current/three historical liabilities unchanged, frozen profiles unchanged, migration markers 9/10 present, all four native relationship constraints validated and zero invalid card references.

## Outcome and remaining work

Complete. Native profiles, all consumers/writers, staged cutover and validated liability relationships are deployed. All required checks and independent acceptance passed. The next bounded slice is monthly plans and their ordered payments under David's continuing authorization. Final acceptance notes are carried into its guard PR so the completion evidence remains in Git.
