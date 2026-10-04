# Clean DSQL catalog — 2026-10-04

## Objective and completion criteria

David explicitly requests a clean DSQL database with no migration evidence. Retained DynamoDB is the migration recovery source. Remove the 24 frozen domain relations, projection_state and command_receipts from DSQL; remove bootstrap recreation and deployed dependencies; preserve all 38 native domain tables, current financial evidence/history, required operational controls and native recovery. Complete reviewed PR/quality/linear merge/deploy-production and independent production acceptance.

## Constraints

- Product remains David's private SQL-native financial system.
- No local deployment, ad hoc production schema mutation, or DynamoDB mutation. Destructive DSQL cleanup is explicitly authorized by this request and executes only through reviewed deployment.
- Preserve native financial observations, revisions, import sources and captures: they describe finances, not migration.
- Verify retained DynamoDB and native database recovery before removal. Keep private diagnostics outside Git.
- Existing historical retention guidance is superseded by David's explicit decision for DSQL migration copies; record the updated north star.

## Progress and next steps

- Read product north star, complete normalization/table audits and autonomous run rules.
- Clean checkout; fetched origin/main and created codex/clean-dsql-catalog directly from it.
- Verified local short-term AWS identity and GitHub access. Production currently exposes the retained DynamoDB table and DSQL cluster.
- Identified 26 frozen relations, bootstrap creation/grants, retired maintenance/replay flows and verification dependencies.
- Fresh read-only baseline at 2026-10-04T17:17:21.210Z: 67 tables, 9,426 rows, 328 constraints, 92 indexes, SQL authority and markers 1–20. Private complete rows/catalog are outside Git.
- Retained DynamoDB is ACTIVE, deletion protected and has 35-day PITR enabled. Native DSQL backups completed October 1–4; October 4's scheduled backup is complete. No reconciliation execution was running during inspection.
- Native-only bootstrap replaces all projection creation/copy/grants; old schema and migration comparison fixtures are isolated under test/helpers.
- Current financial/plan/wealth/import/exception/workflow verifiers no longer depend on retired SQL copies. Original S3 hashing remains; payroll also compares native receipt/lines directly with the original XML.
- Reviewed post-deployment cleanup checks DynamoDB recovery, current authority/catalog/validated constraints and dependencies, executes explicit RESTRICT drops in dependency order, validates the unchanged native catalog and records marker 21. Subsequent bootstrap never recreates copies.
- Focused cleanup/bootstrap/control/runtime tests: 34 passed. Deployment shell/recovery tests: 22 passed. All ledger/API/infrastructure typechecks passed. Broad tests exposed old comparison-counter expectations and CPU-contention timeouts; correcting expectations and using bounded local test concurrency.
- Full API suite: 380 passed; ledger suite: 268 passed; added native provenance clean-catalog regression: seven cases passed. All workspace typechecks, web production build and CDK synthesis pass. Notify: 14 passed; infrastructure deployment/recovery Python: 22 passed. Native-only bundle regression passes (ten cases).
- Clean-catalog real-data rehearsal: all 41 current tables loaded from the complete private production snapshot, including 504 movements. Actual financial, provenance, plan/payroll, wealth, domain, operational and original-object gates pass with zero mismatches and zero frozen tables. PGlite exposes NOT NULL as additional constraints (535); production native constraints remain 297.
- Production metadata preflight ran the seven SELECT queries through the first-DROP boundary, with a wrapper refusing all non-SELECT statements. Both actual FK and view dependency catalogs work in DSQL. No DROP or other production SQL mutation occurred.
- Synthesized DDB/DSQL/S3/KMS/backup definitions match production exactly, and stable named Lambda identities; only the expected old immutable Lambda version is replaced.
- Next: final-head required quality, linear merge, deploy-production and independent clean-catalog acceptance.

## Decisions

### D1 — Migration copies versus actual financial history
- Context: DSQL mixes the live domain model with frozen DynamoDB-derived copies and migration machinery.
- Evidence and uncertainty: accepted October 3 audit lists 38 native domain relations, 24 frozen domain relations and five controls. DynamoDB is retained; fresh production inspection confirms the retained source and current catalog.
- Alternatives and tradeoffs: moving copies to an archive schema would preserve DSQL clutter and contradict the request; deleting financial history would weaken the current domain model.
- Decision and reason: remove all 26 frozen domain/control relations and their runtime dependencies. Preserve actual native financial history and the three current operational controls. Use retained DynamoDB for pre-cutover migration recovery and native DSQL backups for current finances.
- Consequences, verification, and revisit conditions: catalog drops from 67 to 41 base tables. Check exact retained rows, constraints/grants, originals, deployed queries and rolled-back writes. Never use CASCADE to hide dependencies.
- Status: implemented and locally verified; reviewed release pending.

### D2 — Destructive DDL ordering and restart
- Context: schema bootstrap runs before some dependent Lambda updates; deleting immediately could strand an old verifier. DSQL supports one DDL statement per transaction and cannot combine DDL/DML.
- Evidence and uncertainty: current product consumers already use native tables, but deployed migration verification still reads frozen copies. Existing schema Lambda is the scoped admin provider; normal deployment already invokes native read/rollback gates. [Native DSQL DDL rules](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-ddl.html) confirm independently committed statements and native OCC retry.
- Alternatives and tradeoffs: dropping inside bootstrap risks old verifier ordering; a separate local SQL cleanup bypasses the binding deployment workflow; a new migration framework adds unnecessary machinery.
- Decision and reason: reuse the reviewed schema provider's internal cleanup action, invoked exclusively by deploy-production after the newly deployed native catalog, original-evidence/financial and fully rolled-back write gates pass. Re-run read/evidence/write gates after deletion. Keep managed resource identities stable and disable all projection/replay behavior.
- Consequences, verification, and revisit conditions: incomplete cleanup is resumable with IF EXISTS; no marker 21 before all drops and native catalog checks succeed. DDB recovery failure, unexpected current tables, invalid native constraints or external FK/view dependencies block before the first DROP. CloudFormation Delete performs no SQL mutation. Validate actual DSQL metadata queries read-only before release.
- Status: local restricted/drop/resume/dependency tests validated; production release pending.

## Verification results

Pending.

## Outcome and remaining work

Work in progress; no production changes performed.
