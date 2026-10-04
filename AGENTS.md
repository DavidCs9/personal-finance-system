# Repository guidance

## Required reading

Read [product north star](docs/product-north-star.md) before product, architecture, data or UI decisions. It is binding: Olbia is David Castro's private application, with David its sole user/owner. Design and validate for his real finances; anonymization, masking and synthetic datasets are not prerequisites. Existing owner/authentication identifiers protect his access, not a multiuser product. No signup, organizations, sharing, tenants or other users without his explicit decision.

Before persistence work, read [architecture](docs/architecture.md) and [financial rules](docs/financial-rules.md). **OLBIA MUST FEEL AS IF IT WAS BORN IN SQL**, David's explicit decision of 2026-10-01. Domain entities/keys, typed columns, relationships, native constraints, direct SQL and transactions are authoritative. No PK/SK, GSI, document-command emulation, envelopes or projection-first authority under renamed abstractions. All domain readers/writers must use its relational authority; adding columns beside a document source does not finish normalization. Keep JSON only for purposeful evidence/history/provider metadata; preserve financial behavior, originals, history and recovery.

David's explicit decision of 2026-10-04: DSQL contains no migration evidence tables/copies, including in an archive schema. Bootstrap/verifiers must not recreate or depend on them. Preserve native financial history, the three operational controls, S3 originals and native backups; retained DynamoDB is pre-cutover recovery. The [architecture guide](docs/architecture.md#recovery-boundary-and-schema-changes) owns the current retention boundary.

Before planning, implementing or reviewing any user-facing change, read [UI direction](docs/ui-design-brief.md), [web instructions](apps/web/AGENTS.md) and [financial rules](docs/financial-rules.md) completely, including changes outside apps/web that affect visible behavior. Preserve Resumen / Movimientos / Patrimonio. Do not infer a conflicting style, interaction or tone. An explicit personality decision must update the UI guide and web instructions together.

When autonomous or long-running work is authorized, read [autonomous run rules](AUTONOMOUS_RUN_RULES.md) completely and follow them throughout the run.

## Prefer native capabilities

Before a manual infrastructure, observability, logging, authentication, caching, integration or platform solution, verify native provider/framework capabilities. Prefer a native solution meeting behavior, reliability, security and observability requirements. Custom code requires a documented gap and reason the native option is insufficient. Do not duplicate provider-managed telemetry/data capture with application logs for convenience.

## AWS access and production

- Interactive local access uses aws login. When authentication is needed for in-scope work, infer authorization and run it without separate confirmation unless David says not to. Never substitute permanent keys for expired/broken login.
- Verify aws sts get-caller-identity immediately before each production operation.
- Production financial changes use already-deployed authenticated API/domain operations; never write directly to SQL/DynamoDB to bypass mutations, validation or revisions.
- Never deploy code/infrastructure locally: no cdk deploy, direct Lambda update or deployment API shortcut. Production code changes require PR and quality; deploy-production owns deployment after the approved change lands on main.
- Local AWS access may diagnose read-only or perform authorized auditable data operations supported by deployed code. It cannot release unreviewed code. [Operations](docs/operations.md) holds current procedures.

## Pull requests and linear history

1. Fetch the current base; create feature branch directly from origin/main.
2. Before final push, git fetch origin and git rebase origin/main.
3. Resolve conflicts intentionally, stage resolved files and git rebase --continue.
4. Never merge main into a feature branch.
5. If rebasing an already-pushed branch, git push --force-with-lease, never --force.
6. Wait for required quality and confirm CLEAN/MERGEABLE before merging.
7. Squash or rebase merge only; never Create a merge commit. Respect any user instruction to stop before merge.

Preserve unrelated user changes. If rebase could overwrite or ambiguously combine them, stop and request direction.

## Documentation

Keep only the six current guides linked from [README](README.md) under docs/. Give each rule one canonical home; instruction files enforce/link it. Completed features/runs do not earn permanent pages. Keep resumable run notes and execution logs local only under Git-ignored work-notes/; never stage, force-add, commit or push them. Keep useful completed notes locally and extract lasting decisions into existing guides. Git retains previously committed history; no docs archive folder. Prefer omission over speculative, duplicated or historical guidance.
