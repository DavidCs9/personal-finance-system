# Native SQL controls and refreshed table audit — 2026-10-03

## Objective and completion criteria

Continue David’s authorized autonomous normalization. **OLBIA MUST FEEL BORN IN SQL. David is its sole owner/user.** Audit every current table, resolve evidence-review findings without invented repairs, and enforce the concrete native storage/control invariants found in the real catalog. Complete code, all consumers and permissions, tests, final-head PR quality/CLEAN/MERGEABLE, linear merge, deploy-production and independent real acceptance. Continue choosing slices until David stops the overall goal.

## Constraints

Root AGENTS, autonomous rules and product north star apply. No UI/product change, financial repair, original/evidence deletion or local production SQL/infra mutation. Production schema/grants only through reviewed bootstrap/PR/quality/deployment. Retain provider-managed resources, native OCC transactions and reviewed recovery modes. Keep private rows/source originals outside Git, 0700 directories/0600 files.

## Progress and next steps

Fresh feature branch starts directly from fetched origin/main at #201 squash `a9e3f45996201cfb78cb79db0622cdd6d8d6ba0a`. #201 final-head quality and main deployment succeeded; independent real IAM/connection and data/original/rollback acceptance completed before this slice. The live catalog contains 67 base tables (38 native domains, 24 frozen historical domains, five storage/control relations), 663 columns, 323 validated constraints and 92 indexes. All native domain tables lack DynamoDB routing/envelope columns. Three operational controls currently have only primary-key constraints despite fixed singleton identities, finite authority modes and positive/nonnegative counters. These are current structural gaps, unlike intentionally retained historical financial assertions.

## Decisions

### D1 — Native constraints and column grants for the existing controls

- Context: runtime_state/application_barrier identities can currently be updated by table-wide UPDATE grants. Invalid mode, negative barrier generation and nonpositive migration version have no SQL check. These controls protect native financial transaction authority/OCC ordering.
- Evidence and uncertainty: Read-only real catalog and deployed callers show runtime id and barrier id always storage; modes are dynamodb/paused/sql; all updates target generation or mode/changed_at. Bootstrap alone creates singleton rows/migration facts. Native DSQL supports ADD CHECK NOT VALID followed by asynchronous validation; the existing resumable helper already implements this provider capability. See [official ALTER TABLE documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html).
- Alternatives and tradeoffs: Leave application-only invariants; create a new control framework; or constrain the existing native tables and scope existing writer columns.
- Decision and reason: Add five named CHECKs (runtime identity/mode, barrier identity/nonnegative generation, positive migration version), validate all actual rows through the existing helper, and record marker 20 only after all bootstrap/native migrations and grants succeed. Revoke table UPDATE on the barrier for application/operator/projector and grant UPDATE(generation); scope operator runtime UPDATE to mode/changed_at. No new SQL role, fallback, counter cap, manual validation loop or singleton abstraction. Bump the reviewed bootstrap version to rerun native grants/DDL.
- Consequences, verification and revisit conditions: Old functions already update only allowed columns, so this is compatible without financial staging/copy. Real SQL role tests must prove allowed authority changes and barrier increments, reject identity changes/invalid controls, and preserve rollback. Independent live acceptance permits only five exact added validated constraints, marker 20 and these exact grant changes; financial/recovery rows and all other catalog/grant facts must remain exact. A legitimate new authority mode requires an explicit reviewed constraint change.
- Status: Provisional; recorded before implementation.

### D2 — Evidence signatures are review candidates, not event identities

- Context: The initial audit flagged five pairs of accepted movements with matching date/merchant/amount signatures. Normalization must not destroy legitimate source records or existing rejected history.
- Evidence and uncertainty: Six original S3 files freshly downloaded/hash-verified outside Git. Three pairs appear as two separate printed statement rows (relevant complete PDF pages visually inspected); one CSV pair has distinct bank transaction IDs/row identities. Two separate email notices have additional CSV corroboration with two distinct posted bank rows; those CSV-linked financial records are already rejected through retained immutable status revisions. Exact email-to-bank one-to-one pairing is not proven, and posted/auth amounts differ. All four cross-source entries are not counted as accepted spending.
- Alternatives and tradeoffs: Merge/delete by comparison signature, invent an email-to-bank identity, or preserve facts and close the unsupported duplicate-repair recommendation with precise evidence boundaries.
- Decision and reason: Preserve all five pairs and their history; document direct source distinctions/corroboration and the existing rejected cross-source records. No confirmed duplicate capture warrants financial repair. Historical import selection/candidate text IDs remain immutable assertions, not invented FKs to current mutable movements.
- Consequences, verification and revisit conditions: Refreshed audit identifies every current relation/key/FK/check/required column/JSON purpose and classifies frozen recovery evidence separately. New original evidence or David’s financial decision may justify reconciliation later; normalization alone does not.
- Status: Validated by original review and actual current status/revision inspection; recorded before documentation/model work.

## Verification results

Pending implementation, PR, CI, deployment and independent acceptance.

## Outcome and remaining work

Continue the overall goal after this slice. Retained evidence is deliberately recoverable; deleting it or replacing native provider services is outside this slice.

Local complete suite exposed one unrelated elapsed-clock defect in the actual native ingestion test: the fixture occurrence/received dates are fixed to October 2 but Apple Pay handler receipt time used the current real clock. Once more than the legitimate 30-hour foreign reconciliation window elapsed, the test stopped matching. Production reconciliation logic is unchanged; the handler test now pins Date alone to its stated fixture time, retaining real SQL/asynchronous execution and removes obsolete document-store env fixtures. All other 778 tests passed; rerun the affected API suite before release. Initial new control fixture also needed native marker 14/primary-ownership setup, matching the existing actual-role harness; this was corrected without bypassing control validation.

Every workspace TypeScript check, 21 Python deployment/recovery tests, web build and CDK synthesis pass. **47 protected definitions** (the existing 44 plus three bucket-policy resources) are structurally identical to the independently retained pre-release template. The fresh private pre-release baseline at 19:48:18.342Z preserves all 64 domain/recovery tables/9,390 rows and the complete column/constraint/index/table-column grant catalog; control rows/constraint definitions are captured separately. These read-only proofs contain ongoing legitimate product activity since #201 and are never substituted for earlier original baselines. Required final-head CI and deployed acceptance remain pending.

Local verification is complete: **779 workspace tests pass** across the complete run and corrected affected API rerun (380/380); the five new actual-control SQL cases and 12 bootstrap checks pass. Every workspace type check, 21 Python checks, web build and synthesis pass; 47 protected definitions remain exact. Documentation mechanically covers all 67 actual table names and its native counts/keys/JSON field names agree with the private catalog. No financial code path or provider behavior changed. The release still requires final-head quality/CLEAN/MERGEABLE, linear merge, deploy-production and independent explicit expected-delta acceptance.
