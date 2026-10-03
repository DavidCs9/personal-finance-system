# Native monthly email deliveries — 2026-10-03

## Objective and completion criteria

Continue David's indefinite normalization goal until he stops it. **Olbia must feel born in SQL; David is its sole owner.** Normalize monthly-close reports and month-end balance reminders end to end: typed keys and immutable prepared content/provider receipts, every reader/writer, exact copy/grants/gates/rollback smoke, required PR quality/linear merge/deploy-production and independent real acceptance. Preserve existing email wording, factual snapshots and scheduled delivery behavior. No real verification email is sent.

## Constraints and baseline

Root AGENTS, autonomous rules and product north star apply. Financial correctness and private evidence are binding; production releases run exclusively through approved PR/quality/deploy-production. Native push #193 passed final-head required quality `37105967158` at `8f78b1baa06c4c6b45ea09dfec24543c3978977b`, CLEAN/MERGEABLE and squash-merged to `b4f87935275eeaa93944a82012d1cb3e0c8c97df`. Production workflow `37106090688` and independent exact post-smoke acceptance passed; push is complete.

Authenticated SELECT-only baseline at `2026-10-03T07:16:54.065Z` has three delivery records: two monthly-close reports and one month-end reminder. All are sent; exact subject/NUL/html/NUL/text digests match stored SHA-256, provider receipts exist and preparation precedes acceptance. Full private data remains at `/Users/decs/.local/share/olbia-normalization/2026-10-03-native-push/native-pre-private.json` (700 directory/600 file). No financial contents, owner IDs or receipts are published in Git/logs.

## D1 — Next bounded operational domain

- Context: Financial ledger/wealth and push are native or releasing. Monthly delivery facts are still repeated in document envelopes despite SQL authority.
- Evidence/uncertainty: Only three actual sent records exist. Both handlers persist prepared content, call SES, then mark sent. Report facts and generated analysis prove the email that was sent; they are not current financial authority. Thread discovery and exception retry workflows have larger provider/state-machine boundaries.
- Alternatives: Normalize threads/exceptions first or complete this bounded two-handler domain. The latter has exact immutable real content and straightforward product-preserving validation.
- Decision: Choose monthly deliveries next. Retain prepared email/factual/analysis evidence exactly; promote domain kind/month and lifecycle facts to SQL. Do not regenerate historical content or introduce multiuser configuration. Decide the final immutable preparation/receipt model after completing rollout protection.
- Consequences/verification: Independent content rehash, exact facts and receipt preservation, actual handler prepared/sent/race/failure behavior with injected IO, native role isolation and fully rolled-back smoke. No real test send.
- Status: Provisional; next domain design and release pending.

## D2 — Protect old orchestration before activation

- Context: An older handler could read frozen prepared content and send again after native activation. Financial/mutation barriers alone do not cover external SES calls after long preparation/analysis.
- Evidence: Both handlers have one exported orchestration entry and one private SES send helper. The existing store transaction/barrier can freeze every delivery-family mutation. Generic recovery inventory reads must remain available to isolated verification.
- Alternatives: Impose deployment dependency ordering, or deploy a separate marker guard before conversion. Prior ledger work demonstrated dependency cycles; a staged guard is proven and proportional.
- Decision: Deploy marker-17 checks at both orchestration entry and immediately before delivery, including the SES helper. Reuse the existing SQL client and maintenance/error response. Freeze delivery-family writes in the existing store save transaction under its barrier. Do not create marker 17 in this prerequisite. Preserve before-marker behavior and read-only retained recovery inventory.
- Consequences/verification: Guard tests cover both handlers before/after activation, activation during preparation and sanitized driver failure with zero delivery IO. Actual store tests cover conditional operations, both delivery kinds and mixed/enclosing rollback/receipts/barrier. Independent unchanged-data acceptance precedes native activation.
- Status: Provisional; guard implementation pending.

## D3 — Provider delivery semantics stay explicit

- Context: Existing prepare/send/markSent orchestration prevents resend after a recorded success but can resend on racing prepared readers or after SES acceptance followed by a crash before markSent.
- Evidence: The [official SES SendEmail request](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html) has no client idempotency token. Existing Scheduler retries, native DLQs and alarms already provide retries/operational visibility. Actual records are all sent; no stuck prepared record establishes a new recovery policy.
- Alternatives: Introduce custom outbox/leases/queues and ambiguous-send reconciliation now, or preserve current provider orchestration while making immutable preparation/receipt facts relational. A custom framework would broaden this normalization slice and still cannot make SES and SQL one atomic commit.
- Decision: Preserve current delivery semantics and native SES/Scheduler/DLQ/alarms. Do not claim exactly-once delivery or invent a retry/history abstraction. Record the external-acceptance ambiguity as a known limitation to revisit when an actual need or explicit product decision justifies it. No custom platform implementation is needed for the schema conversion.
- Consequences/verification: Native integration tests cover existing prepared reuse, sent suppression and provider failure with injected transport. Migration and verification never send or re-render historical evidence. Final schema should remove duplicated lifecycle facts without altering the native provider responsibilities.
- Status: Provisional; final model and handler checks pending.

## Progress and next steps

Guard branch `codex/sql-delivery-cutover-guard` starts directly from fetched `origin/main` at push merge `b4f8793`. Prepare the staged guard while push deploys, finish push independent acceptance before releasing it, then complete the native domain on a fresh main branch. Do not declare a guard/schema foundation to be domain completion.

## D4 — Immutable preparation and provider receipt, with derived lifecycle

- Context: Current documents duplicate prepared/sent state alongside receipt/time and embed both kinds in one envelope. Report facts/analysis and the rendered email are immutable historical evidence.
- Alternatives: Keep one mutable status/header row; create separate subtype tables for each kind; or use one constrained immutable preparation plus an append-only receipt child. The mutable row duplicates lifecycle facts; subtype tables add joins for two small fixed variants.
- Decision: Prepare two native relations. `monthly_email_preparations` uses the personal `(delivery_kind, month)` key, owner provenance, required preparation time/digest/subject/html/text and explicitly named report evidence/analysis fields or reminder as_of_day. Native kind-specific checks distinguish those variants. JSON is limited to immutable original report facts/analysis, not an operational document. `monthly_email_receipts` uses the same PK plus a real FK and required provider receipt/time. Prepared/sent status derives from receipt existence; receipt insertion cannot change prepared evidence. Scoped roles cannot update/delete either relation.
- Consequences/verification: Exact real content/hash/facts/analysis/receipts, native PK/FK/required variant checks, conditional first preparation and first success receipt, after-sent suppression and owner access protection. Existing external send ambiguity remains as D3; no retry-attempt/lease subsystem or extra provider infrastructure. Copy/activation is atomic and rolled-back smoke exercises actual prepare/receipt primitives without SES/Bedrock IO.
- Status: Provisional; native foundation follows separately deployed guard and push acceptance.

Guard checkpoint: all three actual store cases and four orchestration/guard cases pass, along with existing monthly close/reminder checks (16 API cases total) and all workspace typechecks. Both delivery kinds preserve ordinary pre-marker mutations. Marker 17 blocks all late mutation forms and both old handlers before reading or producing content; an in-flight preparation rechecks immediately before sending. Mixed/enclosing transactions roll back unrelated writes, receipts and the barrier. Native driver errors are sanitized with zero fallback/delivery IO. Full tests/synthesis are running; prerequisite push production acceptance and final guard PR/deployment remain required.

Guard local release preparation: all 686 workspace tests and workspace typechecks pass; synthesis succeeds with all 44 protected retained/identity resource definitions unchanged. Independent authenticated SELECT-only all-table guard pre/post acceptance is prepared. Native push production workflow/independent acceptance is now complete; guard release remains pending.

Native foundation checkpoint (local and unpublished): six integration cases and ledger typecheck pass for immutable preparation/receipt relations and atomic marker-17 copy. Copy retains exact kind/month/owner/content/facts/analysis/receipt/time and original envelopes; unknown/inconsistent mappings and partial native state reject activation. Interrupted copy rolls back every relation, marker and barrier and retries cleanly. Native roles deny all UPDATE/DELETE and readers cannot INSERT; actual parent and kind-specific checks reject orphan receipts/invalid variants. The private real-data rehearsal exactly reproduces all three preparations/receipts, independently rehashes rendered bytes, preserves immutable report facts/analysis and proves actual-role preparation/receipt insertion rolls back with originals/native rows unchanged. Consumers/gates/bootstrap/grants/deployed smoke and native release remain outstanding. Foundation files are isolated from the guard PR and will move to a fresh main branch only after guard release.

Guard pre-release baseline: fresh authenticated SELECT-only capture at `2026-10-03T07:36:00.205Z` preserves all 55 non-control tables / 6,840 rows including the accepted native push registry and all three exact delivery records. Marker 16 is active and marker 17 absent. The private baseline and independent unchanged-data comparison script are prepared under `/Users/decs/.local/share/olbia-normalization/2026-10-03-native-deliveries/`. Final fetch/rebase, required guard quality/CLEAN/MERGEABLE, linear merge/deploy-production and post-smoke exact acceptance remain required.
