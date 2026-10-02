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
- Guard #179 passed required quality, was confirmed CLEAN/MERGEABLE and squash-merged. Production workflow `36971813168` completed quality/deploy-production and all gates successfully. Fresh independent read-only acceptance confirms every plan document/payment unchanged and migration 11 absent. Guard prerequisite satisfied. Created `codex/sql-native-month-plans` directly from fetched `origin/main` after that merge.

## Decisions

### D1 — Separate parent month identity from ordered payment rows

- Context: A plan's JSON array stores relational payments, while absent and explicitly empty plans have different inheritance meanings. Legacy stored income is redundant with current payroll-derived income.
- Evidence and uncertainty: Four of six real parents are empty; dropping them would restore old payments. Eight real children have unique IDs within their own month and valid positive safe-integer amounts/days. Existing API accepts duplicate IDs, which would violate a native child key and can confuse the UI's identity.
- Alternatives and tradeoffs: Keep the array as the live operational model; flatten payments and infer absent/empty parents from children; or retain native month parents and ordered payment children.
- Decision and reason: Use native month parents and child identities scoped by month, preserve explicit ordering and empty parents, and exclude legacy income from operational plan storage. Preserve those legacy values in frozen evidence. Reject duplicate IDs before the native migration so old code cannot introduce incompatible children in the cutover window.
- Consequences, verification, and revisit conditions: Inheritance selects the latest parent on/before the requested month and carries its full list, including an empty list. Native edits materialize only the chosen month. Test gaps/year boundaries, empty-stop propagation, historical preservation, safe amounts, order and clamped dates with unchanged payroll-derived financial results.
- Status: Implemented and validated locally and in production.

### D2 — Stage a plan-specific write guard before atomic copy

- Context: Old runtimes can otherwise commit document writes after a new native copy. The existing application barrier already serializes plan mutations.
- Evidence and uncertainty: Card #177/#178 validated this staged pattern on the actual native engine. Plan save already owns an application transaction; migration 11 is unused.
- Alternatives and tradeoffs: Assume quiet traffic; pause all mutations; dual-write parent/array models; or deploy a plan-specific legacy guard before copying.
- Decision and reason: Deploy a guard rejecting legacy month-plan writes once marker 11 exists. Later create tables separately, then copy parents, ordered children and marker 11 together using the official connector's retrying transaction and existing barrier. Migration replay preserves native edits. There is one live plan authority.
- Consequences, verification, and revisit conditions: Plan editing may briefly return maintenance during the reviewed cutover; other financial domains continue. Test pre-marker writes, blocked late writes, mixed transaction rollback, atomic parent/child/marker rollback and interrupted replay. Release only after the guard is deployed.
- Status: Implemented and validated locally and in production.

### D3 — Enforce native child identity, order and money precision

- Context: A normalized child table must preserve API ordering and safe monetary precision, and cannot collapse a zero-child parent into a missing month.
- Evidence and uncertainty: All eight real payments contain only the four documented fields. AWS CREATE TABLE supports native primary, UNIQUE, CHECK and foreign-key constraints. The monthly API uses MXN amounts and accepts safe positive integers, up to 100 payments; its calendar-month domain is the string YYYY-MM.
- Alternatives and tradeoffs: Keep income/currency/document fields in operational parents; add an artificial date or payment slot identity; rely on application-only ordering; or model domain month/payment keys with native uniqueness and typed MXN amounts.
- Decision and reason: Use `month_plans(month,owner,updated_at)` and `planned_payments(month,id,name,amount_mxn_minor,due_day,sort_order)`. Parent month is a validated domain key; child PK is `(month,id)`, native FK links its month, and UNIQUE `(month,sort_order)` with positions 0–99 preserves order and limits cardinality natively. Positive bigint amounts are bounded by JavaScript's safe-integer maximum. Currency is expressed by the MXN column and existing public contract. Replace a month's children atomically with its parent update under the existing barrier, preserving other months and explicit empty parents.
- Consequences, verification, and revisit conditions: A bounded single SQL statement selects the latest eligible parent and LEFT JOINs its children; zero-child parents remain visible. No live envelope reconstruction or plan fallback survives. Migration copies parent and ordered child fields plus marker 11 atomically, and native UNIQUE/FK constraints apply before data copy. Verify exact real child identity/order/amount parity, empty and inherited months, rollback/replay, native constraints and every financial/report/worker gate. Preserve historical income in frozen evidence.
- Status: Implemented and validated locally and in production. Native capability reference: [AWS CREATE TABLE](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html).

## Verification results

Guard implemented. All four guard integration cases and ten focused parser/service cases passed. All 480 workspace tests, workspace typechecks and CDK synthesis passed. Real-data preflight passed with six plans/eight payments, four explicit empty plans and no duplicate IDs. Guard #179 is merged/deployed/accepted. Native implementation removes plan document operations and fallback, adds direct parent/child reads and atomic replacements, and extends native verification/smoke. Four migration/constraint tests and native service/financial tests pass. A test fixture initially routed reads outside its PGlite transaction and deadlocked; it now honors the same current transaction as production, and all six service tests pass. Workspace typechecks and synthesis passed; all 11 protected resource definitions are unchanged. All 485 workspace tests passed. Native PR #180 passed required quality and was CLEAN/MERGEABLE, then squash-merged as `9da0d2e`. Production workflow `36973708849` completed successfully. Independent read-only acceptance before and after the rolled-back native write smoke proved exact parity for six parents/eight payments/four empty parents and every value/order/timestamp, migration 11 present, four validated native key/relation constraints, zero invalid parents and all six frozen plan documents unchanged. Planning verified 22 plan/summary/compensation/as-of close cases and 19 payroll details/XML hashes; all planning, wealth, domain and operational mismatches were zero. Native smoke confirmed `nativeMonthPlans:true`, `verified:true`, `rolledBack:true`. Private evidence/logs remain in `/tmp/olbia-native-month-plans/`.

## Outcome and remaining work

Complete. Guard #179 and native #180 passed quality, linear squash merges, deploy-production and independent live acceptance. Monthly plans and ordered payments have one native SQL authority; history, empty-stop inheritance, derived income and recovery evidence are preserved. Continue with native payroll receipt/line normalization in `2026-10-02-native-payroll.md` until David tells us to stop.
