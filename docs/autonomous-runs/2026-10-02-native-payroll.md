# Native SQL payroll receipts and lines — 2026-10-02

## Objective and completion criteria

Continue David’s authorized autonomous normalization once monthly plans pass live acceptance. Give CFDI receipts native UUID identity and ordered relational SAT lines, move the entire payroll ingestion/read/income/Fondo domain to one SQL authority, preserve XML evidence and source totals, and complete staged PRs, quality, linear merges, deploy-production and independent live acceptance before choosing another slice.

## Constraints

- Olbia belongs only to David and must feel born in SQL. No document keys, operational payload arrays, duplicate balances or new users/tenant abstractions.
- Preserve deposited/provisional/twin income, extraordinary payroll semantics, Fondo, compensation, date ordering, UUID idempotence and original XML evidence. Source declarations remain immutable even when line sums reproduce them.
- Raw real data remains outside Git. Production changes use reviewed PRs and deploy-production only; immediately verify STS before read-only production diagnosis.
- Finish monthly-plan acceptance before releasing the next slice; preserve all history and retained recovery resources.

## Progress and next steps

- Read binding autonomous/product/UI/Patrimonio guidance and reviewed all payroll ingestion, month/year/detail, income, compensation and Fondo paths. Monthly plans #180 is merged, deployed and independently accepted after native smoke.
- Independent read-only payroll audit after immediate STS verification: 19 receipts, 192 lines, 19 UUID claims; all UUIDs unique and all claims resolve. All per-kind line sums and the declared net formula match. Preserve 19 zero-value lines and 18 noncash employer Fondo lines. Payroll types are ordinary and extraordinary; complete private evidence is in `/tmp/olbia-native-payroll/`.
- Select this next bounded domain after monthly plans complete. Deploy a legacy payroll/CFDI-claim write guard first, then atomic native receipt/line copy and all operational consumers. Use native UUID uniqueness to replace the separate live document deduplication claim.

## Decisions

### D1 — Use CFDI UUID and ordered SAT lines as domain identity

- Context: Payroll stores month-prefixed document keys, repeated operational JSON and an ordered line array. A separate UUID claim repeats receipt identity. Stored month, SAT line group and noncash Fondo semantics are derivable from typed financial evidence.
- Evidence and uncertainty: All 19 real UUIDs are canonical uppercase UUIDs, payment dates match their calendar month, all source fields are known and all 192 lines use the documented fields. Actual lines include zero amounts and repeated SAT descriptions; those are evidence and must remain distinct ordered rows. The existing parser creates line group/noncash status from kind/type; verify that invariant against every retained receipt before removing redundancy.
- Alternatives and tradeoffs: Keep document routing or an operational JSON array; create synthetic receipt/line IDs; or use native UUID identity with ordered child rows and typed source fields.
- Decision and reason: Use native UUID receipt keys and child PK `(payslip_uuid,position)` plus native FK. Preserve every line in order, including zeros and repeats. Require typed nonnegative safe-integer source totals and line amounts, retain the original source declarations, payment/pay-period dates, employer and S3 evidence coordinates/hash/content type. Derive month from payment date and classification/noncash semantics from SAT kind/type. Native receipt uniqueness provides ingestion idempotence; frozen claims remain recovery evidence.
- Consequences, verification, and revisit conditions: Keep public UUID uppercase and optional-field behavior unchanged; month/year/detail readers return the same domain contracts without command envelopes. Validate all retained fields and derived invariants before migration, test duplicate/concurrent import and receipt/line rollback, and prove identical income/Fondo/compensation/wealth/report results plus XML hashes. Revisit if any retained field cannot be mapped exactly.
- Status: Decided before implementation; all 192 retained classification/noncash invariants, payment/pay-period dates and evidence fields validated privately; exact native schema still requires validation.

### D2 — Stage payroll and its claim guard before copying

- Context: A late legacy upload can write both a claim and receipt after native copy. Guarding only one record family would leave a possible competing authority or phantom claim.
- Evidence and uncertainty: Existing upload writes both records atomically through the same application barrier. Monthly/card staged guards already cover the shared barrier pattern; migration 12 is the next unused marker, subject to fresh preflight.
- Alternatives and tradeoffs: Assume no uploads; dual-write native/document forms; pause all domains; or guard only payroll and its CFDI-specific claim at marker 12 before atomic copy.
- Decision and reason: Deploy the narrowly scoped legacy payroll/CFDI-claim guard first. Then create native constrained tables and copy receipts/ordered lines/marker 12 together under the existing barrier using the official connector’s retrying transaction. Other claim families remain operational. Native imports insert the receipt once and all its lines atomically; on conflict return duplicate without modifying the original evidence.
- Consequences, verification, and revisit conditions: Brief payroll upload maintenance during runtime replacement is acceptable under the established staged cutover. Test all legacy mutation forms, mixed claim/receipt rollback and receipts, copy interruption/replay, and prove no native edits are overwritten. Release native consumers only after guard deployment and acceptance.
- Status: Decided before implementation; monthly acceptance and a fresh base branch remain prerequisites.

## Verification results

Analysis and private live audit completed. Prepared the narrow marker-12 receipt/claim guard on `codex/sql-native-payroll-guard`, created directly from fetched `origin/main` after #180. All four integration cases passed, covering pre-marker UUID idempotence, every late legacy mutation, unrelated claims, mixed rollback/receipts and interrupted cutover. All 489 workspace tests, workspace typechecks and CDK synthesis passed; all 11 protected resource definitions are unchanged. Monthly #180 completed all financial gates and independent post-smoke acceptance with zero mismatches. Guard PR is next, followed by required quality, linear merge, deploy-production and unchanged receipt/claim acceptance.

## Outcome and remaining work

Active. Monthly plans are complete. Implement payroll end to end and continue autonomously until David stops the run.
