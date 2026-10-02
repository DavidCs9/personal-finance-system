# Native bank imports and parsed rows — 2026-10-02

## Objective and completion criteria

Normalize the import domain as the first provenance dependency of the native core ledger. Give each bank import a native kind/content-hash identity and ordered parsed row/candidate relations; move preview, processing, polling, retry, apply and terminal displays to direct SQL. Preserve original source/extraction evidence and frozen reconciliation decisions. Complete guard/native PRs, quality, linear merges, deploy-production, independent exact-data acceptance and financial/evidence gates before continuing the ledger slice.

## Constraints

- Olbia is David's private financial application and must feel born in SQL. Owner identifiers only protect his access.
- Original PDF/CSV and extraction evidence, every parsed row, negative credit rows, candidate ordering, applied summaries, historical decisions and MSI semantics remain intact.
- No guessed card mapping, fabricated observations, deleted suppression claims or financial repair through direct SQL. Raw evidence remains private in `/tmp/olbia-native-ledger/` and `/tmp/olbia-native-imports/`.
- Production release only through PR/quality/deploy-production. Payroll #182 live acceptance finished successfully before this release.

## Progress and next steps

- Fresh consistent read-only snapshot at `2026-10-02T13:28:02.918Z`: 15 imports, 484 rows, 13 applied and two previewed. Providers are Amex statements, Santander statements and Santander CSV. Current core counts remain 499 movements, 522 observations and 420 revisions.
- Traced dangling Amex claims to the initial August 7 apply and retained August 13 duplicate preview. Original movements/observations/revisions are absent. Their absence alone does not establish intentional deletion; keep suppression and historical identities until stronger evidence supports an audited repair.
- MSI references: 19 resolve to one retained parsed row, five to two appearances and two to legacy backfill markers. Confirmation timestamps differ from import applied timestamps; do not pretend timestamp equality provides an exact FK. Imported row identity is unique within a capture, not globally across files.
- Stage the import-family guard and atomic legacy apply boundaries before migration 13. Then implement typed native imports/ordered rows/candidate snapshots, exact copy and every consumer. No schema copy has started.

## Decisions

### D1 — Normalize import captures before constraining core provenance

- Context: MSI currently labels parsed row identities as observation IDs; repeated imports preserve the same row identity and frozen candidate decisions. A global observation/row UNIQUE or FK would corrupt historical semantics.
- Evidence and uncertainty: Fresh data has 484 parsed rows across 15 retained files, including five repeated MSI identities and two legacy backfill markers. Actual source targets for two Amex claims no longer exist, with no retained revision proving the reason. Original evidence and applied/preview classifications survive.
- Alternatives: Fold all imports into a single oversized ledger rewrite; impose uniqueness on raw identities; preserve operational row arrays; or normalize each import capture with ordered children first and keep historical decision references distinct from canonical relationships.
- Decision and reason: Choose native import kind/content hash and ordered per-import row identities. Normalize candidate snapshots as children when implementing; retain historical candidate labels and selection IDs as evidence rather than joining them to current merchant/category values. Do not invent a current movement FK for a frozen candidate assertion. Resolve exact MSI provenance separately against these native captures in the core slice. This establishes real relational parents without recreating document routing.
- Consequences and verification: Preserve every source field, row, order and optional-field distinction; verify repeated identities and original files independently. No global uniqueness on a statement identity or automatic suppression deletion. Complete all import lifecycle readers/writers before promoting the domain.
- Status: Decided before implementation; native schema and lifecycle design remain next.

### D2 — Guard the header and make apply rollback as one domain operation

- Context: Statement/CSV apply currently commits financial rows/claims separately before recording final import status. A late old runtime after native copy could mutate financial records then fail the frozen header update, leaving an apparently unapplied operation.
- Evidence and uncertainty: Both statement providers share applyStatementImport; CSV has its own loop. Individual row transactions are already atomic, but the complete loop/header lacks an outer transaction. All live imports are modest in size; an oversized transaction must fail with all SQL changes rolled back, not chunk partial financial decisions.
- Alternatives: Guard only the last header mutation; dual-write import forms; pause all writes; or stage an import-family marker guard and use the existing native application transaction/barrier around complete apply loops.
- Decision and reason: Before native migration 13, block legacy import-family Put/Update/Delete once its marker exists and wrap shared statement apply plus CSV apply in the existing application transaction. A marker change conflicts with the same barrier; all financial rows, observations, claims, revisions and final header commit or rollback together. Unrelated domains/claim families continue normally. Preserve Amex's existing optional post-apply deferral behavior separately; this guard does not redefine that product behavior.
- Consequences and verification: Test all provider families and mutation forms, retained reads, marker interruption, unrelated writes, sequential row writes followed by blocked completion, and actual statement/CSV apply rollback/retry. Frozen header rejection must roll back earlier SQL changes, with no command receipt left behind. Native implementation must respect DSQL's transaction row limit; no partial-receipt workaround.
- Status: Decided before implementation. Guard preparation begins only after recording this decision.

## Verification results

Fresh live read-only audit completed. Guard implementation is prepared on `codex/sql-native-import-guard`, created directly from fetched `origin/main` after #182. Four storage integration cases cover all provider lifecycles/mutation forms, exact retained reads, unrelated financial writes, command receipts, sequential financial-write rollback and aborted marker restoration. Three actual service integration cases execute Amex/Santander statement and CSV apply, prove rows/observations/claims exist inside the shared transaction before blocked completion, then prove total rollback and successful clean retry. All 506 workspace tests, workspace typechecks and CDK synthesis passed; all 11 protected resource definitions are unchanged. Payroll #182 deployed and passed every financial/evidence gate plus rolled-back native write smoke; independent post-smoke acceptance confirms exact 19/192 parity and immutable grants. Guard PR/release/live unchanged-import acceptance are next; native import copy/release/acceptance remain pending.

## Outcome and remaining work

Active. Imports are a bounded dependency of the core ledger, not completion of the overall normalization goal.
