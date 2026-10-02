# Native SQL categories and integrity — 2026-10-01

## Objective and completion criteria

David authorized indefinite autonomous work and asked to select one item and finish it end to end. Selected item: category integrity as the first native SQL normalization slice. Normalize the authoritative category catalog and its readers/writers, prevent nonexistent category assignments across individual/assistant/bulk/rule paths, repair the existing invalid references auditably, and finish PR/quality/linear merge/deploy-production/live verification.

## Constraints

- Binding product direction: David's personal finances only; Olbia should feel born in SQL, without preserving DynamoDB-shaped persistence as its final design.
- Production releases only through PR, required quality and deploy-production; preserve all recovery resources and financial/audit history.
- Use already-deployed authenticated domain capabilities for financial corrections. No direct database mutations that bypass validation or revisions.
- Preserve the earlier audit files and unrelated work. Raw production data stays private outside Git.

## Progress and next steps

- Read autonomous rules completely and refreshed product/repository guidance.
- Created `codex/category-integrity` directly from fetched `origin/main` at `c6ef80e`.
- Investigated preview/apply/undo, category service/rules, SQL projection/read selection and existing private live audit.
- David explicitly added the SQL-native architecture north star; recorded it in the audit and binding product guide.
- Implemented the canonical category SQL slice and verification for its retired document representation; preparing the first reviewed release.
- David explicitly authorized continuing slice → PR → quality → merge → deployment → verification cycles until he says to stop. After this item completes, select the next bounded slice and persist a new record.
- Native `spend_categories` table and direct catalog repository implemented; no category document writes/default overlays in the application catalog path. Membership checks cover single/rule changes, previews, prepared apply/batch apply and undo.
- Exact cleanup scope is **ten** original operations over 15 movements and seven missing category IDs. The earlier commentary's seven-operation estimate was the category count; verified all ten operations affect only the intended 15 movements.

## Decisions

### D1 — Complete a native SQL slice

- Context: A validation-only patch on document commands would close a bug but retain the persistence model David explicitly wants to remove.
- Evidence and uncertainty: Current category projection keys/JSON/default overlay and document writers are authoritative through the adapter. Native SQL supports relational keys and constraints. Fifteen invalid assignments remain in current data.
- Alternatives and tradeoffs: Adapter-only validation is smaller but does not normalize the selected domain; direct SQL category authority requires migrating catalog readers/writers and adapting verification.
- Decision and reason: Deliver a real canonical SQL category catalog and membership integrity as one coherent slice, retaining only needed migration/recovery evidence.
- Consequences, verification, and revisit conditions: Gate all catalog consumers and assignment paths. Verify parity and failure atomicity, as well as native live data and deployment gates. Do not expand into unrelated tables' normalization.
- Status: Locally validated; production acceptance pending.

### D2 — Restore recorded valid classifications when cleaning invalid assignments

- Context: The invalid IDs were introduced by assistant category edits; adding seven new categories would silently ratify an unintended taxonomy expansion.
- Evidence and uncertainty: Latest category revisions give prior values: 13 previously uncategorized movements and two previously `otros`. Original revisions remain available. No user decision to extend the taxonomy is recorded.
- Alternatives and tradeoffs: Invent broad remappings, add all missing catalog entries, or restore the last valid recorded value with a new revision.
- Decision and reason: Restore the recorded valid value (including uncategorized) through audited domain operations after verifying current preconditions. Preserve original revisions and avoid introducing category meanings by inference.
- Consequences, verification, and revisit conditions: Category allocation changes to its last valid state; bank amounts, personal amounts, tags and spend totals stay equal. A newer explicit classification must supersede the private repair plan.
- Status: Provisional until live preconditions are rechecked.

### D3 — Native catalog rollout, auditable repair, then validated FKs

- Context: Existing assignments violate catalog membership; a historical FK validation cannot pass before repair. The retained projection is also part of the migration comparison gate.
- Evidence and uncertainty: The catalog has only 13 effective rows with 12 persisted envelopes. Schema bootstrap can seed once from effective projection columns. Ten deployed assistant category operations have exactly the bad assignments and recorded valid prior values; the IAM-authenticated tool handler binds owner from configuration.
- Alternatives and tradeoffs: Rewrite all financial storage in one change; preserve document writes forever; or move catalog authority now, keep frozen migration evidence, then enforce clean assignment relationships.
- Decision and reason: Create `spend_categories` with domain key/typed required columns/checks; seed once through versioned reviewed bootstrap; migrate all catalog consumers/writers and reject adapter catalog mutations. Retain old catalog projection/envelopes only as frozen recovery evidence. Repair through existing deployed `undo_category_edit` operations, then deliver validated native assignment FKs through a follow-up reviewed deployment.
- Consequences, verification, and revisit conditions: There is one live catalog authority, no dual writing. Existing projection gates still check frozen evidence; native catalog shape/query checks replace obsolete live catalog source parity. Final completion requires zero unknown current assignments and native validated constraints. Deleting retained migration evidence is not in this slice.
- Status: Implementing.

## Verification results

- All 454 workspace tests passed (domain 28, web 55, API 243, ingestion 20, ledger 84, notify 9, infrastructure 15); Python deployment/recovery tests: 20 passed.
- All workspace type checks passed after correcting test types; web production build and CDK synthesis passed.
- Native PGlite integration covers preserved labels, one-time default seeding, interrupted/repeated migration, database CHECK/required columns, document-writer rejection, stale operation targets, null/custom targets and failed catalog batch atomicity.
- Focused wealth failure tests isolate wealth SQL failure while retaining the mandatory native category authority.
- Compared synthesized and live CloudFormation definitions after STS identity verification: all eight protected stateful resources exactly equal; only the expected Lambda version identity changes.
- Native constraint syntax verified against [DSQL CREATE TABLE](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html) and [ALTER TABLE](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html). Validation of existing relationships follows the documented asynchronous path after cleanup.

## Outcome and remaining work

Active. Local implementation and checks complete. First PR/quality/merge/deployment, audited cleanup, validated assignment FKs and final live acceptance remain.
