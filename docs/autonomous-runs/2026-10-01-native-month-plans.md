# Native SQL monthly plans and payments — 2026-10-01

## Objective and completion criteria

Continue David's authorized autonomous normalization after completed categories/rules and card profiles. Give monthly fixed-expense plans and their ordered payments one native SQL authority, migrate all readers/writers and financial consumers, preserve inheritance and empty-month stops, and complete tests, reviewed PRs, quality, linear merges, deploy-production and independent live acceptance before choosing another slice.

## Constraints

- Olbia belongs only to David and must feel born in SQL. Domain month/payment keys and native relations replace document envelopes; no new users or tenant framework.
- Preserve current payroll-derived income, estimates/provisional income, Fondo, spending and commitments. Fixed expenses remain separate from MSI and card cycles. Empty parents stop inheritance; reads never materialize an inherited month.
- Preserve history, financial precision, recovery evidence and existing public API behavior. Raw real records stay outside Git.
- Production releases exclusively through PR/quality/deploy-production; use immediate STS verification for read-only live diagnosis. Preserve unrelated work.

## Progress and next steps

- Card slice completed through #177/#178; production workflow `36970242328` and independent post-smoke acceptance passed. Its closing run/audit notes are carried on this branch.
- Created `codex/sql-native-month-plan-guard` directly from fetched `origin/main` at `4cc8a13`.
- Product/UI/Patrimonio guides and autonomous rules were read completely in this continuing run; reviewed monthly service, parser, planning verification and inheritance/payroll tests.
- Fresh read-only live audit after immediate STS verification: six plans, eight payment rows, four explicit empty plans, one owner, zero duplicate payment IDs. All months, names, due days, amounts and update times satisfy the proposed constraints. Five legacy income fields remain evidence; operational income already comes from payroll. Private evidence is in `/tmp/olbia-native-month-plans/`.
- Deploy a legacy-write guard and duplicate-ID validation first. Then migrate parents/children atomically with a marker under the existing native application barrier and migrate every plan consumer. Finish independent acceptance before proceeding.

## Decisions

### D1 — Separate parent month identity from ordered payment rows

- Context: A plan's JSON array stores relational payments, while absent and explicitly empty plans have different inheritance meanings. Legacy stored income is redundant with current payroll-derived income.
- Evidence and uncertainty: Four of six real parents are empty; dropping them would restore old payments. Eight real children have unique IDs within their own month and valid positive safe-integer amounts/days. Existing API accepts duplicate IDs, which would violate a native child key and can confuse the UI's identity.
- Alternatives and tradeoffs: Keep the array as the live operational model; flatten payments and infer absent/empty parents from children; or retain native month parents and ordered payment children.
- Decision and reason: Use native month parents and child identities scoped by month, preserve explicit ordering and empty parents, and exclude legacy income from operational plan storage. Preserve those legacy values in frozen evidence. Reject duplicate IDs before the native migration so old code cannot introduce incompatible children in the cutover window.
- Consequences, verification, and revisit conditions: Inheritance selects the latest parent on/before the requested month and carries its full list, including an empty list. Native edits materialize only the chosen month. Test gaps/year boundaries, empty-stop propagation, historical preservation, safe amounts, order and clamped dates with unchanged payroll-derived financial results.
- Status: Decided before implementation.

### D2 — Stage a plan-specific write guard before atomic copy

- Context: Old runtimes can otherwise commit document writes after a new native copy. The existing application barrier already serializes plan mutations.
- Evidence and uncertainty: Card #177/#178 validated this staged pattern on the actual native engine. Plan save already owns an application transaction; migration 11 is unused.
- Alternatives and tradeoffs: Assume quiet traffic; pause all mutations; dual-write parent/array models; or deploy a plan-specific legacy guard before copying.
- Decision and reason: Deploy a guard rejecting legacy month-plan writes once marker 11 exists. Later create tables separately, then copy parents, ordered children and marker 11 together using the official connector's retrying transaction and existing barrier. Migration replay preserves native edits. There is one live plan authority.
- Consequences, verification, and revisit conditions: Plan editing may briefly return maintenance during the reviewed cutover; other financial domains continue. Test pre-marker writes, blocked late writes, mixed transaction rollback, atomic parent/child/marker rollback and interrupted replay. Release only after the guard is deployed.
- Status: Decided before implementation.

## Verification results

Guard implemented. All four guard integration cases and ten focused parser/service cases passed. All 480 workspace tests, workspace typechecks and CDK synthesis passed. Real-data preflight passed with six plans/eight payments, four explicit empty plans and no duplicate IDs. Required PR/quality/merge/deployment is next.

## Outcome and remaining work

Active. Complete this bounded plan/payment slice end to end, then continue with the next item until David tells us to stop.
