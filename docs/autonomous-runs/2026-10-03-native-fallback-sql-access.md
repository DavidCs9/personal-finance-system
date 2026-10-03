# Native fallback SQL access and provider preflight — 2026-10-03

## Objective and completion criteria

Continue David’s authorized autonomous normalization goal. **Olbia must feel born in SQL; David is its sole owner/user.** Fix the concrete deployment coverage gap found while independently reviewing runtime cleanup #200: the deployed Bedrock fallback worker invokes a native SQL guard but has no SQL endpoint/role/IAM grant. Complete the reviewed follow-up, final-head quality, linear merge, production workflow, live configuration/IAM/actual connection proof and unchanged financial/recovery acceptance. Do not stop the overall goal.

## Constraints

Root AGENTS, autonomous rules and product north star apply. Production code and privilege updates only through reviewed PR/quality/deploy-production; no local Lambda configuration edits, production financial writes, test provider extraction or queue sends. Preserve native SQS partial-batch retries/DLQ, Bedrock/S3/SES behavior and every protected resource identity. Use the existing native reader capability, not a new role or retry framework.

## Progress and evidence

#200 final head `eeb81cc3dc8aa25c0b1599462396f63d5a325995` passed required quality 37139910576 and CLEAN/MERGEABLE, squash merged as `5c29b8cbb4b4c3b6f808cf7ab6b01b79a40027a3`; production workflow 37140154790 passed quality/deploy-production and independent complete row/catalog/privilege/original/rollback acceptance at 17:33:30.742Z. A separate STS-confirmed read-only Lambda inspection proves live fallback is Active/Successful but lacks DSQL_ENDPOINT and OLBIA_SQL_ROLE. Synthesized function has no DbConnect association; handler calls assertNativeExceptionAccess before every source/extraction/handoff. Existing tests inject a SQL client and therefore missed deployment wiring. This gap predates #200 and now has a concrete regression check rather than an assumed complete function list.

The new branch starts directly from fetched origin/main at the #200 squash. The required prior #200 deployed row/privilege acceptance is complete before this follow-up merge. Read-only actual catalog inspection also confirms all 323 native/legacy/control constraints validated, 38 native domain relations/24 frozen domain relations, 236 required native columns, 36 native FKs and nine purposeful native JSON columns; no native PK/SK/envelope/payload column remains. Independent #200 originals remain the preserved 64-table/9,384-row baseline. This correction does not alter data/model authority.

## Decisions

### D1 — Give fallback the existing read-only native capability

- Context: The worker reads only migration/control state; extraction and queue handoff never write SQL. Removing the guard would hide the wiring gap and weaken the native boundary.
- Evidence and uncertainty: Actual source code, synthesized IAM/env and live Lambda configuration confirm the missing endpoint/role/connect permission. Existing olbia_store_reader can SELECT schema_migrations/runtime_state and cannot write domain/recovery data. Existing bootstrap already associates validated runtime ARNs and function dependencies.
- Alternatives: Remove SQL guards; grant application writes; create a new SQL-role framework; or use existing grantSqlAccess(reader).
- Decision and reason: Add fallback to the existing native reader wiring/association. No new SQL role, financial write or DynamoDB fallback. Update the infrastructure regression to identify this named worker explicitly, verify its connection resource/role/association/bootstrap dependency and deny source/admin/write IAM. The complete configured native function inventory becomes 17, including the internal operator.
- Consequences and verification: Build/synth must preserve every protected definition, actual read-only SQL permissions, runtime env and role association. Independent live configuration/IAM and a no-provider deployed preflight check must confirm the real worker can reach native state. No real model call or queue handoff in acceptance. Use the existing deployed handler with deliberately malformed JSON and a distinct diagnostic record identifier: both native guards execute before JSON parsing, so a caught SyntaxError plus expected partial-batch result proves the real role connected/read successfully. The job is never constructed, no S3/model/SQS/SES branch is reached, no real queue message or financial history is created, and direct synchronous invocation does not redrive into a queue/DLQ. A local actual-SQL test explicitly verifies this path; no extra diagnostic framework or endpoint is added.
- Status: Provisional; recorded before implementation.

### D2 — Check persisted SQL authority before provider work

- Context: Native exception access proves marker 19, not current authority. After migration a paused worker could extract/forward even though financial transactions reject writes. Initial paused ingestion can also fetch source/queue fallback before reaching its SQL transaction.
- Evidence and uncertainty: Existing worker checks only the migration marker outside transactions. Native assertSqlMutationsAvailable reads persisted control and fails closed on pause/non-SQL/storage failure. Provider acceptance cannot be atomic with SQL; no native gap justifies a custom queue/outbox or retry loop.
- Alternatives: Keep migration-only preflight, remove safeguards, or check persisted authority at initial entry and before existing external extraction/handoff boundaries.
- Decision and reason: Use the shared native SQL guard at ingestion/fallback entry and existing queue/alert handoff checks and retry dispatcher sends; fallback rechecks before model extraction and queue handoff. Keep provider IO outside transaction/retry callbacks, original partial-batch failures and native SQS retry/DLQ. No arbitrary provider sends or financial test events.
- Consequences and verification: Actual SQL worker tests cover sql success, missing marker, paused/dynamodb, driver failure and a pause during extraction before handoff, with no source fallback or fabricated outcome. Legitimate concurrent provider acceptance remains the existing explicit non-atomic boundary, not silently claimed exactly once.
- Status: Provisional; recorded before implementation.

## Verification and remaining work

Implementation is local/unpublished. Fourteen actual native worker tests and ten synthesized IAM/bundle checks pass; five new cases exercise initial pause/non-SQL authority, pause during source/model work and the no-provider diagnostic invocation. The existing bootstrap property gains the reader ARN and therefore reruns reviewed association/grants without a new schema/data migration or bootstrap version. No role/table/model is created. Complete #200 acceptance first, then follow-up final-head quality/merge/deploy and independent live/data acceptance. The refreshed 67-table audit and evidence review remain next, rather than treating every historical text assertion as a missing FK.

Local follow-up checks pass **418 affected consumer tests** (API 380, ingestion 20, infrastructure 18), every workspace type check and CDK synthesis. All 44 protected resource definitions remain exact. The total suite is 774 tests; unaffected 356 tests passed on the accepted #200 base and final-head CI will run the complete suite. The preserved independent #200 post-smoke snapshot at 17:33:30.742Z is copied as this release's private pre-baseline (64 tables/9,384 rows and every catalog/grant fact); original proofs are never overwritten. No new data migration or financial mutation is required.
