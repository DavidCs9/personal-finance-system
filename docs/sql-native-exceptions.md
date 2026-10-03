# Native ingestion review and retries

**Olbia must feel born in SQL. David Castro is its sole user and owner.** The complete native implementation follows deployed and independently accepted guard PR #198. Native release and independent production acceptance remain pending.

The verified originals contain eight exception headers, four suppression claims and three completed retry requests. Seven actual encrypted MIME objects reproduce all eight recorded SHA-256 values and all four claim mappings. Four older headers have no claim. All historical requests lack a UUID; their exception/request timestamp is verified, and every completion resolves to a native movement. These absences stay explicit.

## Relational authority

- `ingestion_review_exceptions`: UUID primary key and immutable received time, institution, reason, details and original bucket/key/hash/content type. Optional paired discard time/actor is the only product mutation. No payload/document keys or display indices.
- `ingestion_review_claims`: composite source token/extractor version/reason primary key, FK to the exception, creation time and optional original expiry. Claim hash is derived for historical verification, not a duplicate canonical key. Four original claims map to verified parents; absent claims remain absent.
- `ingestion_retry_attempts`: `(exception_id,requested_at)` primary key and FK, optional actual request UUID, requested actor, dispatch time and explicit completed/failed facts. Completed movement is an FK. Queued/completed/failed state follows those facts. Typed immutable job source assertions retain optional hash/content-type/message-ID fields without inventing historical metadata. Product latest retry is the most recent request of that exception; it is selected with a relational query.

New queue messages carry the exception/request-time attempt identity through the existing SQS and fallback workflow. Completion targets that exact attempt, protecting subsequent requests from delayed earlier deliveries. Identityless retained deliveries can target only an unambiguous sole attempt with matching original source/received time; ambiguity must fail closed. Financial source claims keep their existing native deduplication. Financial capture and its exact retry outcome commit together through the existing shared SQL transaction; exception/claim creation and failed outcome do likewise. Source/model/provider IO stays outside retrying SQL callbacks.

SQS dispatch remains send then conditional dispatch recording, with the existing native scheduled retry/DLQ behavior. SES review alerts remain best effort after persisted review evidence. External provider acceptance cannot share a SQL transaction; neither boundary claims exactly-once delivery.

## Migration and acceptance requirements

Original-byte mapping runs once before the activation transaction using narrowly scoped S3 read/decrypt access. The transaction takes the shared barrier, rechecks every original row against the pre-read snapshot, rejects unknown shapes/partial targets/unresolved claims/attempt relationships and atomically copies/activates marker 19. External source IO is not replayed inside the connector transaction callback. All original records remain frozen for recovery.

Readers and writers use direct SQL only. API retains its exact fields, sorting, first-100-before-filter behavior, raw source access and retry/discard responses. Actual SQL operations, provider failures, attempt races, grants and rollback are tested. Independent verification checks exact original facts, MIME bytes, all current consumer boundaries and native constraints/privileges. Deployment runs through PR/quality/deploy-production; production verification creates no real retry, alert or movement.


The migration rejects historical task/header combinations that cannot prove the requested actor and outcome for each attempt; it does not reconstruct lost attempt history from a newer nested header. The actual three retained attempts each have their exact matching header facts. Unexpected concurrent legacy changes reject activation under the shared barrier and require a fresh audit. Same-timestamp requests reject a key collision without manufacturing another identity. A completed latest attempt cannot be requested again, including when earlier failure evidence remains.

Local acceptance uses David’s eight originals/four claims/three attempts and both actual writer roles, including existing movement completion with full rollback. The independent gate checks 25 constraints, 17 required columns, actual list/raw-metadata consumers and original MIME bytes. The isolated historical verifier retains recovery inventory; unused product envelope/fallback adapters and scheduled legacy TTL writes are removed. Recovery evidence remains intact.
