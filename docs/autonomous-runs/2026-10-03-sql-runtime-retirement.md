# Native SQL runtime and recovery boundary — 2026-10-03

## Objective and completion criteria

Continue David’s unbounded normalization goal until he stops it. **Olbia must feel born in SQL. David Castro is its sole user and owner.** After independently accepting the complete native exception release #199, retire the remaining product runtime dependencies on document-command emulation and DynamoDB read selection. Preserve every original recovery row, provider/financial correctness, shared SQL transaction context/barrier/OCC behavior and deployed independent gates. Deliver through final-head required quality, linear merge, deploy-production and independent real-data unchanged-row/privilege/runtime acceptance before choosing another slice.

## Constraints

Root AGENTS/autonomous rules/product north star apply. No private originals in Git, direct production data writes, local deployment, tenants or additional provider frameworks. Native DSQL connector transactions and conflict retries already meet the transaction need; do not replace them with a custom retry loop. Keep the frozen DynamoDB table, streams/recovery backups and explicitly isolated migration/reconciliation functions. Native relational evidence/history JSON remains purposeful.

## Progress and evidence

Read-only code audit while #199 deploys finds no product document-command consumers. Two historical verification paths still use SDK paginateQuery/paginateScan through createApplicationStore; in SQL mode those repeatedly select all projection_state envelopes and emulate filtering/pagination in JavaScript. The API-wide provider module also initializes that factory and requires METADATA_TABLE_NAME solely for these audit paths. No product consumer remains for selectLedgerRead/observe or DSQL_OPERATIONAL_READ_MODE. Cards, monthly plans and payroll still enter transactions via the legacy document class, despite their statements already being native SQL. Other domain operations share the same AsyncLocalStorage and direct connector callback correctly.

Current grant bootstrap broadly grants legacy tables to application/operator roles before revoking selected families. This is unnecessary once all domains are native, and leaves privileges broader than the intended recovery boundary. Preserve reader/writer native grants and shared application_barrier; scope old projections/envelopes/command receipts to read-only recovery/verifier roles. Provider IAM still grants frozen DynamoDB reads to product functions that no longer use them; remove those product permissions and environment variables, keeping explicit migration/reconciliation recovery access.

The new branch starts directly from fetched origin/main at the native exception squash `326df5db8665d165ff14bb38995e4ed2b5c2452f`. Production #199 acceptance passed independently at 2026-10-03T16:43:34.176Z: all 59 original tables exact, native eight/four/three facts, seven live originals, 336 permission assertions and deployed financial/gate/rollback checks pass. Native runtime implementation is now local and unpublished; deployed privileges remain the initial catalog baseline until the reviewed production workflow completes.

## Decisions

### D1 — Make native SQL context/transactions the product runtime

- Context: No active domain needs document commands, but the shared runtime imports the SDK/emulator and three native writers enter through its transaction method. Optional old flags can bypass that transaction and expose SQL writes without the shared barrier.
- Evidence and uncertainty: All native domains through marker 19 are deployed/accepted. Existing AuroraDSQLPool.transaction already owns OCC retries; current native helpers directly delegate to it. No external provider IO is needed in these callbacks. Only historical tests require the document adapter and its earlier marker guards.
- Alternatives: Retain the SDK factory as the public runtime or extract a native SQL context/control/transaction module and isolate the historical adapter from every production import/export.
- Decision and reason: Extract explicit sql-runtime helpers with SQL names, keep one AsyncLocalStorage context and the existing barrier/mode check/connector retries, route every current consumer through this module and move the legacy document adapter to an explicitly historical, unexported source used only by migration tests. Replace cards/plans/payroll wrappers with the same direct native transaction. Remove unused document factory, read-mode selector/metrics and environment flags. Product mutations require persisted SQL mode regardless of obsolete flags; no source fallback.
- Consequences and verification: Actual nested commit/rollback, provider callback retry, mode/pause/sanitized failure, no metadata-table dependency and all current domain gates must pass. Keep historical adapter tests to verify retained migration evidence; do not introduce a custom transaction retry. Revisit only for a demonstrated missing native connector capability.
- Status: Provisional; persisted before implementation.

### D2 — Read frozen audit envelopes with bounded native SQL pagination

- Context: Historical verifiers still ask a DynamoDB-shaped adapter for Query/Scan and repeatedly transfer/filter complete source envelopes, although the persisted authority is SQL and the comparison source is frozen projection_state.
- Evidence and uncertainty: Actual deployed gates verify retained SQL snapshots rather than reading frozen DynamoDB after cutover. Planning needs owner/month/payroll prefixes; operational inventory needs the complete retained live envelope inventory and independent classification. Immutable source_item is justified recovery evidence, not current product authority.
- Alternatives: Keep SDK emulation, compare projections to themselves (weakens independence), or query the separate frozen envelope source with native parameterized keyset pagination in the verifier snapshot.
- Decision and reason: Use bounded native SQL reads of projection_state with complete original source_item and source-key pagination solely inside the isolated audit boundary. Preserve independent classification/column oracles, historical expiration rules and corrupted/missing-row detection. Remove database/tableName from the shared API provider module.
- Consequences and verification: Compare every real original envelope and nine operational families, forced multi-page/tie/owner/prefix/tombstone boundaries and full financial/evidence gates. Actual role enforcement must deny this source to products while allowing the verifier. No change to frozen DynamoDB or backup/recovery records.
- Status: Provisional; persisted before implementation.

### D3 — Enforce the frozen recovery boundary with native privileges

- Context: Legacy privileges remain after native cutovers. Administrative read-only inspection of all 67 tables/663 columns/323 validated constraints/92 indexes finds application/operator still have 64 allowed privileges on 16 legacy tables, including 48 mutation privileges each; projector has 45 mutation privileges on originals. No current product consumer needs them.
- Evidence and uncertainty: All original baselines and native domains are independently accepted. Current maintenance under SQL authority only verifies; stale stream/replay work returns without re-projecting. A future return to a pre-cutover recovery authority already requires an explicit reviewed transition and acceptance/copy-back of newer native data.
- Alternatives: Keep unnecessary privileges with application-only guards or revoke every legacy projection/envelope/command-receipt privilege from product roles and make retained recovery/verifier access SELECT only.
- Decision and reason: Use native SQL GRANT/REVOKE to freeze all 24 legacy domain tables, projection_state and command_receipts. Keep application_barrier and persisted authority controls scoped to their existing native roles. Keep only isolated projector/verifier SELECT on original recovery tables, no legacy mutation privilege. Remove product DynamoDB IAM read permissions and METADATA_TABLE_NAME while retaining explicit schema/migration/reconciliation recovery capabilities and protected resource identities. Bootstrap grants/revokes through the normal reviewed deployment; no manual production privilege change.
- Consequences and verification: Actual local six-role denials and native smoke, complete live privilege matrix and original-table equality, exact protected identities and native IAM policy scope. A deliberate historical recovery transition must explicitly restore needed capabilities through its reviewed PR; changing a mode/flag alone is insufficient. No physical recovery table/DynamoDB deletion.
- Status: Provisional; persisted before implementation.

## Implementation checkpoint

Native SQL helpers now own the single context/barrier and delegate transactions/retries to the official connector. Every active domain imports those helpers; the historical document class is unexported and used only by retained migration tests. Product API/ingestion manifests no longer declare DynamoDB production dependencies. Two frozen-source gates use bounded parameterized SQL keyset reads in the verifier context; domain readers remain native. Unused read-selection flags/factory and product metadata-table configuration/data IAM grants are removed.

Bootstrap version 22 freezes the complete 26-table recovery boundary with native GRANT/REVOKE, including existing privileges rather than only changing fresh grants. Application/operator barrier INSERT/DELETE are explicitly revoked; SELECT/UPDATE and the existing operator authority permission remain. Explicit migration/reconciliation stream/backup resources retain their identities/access. Disabled provider stream mappings remain intact; stream-read IAM is distinct from removed table-data access. Product and internal cutover bundles carry no DynamoDB SDK/table dependency.

Focused verification passes seven actual SQL runtime cases, four forced pagination cases, 18 affected API consumers, and actual six-role permissions on all 26 frozen tables. Bundle and synthesized IAM checks pass for 16 configured native functions and separately check fallback/agent bundles. The deployment check found and removed one leftover cutover metadata-table setting. The full workspace suite passes all **769 tests** with two workers per workspace. The first run exposed eight orchestration tests relying on obsolete flag bypass/default DynamoDB mode: pure provider-injected tests now explicitly mock their independent preflight, actual default worker tests activate persisted SQL and also prove paused/DynamoDB authority never sends. No product guard is weakened. Release and independent live acceptance remain pending.

## Verification results

#199 completed required final-head quality, linear merge, production workflow 37137049516 and independent acceptance. Its private native release baseline remains all 59 original domain tables/6,893 rows. No live financial/provider mutation is used for verification.

Fresh read-only runtime-release baseline at `2026-10-03T17:13:46.189Z`: **64 domain/recovery tables, 9,384 rows, 663 columns, 323 validated constraints, 92 indexes, 1,608 table and 11,934 column privilege assertions**. The five storage/control tables are retained; only authority/barrier/schema control rows are excluded from exact financial/recovery row equality. `projection_state` and `command_receipts` are included. STS verified the existing AWS login immediately before all production SELECTs. Baseline/catalog originals remain private in the mode-0700 durable directory `~/.local/share/olbia-normalization/2026-10-03-sql-runtime-retirement/`, files 0600, and are never overwritten. After deployment verify all 64 tables exactly and every native privilege unchanged apart from the explicitly scoped recovery/barrier revocations; assert the complete 624 recovery-table permissions and every column grant, independent originals and deployed gates.

Local complete verification: **769 workspace tests, every workspace TypeScript check, 21 Python recovery tests, web build and CDK synthesis pass**. All **44 protected resource definitions** are byte-for-structure identical to the independently retained pre-release template. Actual built handlers exclude both DynamoDB SDK modules, legacy adapter/table configuration and obsolete runtime flags; synthesized native function IAM has no DynamoDB table-data actions, while disabled mapping stream reads and explicit recovery resources remain. Final-head required quality, merge, production workflow and independent live acceptance are still required.

## Outcome and remaining work

Implement the persisted runtime/recovery decisions and bounded cleanup and verify actual nested/rollback/conflict/pause/provider behavior, independent historical pagination and exact original evidence, SQL roles and native IAM scope. The unbounded goal stays active.
