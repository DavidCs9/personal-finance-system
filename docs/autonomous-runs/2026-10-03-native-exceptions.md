# Native ingestion exceptions and retries — 2026-10-03

## Objective and completion criteria

Continue David's indefinite normalization goal until he stops it. **Olbia must feel born in SQL; David Castro is its sole user and owner.** Complete the remaining exception/exception-claim/retry domain end to end: auditable native evidence and relationships, every producer/product reader/mutation/dispatcher/completion, constraints/grants/atomic copy/independent gates/rollback smoke, staged PR quality/linear merge/deploy-production and independent acceptance. Preserve existing review/discard/retry behavior and native provider retries/queues/DLQs. No real retry, alert or financial change is performed for verification.

## Constraints and baseline

Root AGENTS, autonomous rules, product north star, UI brief, web AGENTS and Patrimonio apply. Do not introduce users/tenants, mask real data as a prerequisite or publish private evidence. All code releases use PR/quality/deploy-production; local production diagnosis is read-only with immediate identity verification. Preserve financial correctness and all original evidence. Native SES/SQS/Scheduler retry/DLQ capabilities remain the provider responsibilities; custom infrastructure requires a documented native-capability gap.

The authenticated SELECT-only baseline at `2026-10-03T08:47:06.541Z` retains eight exceptions, four exception claims and three dispatched retry tasks. Four exceptions have discard facts; three retries are completed and resolve to actual native movements. Every source has bucket/key/SHA-256/content type. All three tasks resolve to their exception and match its bucket/key/received timestamp; task creation exactly equals requestedAt and dispatch precedes completion. All three historical tasks use the old singleton dispatch key, and their completed retry facts contain no requestId. Their job sources preserve only bucket/key, while the parent source also carries original hash/type. Absence of optional historical fields must not be invented as new provenance. The later independent original-byte audit below closes the source and claim relationship uncertainty.

Conversation metadata #197 passed final-head required quality 37111084990 at 47039bd1606ac77d423a968f2c17a8987a1a3487, CLEAN/MERGEABLE; production workflow 37111313040 and independent acceptance at 2026-10-03T14:49:09.765Z passed before preparing this next prerequisite. Private baseline remains under `/Users/decs/.local/share/olbia-normalization/2026-10-03-native-threads/`; private exception evidence belongs in its own 700 directory/600 files.

## Decisions

### D1 — Complete the exception/claim/retry workflow together

- Context: Exceptions, suppression claims and retry dispatch/completion still depend on document envelopes and nested mutable state. Splitting these related operations would leave the same workflow with two authorities.
- Evidence and uncertainty: Eight headers/four claims/three tasks are bounded. Product requestRetry atomically queues a task and marks current retry; the dispatcher sends then records dispatch; ingestion writes claims+exceptions and records failed/completed retry outcomes. The older real tasks have no UUID despite current requests generating one. Claim documents have no explicit exception parent; independent original-email proof is still needed.
- Alternatives: Normalize only display headers, invent identities/parents from modern assumptions, or audit and migrate the whole bounded workflow while preserving known facts and explicit historical gaps.
- Decision and reason: Choose the complete exception/claim/retry domain next. Independently verify original MIME hashes and deduplication mappings, preserve all historical facts, and constrain only relationships established by evidence. Do not fabricate request UUIDs, delete old errors or regenerate sources. Decide the final relational model after this audit and rollout protection.
- Consequences and verification: Exact eight/four/three copy and original-byte proof, actual retry/discard/claim/dispatch/outcome primitives and provider-failure/rollback tests with injected IO. Existing SES/SQS acceptance-versus-storage ambiguity stays explicit. No real retry or alert is sent for verification.
- Status: Validated for slice selection and original-source/claim audit; staged protection and the native release remain required.

## Progress and next steps

Conversation acceptance and independent exception evidence audit are complete. Release the staged guard from fresh origin/main, then persist the final relational model decision before implementing native readers/writers. A prerequisite alone is not domain completion. Overall autonomous goal stays active.

## Verification results

Read-only metadata audit verifies three resolving exception/task/movement relationships and exact request/received/dispatch ordering. The local staged guard passes all 732 workspace tests, every workspace typecheck, 21 Python deployment checks and synthesis. All 44 retained/identity protected resource definitions remain exact. Fourteen new cases exercise actual SQL store, API operations, ingestion/fallback and scheduler with only external provider IO injected; activation during preparation/dispatch/model/source work fails closed, and native SQS partial failures preserve retries.

## Outcome and remaining work

The native exception model is in analysis. The staged guard is implemented and locally verified; required final-head quality, linear merge, production deployment and independent unchanged-data acceptance remain pending.

Independent original-byte audit at `2026-10-03T14:38:09.734Z` verified all eight recorded MIME hashes across seven actual encrypted S3 objects. RFC message IDs and exact original bytes reproduce every suppression claim's source dedupe/hash mapping: all four claims resolve to exactly one exception, none are ambiguous/unresolved, and four older exceptions have no claim. Preserve those absent claims; do not fabricate coverage. Private original bytes/proof live under `/Users/decs/.local/share/olbia-normalization/2026-10-03-native-exceptions/` (700 directory/600 files). This proves a real optional claim-to-exception FK rather than a document-key relationship.

### D2 — Stage complete old workflow protection before marker 19

- Context: Old API mutations, scheduled SQS dispatch, ingestion completion and SES exception alerts can cross native activation while still using frozen exception/claim/retry documents. Protecting only table writes does not protect external sends.
- Evidence and uncertainty: All three record families mutate through the existing SQL store/barrier. Product list/raw/discard/retry operations are centralized; ingestion and Bedrock fallback handlers already return SQS partial batch failures. Retry dispatcher sends then marks dispatched. Existing native financial source claims deduplicate financial retry independently of exception bookkeeping.
- Alternatives: Depend on deployment timing or deploy a separate marker-19 prerequisite. The staged guard has proven safe across prior domains and avoids dependency cycles.
- Decision and reason: Deploy marker checks at old product operations and configured read selection, ingestion/fallback per-record entry and immediately before external queue/alert calls, and scheduled dispatch entry/send. Freeze all three old families in the shared store transaction. Reuse SQL clients and the maintenance/storage error contract; preserve existing native SQS retries/partial failures/DLQs, without new infrastructure or custom retry loops. Do not create marker 19 in this prerequisite. Read-only retained inventory remains isolated and available.
- Consequences and verification: Before-marker behavior, post-marker zero provider/document IO, activation during preparation/dispatch/extraction, sanitized SQL failure and both mixed/enclosing transaction rollback. Existing provider IO accepted before activation cannot be rolled back; no exactly-once claim is introduced. Required quality/deployment and independent unchanged-data acceptance precede native release. Conversation acceptance must finish before this guard PR is released.
- Status: Provisional; guard implementation and local checks pass, production acceptance remains required.

Conversation prerequisite complete: #197 is deployed and independently accepted at 2026-10-03T14:49:09.765Z. All 35+1 native metadata fields, ten constraints/ten required columns, 150 privileges and actual live 13-session listing pass. Every original baseline row remains exact; the two later scheduled wealth captures/children have independently validated original-byte financial proof. Exception guard branch codex/sql-exception-cutover-guard starts directly from fetched origin/main at 9ebb85a970355f65eda0bf3ac32070bbbd0270d0. Guard code is local/unpublished; no marker 19 exists.

Guard release checkpoint: authenticated SELECT-only baseline at `2026-10-03T15:03:09.117Z` contains all 59 non-control tables/6,893 rows, exactly eight exceptions/four claims/three tasks, conversation marker 18 active and exception marker 19 absent. Private complete baseline and acceptance script remain outside Git under the exception run directory. No source, claim, retry, alert or financial operation was executed in production.
