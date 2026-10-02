# DSQL retained operational state and display reads

For current write authority and recovery, see [the coordinated SQL cutover](dsql-write-cutover.md). The phase evidence below records the earlier projection/read rollout.

This phase adds schema/transformer 4 and bootstrap provider 7. DynamoDB remains every writer, strongly consistent freshness reference and authoritative decision. Shadow PR #164 and separate guarded promotion #165 both passed their approved production workflows and full independent verification with zero mismatches. Eligible API/probe display reads now use `operationalReadMode=guarded-sql`; production evidence is recorded below and in the run record. Existing movement/planning/payroll/Patrimonio/domain flags remain guarded.

## Exact source inventory

Private strongly consistent inspection on 2026-10-01 found 652 retained operational envelopes. Counts describe the observed snapshot, not acceptance targets. Every existing source entity is covered by the combined financial and operational classifiers. Already deleted/expired history is unavailable and is not claimed as recovered. Full source data stays outside public Git.

| PK / SK family | SQL table; observed envelopes | Writers / authoritative readers / retention |
| --- | --- | --- |
| `DEDUPE#… / CLAIM` | `dedupe_claims`; 541 | Observed-event transaction, ignored email, CSV/PDF/CFDI/manual capture. Source-only Get/conditional claims and legacy-claim cleanup. Includes 141 source claims, 115 Amex, 100 Santander statement, 132 CSV, 34 manual and 19 CFDI claims. No TTL. IDs and original claim fields can differ by writer; no invented parent or successful receipt. |
| `EXCEPTION_DEDUPE#hash / CLAIM` | `exception_claims`; 3 | Ingestion exception transaction, source/extractor/reason dedupe. Source-only conditional acceptance. No TTL. |
| `EXCEPTION#id / EXCEPTION` | `ingestion_exceptions`; 7 | Ingestion saves exceptions; API queues retry/discards; ingestion marks completed/failed. Retry request's source Get/conditional transaction stays DDB. Discard and completed are flags, not physical deletion. No TTL. |
| `RETRY#exceptionId / DISPATCH` (retained legacy), `DISPATCH#requestId` (current) | `ingestion_retries`; 3 | API retry transaction; existing stream dispatcher enqueues SQS and marks dispatched. Every dispatch and reconciliation decision stays source/native SQS. No TTL. |
| `USER#owner / IMPORT#SANTANDER#id`, `IMPORT#AMEX#id`, `IMPORT#SANTANDER_STATEMENT#id` | `import_records`; 15 | CSV preview/apply, PDF preview/poll/apply. Processing/failed/previewed/applied and full rows/results/Textract/S3 metadata retained. PDF GET can advance native Textract and persist extraction/preview; all those decisions stay DDB. CSV and PDF apply reread source/evidence/claims and reconcile source movements. No TTL. |
| `BULK_EDIT#owner / OP#operationId` | `bulk_edit_operations`; 43 | Assistant preview, conditional atomic apply/undo and tag/category batch apply. Pending preview has top-level TTL; apply/undo removes top-level TTL while retaining payload deadline, exact event snapshots and audit IDs. No independent persisted batch record. Source-only reads/transactions/49-event and 100-action limits remain. |
| `USER#owner / MONTHLY_CLOSE#month`, `MONTH_END_BALANCE_REMINDER#month` | `delivery_records`; 3 | Existing scheduled prepare/send/mark-sent. Prepared content/hash and sent metadata remain complete. Source-only idempotent preparation/retry/send decisions; no SES sends in verification. No TTL. |
| `USER#owner / PUSH#subscriptionId` | `push_subscriptions`; 1 | Authenticated save/delete; native delivery workers list active subscriptions and remove 404/410 endpoints. Those recipient/delivery/cleanup decisions stay DDB. Owner GET display alone uses guarded SQL. No TTL. No separate durable per-push delivery entity exists; stable native notification tags keep existing behavior. |
| `USER#owner / ASSISTANT_THREAD#sessionId`, `ASSISTANT_THREAD#ACTIVE` | `assistant_threads`; 36 | Chat saves minimum index/active pointer; thread list/detail discovers/backfills native sessions; activate/delete uses source. Thread indices use numeric top-level TTL 365 days after update; active pointer has no TTL. Native AgentCore owns transcript/context/memory and expiration. Only metadata display after native/source decisions uses SQL. |

S3 retains MIME/CSV/PDF/XML/extraction/wealth evidence. Cognito remains authentication. AgentCore native events, durable memories and session discovery remain native. SQS/DLQs/Streams/Scheduler retain existing dispatch and retry behavior. There is no provider gap requiring duplicate receipts, transcripts, notification history, retry queue, cleanup service or generic user infrastructure.

## Projection and expiration

Nine additive tables use original `(source_pk,source_sk,row_id)` keys, JSONB `payload` and **complete** `source_item`. `row_id` retains operation/exception/subscription identity, original thread suffix (including ACTIVE), or original SK for other operational records. Composite source identity remains authoritative; claims with no domain ID do not receive a fabricated financial ID. Each table promotes entity_type, owner when present/key-defined, status, created/updated instants and numeric top-level expires_at; table-specific promoted fields are in [schema reference](dsql-schema.md). All optional/unknown fields, original keys, native pointers, index metadata, before/after snapshots, results, email content and timestamps remain in source_item.

Transformation is deterministic. Expired envelopes still physically retained in DynamoDB remain raw parity evidence in SQL. Display readers filter numeric top-level expiration at a captured clock and never interpret nested bulk payload.expiresAt as physical TTL. Native TTL removal/delete produces the existing source reread/tombstone and removes SQL rows. Extension or removal before physical deletion preserves native behavior. No custom cleanup or restored missing history exists. Daily source/target reconciliation also removes missed deletes; native replay rereads current source and cannot reinsert a stale stream image.

Existing SQL checkpoint/OCC transaction and native recovery operate on every new key. A source transaction can arrive as separate SQL items; complete freshness comparison protects display results. No source resource, stream/TTL/index/protection, financial algorithm or authoritative writer changes.

## Display consumers and explicit decision split

| Consumer | Eligible SQL input / source-only boundary |
| --- | --- |
| `GET /exceptions` | Complete exception envelopes, then existing received-time descending order, 100 evaluated records before hiding discarded/completed, queued retry details. Shadow/guarded uses a paginated strong base-table scan; fallback preserves fresh source results. Equal received-time ties use source key byte order; no stable GSI tie order is promised. |
| Exception raw email GET | Guarded complete envelope to read its existing S3 pointer; retry/discard retains explicit direct source reads/mutations. |
| Terminal PDF GET | Source-only initial status/ownership decides workflow. Only previewed/applied rendering reads guarded envelopes. Concurrent re-upload falls back into an explicit source-only reread; at most one SQL selection. Processing/Textract/persist/apply never uses SQL to decide actions. |
| `GET /push/subscriptions` | Owner partition selected once with strong pagination; public subscription ID/content mode/timestamps preserve existing response. Active-recipient selection and cleanup workers still use original source readers. |
| Assistant thread list/detail | Source/native discovery, missing-index backfill, history reconstruction, page membership/order and active-selection decisions happen first. One selected owner index bundle supplies displayed titles/month/timestamps; absent/expired display records are excluded. Native transcript is read directly, never projected. Activate/prepare/delete never calls SQL display selection. |

No public read-only endpoint exists for dedupe claims, retry jobs, bulk history or prepared/sent email history. Those envelopes are projected and independently verified without adding unrequested UI/API surfaces. CSV has no read-only GET; preview/apply remain authoritative source workflows.

`DSQL_OPERATIONAL_READ_MODE` only configures API and read verifier. `dynamodb` bypasses SQL; `shadow` compares complete raw envelopes and returns source; `guarded-sql` returns SQL on equality, otherwise strong source. Source failure propagates. One SQL statement per selected partition/item with existing 1.5s connection / 3s query bounds. Inputs are shared across display loops. This still pays source read cost and does not claim lower latency or cross-engine atomicity.

Product `olbia_reader` has its prior thirteen SELECT grants plus exactly four display tables (17 total). `olbia_operational_verifier` has schema USAGE and SELECT only on the nine operational tables, associated only with deployed verification IAM role. Neither has SQL mutation/admin grants. No additional reader association for chat writer/proxy or delivery workers is needed.

## Independent verification and delivery

The approved workflow runs deployed full source/target reconciliation, then the independent read-only gate. It pages every operational table and strong source records; independently constructs expected promoted columns and compares full envelopes/payloads, IDs, ordering and histories. It does not use the projector as its expected-column oracle. Raw comparisons precede configured selection: fallback cannot conceal corruption. Logical expiration is queried at current time and every retained numeric TTL minus one/exact/plus one; missing lookups and configured partitions are checked. Public exceptions, terminal PDF previews, owner subscription fields and thread metadata/order/details are compared. Native session membership/transcripts are outside SQL scope; verifier never backfills or invokes a delivery/retry workflow.

Existing movement, planning/payroll/XML, Patrimonio/audit/149 retained evidence hashes and deterministic notification/report content gates run unchanged. No test SES/Web Push/Bedrock generation, sync, retry dispatch, capture or financial source mutation is invoked. Local real retained replay verifies content and SQL compatibility basics; deployed DSQL bootstrap/IAM/gates establish native compatibility. Local adversarial SQL tests exercise pagination/limit, stale create/edit/delete, envelope/promoted-column corruption, optional fields/milliseconds, rollback/outage/source failure, all-family concurrent update/delete, TTL renewal/removal and stale tombstone replay, partial rollback/lost commit replay and explicit source-only apply/retry.

Both production rollouts and final evidence are recorded in [autonomous run](autonomous-runs/2026-10-01-dsql-operational-state.md). Promotion and rollback change only operationalReadMode through PR → quality → CLEAN/MERGEABLE → squash/rebase → deploy-production. Never deploy locally, modify source directly, remove guards or retire DynamoDB.

## Verified production state — 2026-10-01

[Shadow #164](https://github.com/DavidCs9/personal-finance-system/pull/164) / [workflow 36915582121](https://github.com/DavidCs9/personal-finance-system/actions/runs/36915582121) and separate [guarded #165](https://github.com/DavidCs9/personal-finance-system/pull/165) / [workflow 36917474660](https://github.com/DavidCs9/personal-finance-system/actions/runs/36917474660) passed quality and deploy-production. Each reconciliation recorded 4,874 equal comparisons, zero lag/mismatches. Each independent gate verified 652 complete operational envelopes, 54 public responses, 59 configured item reads and 114 expiration checks with zero mismatches; all existing financial, original-evidence and deterministic notification-content gates also passed.

Live API/probe flags are guarded-sql. Native schema versions 1–4, transformer 4 and bootstrap 7 are deployed; product 17 SELECT grants and verifier nine SELECT grants are exact, with verifier mapped only to the probe. All ten protected resource definitions remain identical, mapping Enabled/OK and all eight alarms OK. Deployed exception/subscription component GETs selected SQL on equality and returned exactly their saved shadow responses. These component checks do not exercise the JWT authorizer or invoke native thread discovery/backfill. Local tests cover forced pagination, deletion, corruption, concurrent updates, TTL renewal/removal, outage and partial replay; production verification never fabricates source records or sends retries/notifications.

## Remaining DynamoDB dependencies and next-phase prerequisites

All application durable families are projected; projection parity is not write-authority parity. Remaining source dependencies are concrete:

| Dependency | Required before subsequent write-authority phase |
| --- | --- |
| All financial/operational freshness guards | SQL must first own affected writes with proven read-after-write/transaction invariants; only then remove source comparison. |
| Observed capture/reconciliation, claims and ignored/exception acceptance | One SQL authority must atomically claim original identities, preserve exact duplicate semantics, event/observation linkage and ignored/legacy paths; source retry and cross-source reconciliation must be equivalent. |
| Individual movement/MSI/category mutations and revision writers | Transactional preconditions and every original revision/observation ID, optional value and before/after history must survive concurrent edits and rollback. |
| Category classification/validation, card max-three/liability validation, plan saves, CFDI claims/imports and wealth/manual/sync writers | Preserve owner access, explicit-source validation, exact precedence, evidence pointers/hashes, same-day canonical/audit atomicity, last-good sync behavior and all financial calculations. |
| CSV/PDF preview/poll/apply and dedupe | Keep native evidence/Textract; prove preview-to-apply revalidation and exact claim+event+observation/revision transaction. GET polling remains a mutation workflow, not a read-only shortcut. |
| Exception request/discard/completion and retry stream dispatcher | Preserve conditional retry request+job transaction and native queue dispatch/recovery without duplicate acceptance. Native DynamoDB stream dispatch currently depends on source; replace only with a verified equivalent native capture/dispatch path. |
| Bulk preview/apply/undo/batch | Freeze exact IDs, source snapshots, deadlines and idempotent status; retain atomic multiple-operation limits, conflict cancellation, audit linkage and retained undo history. |
| Prepared/sent report/reminder state | Preserve prepare-once content/hash and conditional sent state; SES SendEmail has no idempotency key and existing post-accept/pre-mark duplicate edge remains. SQL must not invent stronger delivery guarantees. |
| Subscription writes and active-recipient/404-410 cleanup | Preserve authenticated owner/endpoint identity, active membership and native delivery behavior; no read-only guard may decide recipient/cleanup. |
| Thread prepare/backfill/active/delete decisions | Keep native memory/events. Verify index discovery/TTL/native-deletion sequencing and active clearing; do not mirror transcripts or mutate memory from projection. |
| Projector/maintenance/replay and operational scripts | Current-source rereads and strong source/target verification remain integral until cutover. Audit seed/backfill/repair tools before enabling SQL writes. |
| Recovery and rollback barrier | Design verified native SQL→DDB replication, duplicate/order/tombstone handling and loop prevention, then prove DDB contains every acknowledged SQL write before a write rollback. Read flags alone are insufficient. |

SQL write cutover, reverse replication, guard removal and DynamoDB retirement are explicitly outside this phase.

Native references: [TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html), [DSQL types/JSONB](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html), [IAM/SQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/authentication-authorization.html), [OCC](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-concurrency-control.html), [native Streams failure recovery](https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html). The existing documented native DDL-bootstrap gap remains; no duplicate platform telemetry/capture is added.
