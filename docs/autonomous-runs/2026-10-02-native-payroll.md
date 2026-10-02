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
- Status: Decided before implementation; all 192 retained classification/noncash invariants, payment/pay-period dates and evidence fields validated privately; native schema and local financial/service tests validated; live native acceptance remains pending.

### D2 — Stage payroll and its claim guard before copying

- Context: A late legacy upload can write both a claim and receipt after native copy. Guarding only one record family would leave a possible competing authority or phantom claim.
- Evidence and uncertainty: Existing upload writes both records atomically through the same application barrier. Monthly/card staged guards already cover the shared barrier pattern; migration 12 is the next unused marker, subject to fresh preflight.
- Alternatives and tradeoffs: Assume no uploads; dual-write native/document forms; pause all domains; or guard only payroll and its CFDI-specific claim at marker 12 before atomic copy.
- Decision and reason: Deploy the narrowly scoped legacy payroll/CFDI-claim guard first. Then create native constrained tables and copy receipts/ordered lines/marker 12 together under the existing barrier using the official connector’s retrying transaction. Other claim families remain operational. Native imports insert the receipt once and all its lines atomically; on conflict return duplicate without modifying the original evidence.
- Consequences, verification, and revisit conditions: Brief payroll upload maintenance during runtime replacement is acceptable under the established staged cutover. Test all legacy mutation forms, mixed claim/receipt rollback and receipts, copy interruption/replay, and prove no native edits are overwritten. Release native consumers only after guard deployment and acceptance.
- Status: Decided before implementation; guard #181 deployed/accepted and fresh base branch established; native release remains pending.

### D3 — Bound atomic ingestion and verify the current native authority

- Context: Native UUID/date/FK types cover the domain, but DSQL permits at most 3,000 mutated rows per transaction. Frozen payroll no longer grows after cutover, so future native imports cannot be compared against an obsolete live document collection.
- Evidence and uncertainty: AWS supports UUID/date/bigint, native PK/FK/CHECKs and asynchronous indexes. The initial copy is 19 receipts plus 192 lines, well within the transaction limit. All retained dates, evidence fields and derived classifications match. Current XML parsing accepts up to 2 MB; a pathological file could exceed the native child-row budget.
- Alternatives and tradeoffs: Add staged partial receipts/chunked ingestion; persist a competing JSON array; leave oversized imports to fail late; or keep receipts atomic and validate the native budget before S3/storage work.
- Decision and reason: Native `payslips` uses UUID PK, typed payment/pay-period dates, MXN source totals, employer, ingestion time and explicit XML evidence fields; `payslip_lines` uses `(payslip_uuid,position)`, FK, SAT kind/type/code/concept and nonnegative safe MXN amount. Use positions 0–2997, reserving one header and one application barrier row, and reject oversized receipts before uploading evidence. Store no derived month, line group/noncash flag or currency duplicates. SELECT/INSERT-only operational grants enforce immutable receipt/line evidence. Use a native payment-date index. New SQL readers return public uppercase UUIDs and calendar dates directly.
- Consequences, verification, and revisit conditions: Initial copy validates list shape/classification, native budget and real fields before atomically copying plus marker 12. Independent acceptance proves exact baseline parity. Deployed verification checks native typed-to-domain mapping/constraints/membership and XML hashes, while frozen document/checkpoint parity stays a separate evidence gate. Financial comparisons use the current native payroll collection on both source-movement and SQL-movement paths, so future legitimate imports do not fail because frozen evidence lacks them. Tests cover imports after cutover, ordered zeros/repeats, empty lines, invalid UUID lookup, native failure without fallback, duplicate/race rollback and financial results. Revisit chunking only for a real David receipt beyond the native budget.
- Status: Decided before implementation. Native references: [data types](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html), [constraints](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html), [transaction limits](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html).

## Verification results

Analysis and private live audit completed. Prepared the narrow marker-12 receipt/claim guard on `codex/sql-native-payroll-guard`, created directly from fetched `origin/main` after #180. All four integration cases passed, covering pre-marker UUID idempotence, every late legacy mutation, unrelated claims, mixed rollback/receipts and interrupted cutover. All 489 workspace tests, workspace typechecks and CDK synthesis passed; all 11 protected resource definitions are unchanged. Monthly #180 completed all financial gates and independent post-smoke acceptance with zero mismatches. Guard PR #181 passed quality, was CLEAN/MERGEABLE and squash-merged as `d37da4c`. Production workflow `36974963387` completed successfully with zero financial/domain/wealth/operational mismatches and rolled-back native smoke. Independent guard acceptance confirms all 19 receipts and 19 claims unchanged, with migration 12 absent. Guard prerequisite satisfied. Created `codex/sql-native-payroll` directly from fetched `origin/main`. Native implementation is prepared: direct typed month/year/detail readers and atomic UUID/line insertion, immutable SELECT/INSERT grants, native date index, no payroll SDK commands/keys/read fallback flag, and current-native verification with independent frozen evidence. Five native migration/constraint tests and five native service tests pass; the eight existing financial tests cover native-only post-cutover receipts, preserved money/Fondo/as-of semantics and frozen pagination/parity. All 499 workspace tests, workspace typechecks and synthesis passed, with 11 protected resources unchanged. A fresh read-only live preflight verified the actual SQL decoding query exactly against all 19 receipts/192 lines. Final checks after removing unused legacy readers passed again: all 499 workspace tests and workspace typechecks. Native PR and exact deployed acceptance are next.

## Outcome and remaining work

Active. Monthly plans are complete. Implement payroll end to end and continue autonomously until David stops the run.
