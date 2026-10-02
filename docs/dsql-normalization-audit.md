# Post-cutover SQL normalization audit

Audit date: **2026-10-01, America/Chihuahua**. Code baseline: `1baea36` (verified SQL authority cutover). Live data snapshot: **21:28:49.960 local**, equivalent to `2026-10-02T03:28:49.960Z`. Counts describe this snapshot, not ongoing counters.

## Assessment

**Binding architecture north star — David's explicit decision, 2026-10-01:** Olbia should feel as if it was born in SQL. Domain entities and keys, typed relationships, native constraints, direct SQL queries and transactional domain operations are the target. DynamoDB key patterns, GSI strings, document-command emulation and authoritative projection envelopes are temporary compatibility mechanisms, not the final model. A slice is normalized only when its native relational representation becomes authoritative and its readers/writers use it. Renaming the adapter or merely adding columns does not satisfy this direction. Purposeful evidence/history JSON remains valid. This direction is also recorded in the [product north star](product-north-star.md).

The database migration is complete; the relational redesign is not. SQL is authoritative, but its primary write model is still a DynamoDB-shaped document store: `projection_state.source_item`. The application translates DynamoDB commands into SQL, then maintains domain tables as projections in the same transaction. Most domain readers select whole `payload` or `source_item` objects instead of joining typed columns.

This architecture preserved the old data faithfully. Recomputing all **2,660 domain rows** from **2,449 checkpoints/envelopes** found zero hash/checkpoint defects, zero column/payload differences and zero unexpected projected rows. Those checks establish internal consistency with the retained model; they do **not** establish that every historical financial classification or reconciliation is correct.

There are actual cleanup needs, alongside structural debt:

- **15 accepted movements reference seven category IDs absent from the catalog.** Their latest category revisions all came from assistant category edits. Mutation paths check the ID's format, not membership in the catalog.
- **Two Amex deduplication claims reference movements that do not exist.** Whether these are intentional suppression markers or dangling historical links needs investigation before repair.
- **26 MSI evidence references are not observation IDs.** They are 22 statement-row identities, two CSV fallback identities and two historical backfill markers. Twenty-four references resolve to retained import-row identities; two require separate legacy provenance. This is an overloaded field, not proof that the original evidence disappeared.
- **Five pairs of accepted movements share an exact comparison signature.** That signature includes institution, event type, currency, amount, merchant, timestamp and account last four. Their times have day-level precision, so repeated same-day purchases remain plausible. They are review candidates, not confirmed duplicate charges.

Normalization should make each live domain fact have one authoritative representation, move repeated operational collections into child tables, and enforce native keys and relationships. It should preserve original observations, immutable audit snapshots and flexible historical change data.

## Evidence and audit boundaries

The audit read the SQL catalog and every table/view in one transaction with SELECT statements, then rolled back. Profiling and projection recomputation ran locally against that consistent snapshot. AWS STS confirmed the existing login identity immediately before production reads. No production data, schema, infrastructure or application behavior changed.

The inventory covers **29 base tables and one view**: 24 domain tables and five storage/control tables. The live catalog has 29 primary-key constraints, **no foreign keys, CHECK constraints or standalone UNIQUE constraints**, and two secondary indexes. All 222 domain-specific columns permit NULL; only the three projection-key columns are required in those tables.

Read paths and writers were inspected in:

- [`services/ledger/src/dsql/model.ts`](../services/ledger/src/dsql/model.ts), [`schema.ts`](../services/ledger/src/dsql/schema.ts), [`store.ts`](../services/ledger/src/dsql/store.ts), and [`verification.ts`](../services/ledger/src/dsql/verification.ts).
- Domain contracts in [`packages/domain/src`](../packages/domain/src), especially movement, category, MSI, payroll and wealth types.
- API SQL readers, category mutations, bulk edits, import/reconciliation flows, monthly plans, card profiles and assistant thread state.
- [`infrastructure/lambda/retry-dispatcher.ts`](../infrastructure/lambda/retry-dispatcher.ts) for SQL retry and expiration behavior.

The private local evidence directory is `/tmp/olbia-normalization-audit/`: `snapshot-private.json`, `profile-private.json`, `issues-private.json`, `parity-private.json` and analysis scripts. Directory permissions are 0700; files are 0600. These temporary files contain real data and are outside Git. They are not a durable recovery backup.

Original S3 binaries were **not downloaded and rehashed during this audit**. Existing migration evidence verification remains separate evidence. This report does not claim fresh MIME/PDF/CSV/XML verification, bank-statement reconciliation, or a complete audit of all historical revision transitions. A zero projection mismatch means the SQL representation faithfully contains the retained model.

## Why the current model is still denormalized

Every domain table uses `(source_pk, source_sk, row_id)` as its primary key. Actual domain identities such as movement `id`, payroll `uuid` and `(account_id, day)` are nullable and lack database uniqueness. This retains DynamoDB routing syntax as relational identity.

Domain values appear in several places: the authoritative envelope, a domain `payload`, typed columns and sometimes an additional `source_item`. In many operational and snapshot tables, `payload` and `source_item` are exactly identical. Movement tags and MSI schedules exist both inside the movement and in child tables. Wealth holdings, payroll lines, monthly payments, import rows and bulk-edit members remain arrays in JSON.

The adapter's Query/Scan implementation reads envelopes and performs key-condition filtering, sorting and pagination in JavaScript. Legacy GSI strings are retained inside the documents. Removing duplicated JSON fields without replacing these consumers would break the application or make subsequent writes restore the duplicated data.

There are two indexes beyond primary keys: movements by `(spend_month, id)` and installments by `(month, movement_id)`. Relational query paths need indexes based on actual relationships and time filters; a complete general-purpose index catalog is unnecessary for David's data volume.

## Table-by-table audit

Proposed keys below are **recommendations**, not deployed changes. David remains the sole owner; no users, tenants or organization framework is proposed. Access checks remain tied to his authorized identity even if repeated owner columns are reduced.

### Financial movements and classification

| Table | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `movements` | 499 | Make `id` the primary key and typed movement columns authoritative. Require institution/type/status, integer bank amount, currency, merchant and receipt/ingestion times. Keep category nullable with a catalog FK and Mi parte nullable with bounds. Move account identity, capture summaries and MSI ownership out of the whole-document write model. Preserve unmodified bank observations independently. **15 invalid catalog references; five accepted signature pairs need evidence review.** |
| `movement_observations` | 522 | Make observation `id` the primary key and `movement_id` an FK. Promote observed/reconciled timestamps, source kind, institution/type, observed amount/currency, account reference, merchant, parser version, bank transaction identity and evidence reference. Raw parsing warnings and source-specific metadata can remain JSON. An observation is a historical assertion, so differences from the current movement are legitimate. All observations have a parent and consistent payload parent IDs. |
| `movement_revisions` | 405 | Make revision `id` the primary key; require movement FK, creation time, actor and reason. Promote operation ID/source where present. Keep `changes` as immutable JSON before/after data; do not replace historical values with joins to today's values. All parents exist; all 221 revisions carrying operation IDs resolve to retained bulk operations. |
| `categories` | 13 | Make `id` the primary key; require name and sort order. The effective catalog has 12 persisted envelopes plus one code-default-only entry. Seed missing defaults once into SQL and make SQL the effective catalog, rather than applying a permanent overlay on every read. Repair unknown live references before enforcing category FKs. |
| `merchant_category_rules` | 174 | Keep stable rule `id`; enforce unique `merchant_key` and a nullable category FK with explicit semantics for a rule that assigns no category. Promote pattern, source and update time from JSON. All current category references resolve and merchant keys are unique. Application code currently permits an empty category string; model that absence consistently before constraining future writes. A separate merchant catalog is unnecessary unless aliases or other shared merchant facts need it. |
| `cards` | 3 | Make card `id` the primary key. Promote issuer and creation/update times; require name and days 1–31. Remove repeated payload/envelope copies once readers use columns. All cycle days pass. Preserve this as a card profile; it is not a movement, outstanding balance or monthly expense. |
| `movement_tags` | 83 | This is already the right relationship shape. Use `(movement_id, tag)` as the primary key and a movement FK. Remove `payload={tag}` and the duplicated authoritative tag array. Current pairs are unique and all parents exist. Normalize tag syntax and limits on writes. A tag catalog is optional, not required to normalize this junction. |

Movement statuses are 402 accepted, 89 rejected and eight deferred MSI. There are 498 MXN movements and one USD movement; those currencies must remain separate. Seven movements have Mi parte, all within bank-amount bounds and none attached to an MSI plan.

All 499 movements have observations. Stored observation counts match actual counts, and all primary-observation references exist and belong to the correct movement. These capture summaries can be derived from observations, or deliberately retained as measured caches with one documented source of truth. A primary observation selected by reconciliation is an explicit relationship, not necessarily the first observation chronologically.

All movements have an observed account object, but **none has an explicit canonical card ID**. Establish a small account mapping from verified account facts where useful. Do not infer a card relationship from merchant, institution or a non-unique last-four label. Nullable unresolved mappings are preferable to false relationships.

Category cleanup must fix the writer as well as the records. Both individual category changes and assistant/bulk category changes can accept a well-formed nonexistent ID. Determine whether each legacy ID should become a catalog entry or be remapped to an existing category; preserve the previous value in a new revision. Do not change immutable prior revisions or silently map every unknown ID to `otros`.

### Installment plans

| Table | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `msi_plans` | 20 | Under the current one-plan-per-movement contract, use `movement_id` as primary key and FK. Require months, principal, cuota, origin and plan status. Remove embedded installments and the duplicate MSI object on the authoritative movement. Retain completion/partial-schedule semantics explicitly rather than interpreting NULL arbitrarily. There are 11 completed and nine active plans; all have parents and the declared number of installments. |
| `msi_installments` | 108 | Use `(movement_id, installment_index)` as primary key with a plan FK. Require valid index/month, integer amount and installment status; promote confirmation time and typed provenance. There are 47 committed, 33 spent and 28 cancelled installments. All parent links and keys pass. **The evidence field cannot be treated as an observation FK in its current form.** |

The MSI provenance repair should distinguish `import_row_id`, actual `observation_id` where applicable, and a retained legacy/backfill reference. Twenty-four current references can be linked to import rows; the remaining two should retain their backfill marker until stronger evidence is found. Never fabricate observations merely to satisfy a constraint.

Six evidence identities are present on two retained schedules. Each pair has one accepted movement and one rejected movement; no identity is shared between two non-rejected plans. This is retained rejection history, not evidence of current double-counting. A global UNIQUE constraint on every historical MSI evidence reference would incorrectly reject that history.

Rejected plans must remain persisted but excluded from product calculations. Completed/cancelled installments must remain available for audit. Do not equate total scheduled amounts with a financial defect solely from rounding, cancellation or partial-schedule semantics; the migration must preserve the existing principal/cuota contract and reconcile discrepancies to evidence.

### Planning and payroll

| Table | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `monthly_plans` | 6 | Use the calendar month as the personal-domain key; represent it as a validated month value. Promote currency and update time. Normalize **eight configured payments** into `monthly_plan_payments(month, payment_id, name, amount_minor, due_day)`, with unique IDs per month and positive amounts/days 1–31. All current payment IDs are unique within their month. Every payload retains legacy `incomeMinor`; the current monthly API derives income from payroll. Retire that field after checking remaining consumers. |
| `payroll` | 19 | Make CFDI `uuid` unique/primary independently of the month. Require payment date, payroll type, integer source totals and evidence linkage; month is derived from payment date under the existing contract. Normalize **192 payroll lines** into ordered child rows, preserving SAT kind/type/key/concept/group and `notCashInBank`. Promote employer and pay-period dates. All UUIDs are unique; line totals and the net formula match every current payslip. |

Four plan records explicitly contain no payments. **Those parent rows carry meaning and cannot be dropped:** an explicit empty month stops inheritance. A missing month inherits the last earlier configured month's complete payment list; reads do not materialize it. Child-table normalization must preserve the distinction between no parent and an empty parent.

Payment names and amounts belong to the month's configured version. A single mutable global recurring-payment record would change old months retroactively. Normalize the collection per month first; add recurring templates only if David needs that separate behavior.

Payroll source totals are immutable financial evidence even when line sums reproduce them. Keep them and validate the relationship rather than erasing the source assertions. Estimated/provisional monthly liquidity and Fondo remain derived from payroll; do not persist them as competing income balances.

### Assets and card liabilities

| Table | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `wealth_snapshots` | 120 | Enforce one canonical snapshot per `(account_id, day)`, with a small verified account catalog. Give captures a stable identity for their child rows. Normalize **425 current holdings** into snapshot children; keep instrument labels and values as historical capture facts. Remove envelope/payload copies, promote evidence linkage and preserve capture time/source. Snapshot totals equal holdings sums for all rows; holding IDs are unique within each snapshot. |
| `wealth_versions` | 4 | Retain prior same-day captures as immutable audit history. Use a unique version/capture identity with account/day linkage and required supersession time. Normalize **five historical holdings** without joining their past values to current holdings. All version account/day pairs have a current canonical snapshot and all totals agree. Do not discard versions as duplicated snapshots. |
| `liability_snapshots` | 22 | Enforce `(card_id, day)` uniqueness and a card FK; require source/capture time/currency and nonnegative total. Promote evidence linkage and remove repeated envelope/payload copies. Every parent card exists and every total is nonnegative. **Zero is a valid paid-off balance.** |
| `liability_versions` | 3 | Retain immutable prior same-day debt captures; require unique version/capture identity, card linkage, day and supersession time. All card and canonical-day links exist, with nonnegative totals. Keep historical values independent of the latest canonical balance. |

The current asset captures comprise 57 Bitso, 57 IBKR and six Cajita snapshots. No derived Fondo account is improperly persisted as a wealth snapshot. Account definitions currently live in code; a small account table is justified to anchor real relational references, without a generic provider/tenant configuration system.

The first implementation can retain separate canonical and audit tables while normalizing their children. An alternative is immutable capture tables plus explicit canonical-per-day pointers, which avoids copying a capture into a second table when superseded. Evaluate that option when designing the wealth slice; do not combine assets and liabilities or change their accounting semantics merely to reduce table count.

Retain integer minor units for money. Asset quantities and FX rates need a deliberate decimal/precision policy, verified against real provider values. Current FX is `double precision`, preserving the existing JavaScript number contract; blindly changing it to DSQL's default numeric precision could lose digits. Holdings remain nested objects in API responses even if their storage becomes relational. Update storage-specific documentation when that change is implemented.

### Capture, exceptions and imports

| Table | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `dedupe_claims` | 546 | Replace source-string identity with `(claim_kind, fingerprint)` or an equivalent unique domain key. Current `id` is literally `CLAIM` on every row and cannot be a domain primary key. Model optional targets by claim type: movement/observation, payroll UUID, or a suppression-only marker. Remove identical payload/envelope copies and unused generic columns. **Two event targets are missing.** |
| `exception_claims` | 4 | Use a unique claim fingerprint with source dedupe key, extractor version and claim time. All `id` values are again `CLAIM`. The current writer records no exception ID or reason, although the reason contributes to the fingerprint. Add explicit linkage for new claims where meaningful; do not invent historical exception targets. Remove unrelated owner/status/expiry columns unless required by actual behavior. |
| `ingestion_exceptions` | 8 | Make exception `id` primary; promote reason, details, receipt time, institution, evidence reference and discard state. Derive operational retry display from retry records or define one authoritative retry state; do not maintain competing copies without a purpose. Remove GSI index strings. Retain diagnostics/extractor metadata as JSON when source-specific. |
| `ingestion_retries` | 3 | Give retry requests real IDs with exception linkage, created/dispatched times and dispatch status. All retained jobs reference existing exceptions and are dispatched. Normalize the job's operational references; retain source-specific request metadata as needed. Current `id` values derive from `DISPATCH`/`DISPATCH#…` and are not globally unique identities. Keep SQS as the delivery mechanism and preserve at-least-once dispatch plus claim-based idempotence. |
| `import_records` | 15 | Use `(import_kind, content_hash)` as a unique import identity, or stable import ID plus that uniqueness rule. Promote lifecycle/status, account mapping where verified, timestamps, source evidence and extractor job ID. Normalize **484 parsed rows** into ordered `import_rows` with row identity, amount/date/merchant/type/MSI fields and resulting movement links. Candidate sets can use a child relationship when queried; raw extractor output remains immutable metadata/evidence. Thirteen imports are applied and two previewed. |

Deduplication absence is often intentional. Of the 132 claims without movement IDs, 110 are Santander CSV markers, 19 are payroll claims and three are source suppression markers. All 19 payroll claims resolve to retained payslips. Only two claims with explicitly populated movement IDs point to absent movements; investigate their original operation before choosing a repair. Deleting them casually could allow old records to be ingested again.

Import candidate lists and previews describe a past reconciliation decision. They should not be rewritten whenever a movement's merchant, category or status changes. Separate immutable parsed rows/decision evidence from current result pointers. Link MSI evidence to those real parsed rows so the SQL model can express provenance accurately.

An evidence-object table is useful where records share real S3 objects: unique bucket/key, content hash and content type, with domain links. It should identify retained evidence, not replace S3 or turn raw source bodies into relational columns. Confirm conflicting hash claims and original object existence during the implementation's evidence gate.

### Mutations, notifications and assistant state

| Table | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `bulk_edit_operations` | 43 | Make operation `id` primary; require lifecycle times/status. Normalize **221 frozen members** into `bulk_edit_members(operation_id, movement_id, before, after)` with uniqueness per operation and real parent links. Preserve before/after audit values and frozen selection/change JSON. All members have movements; related revisions resolve. All operations are applied; their 43 nested preview deadlines are expired audit data, **not expired rows to delete**. |
| `delivery_records` | 3 | Use `(delivery_kind, month)` as the personal idempotency key; promote prepared/sent state, times, hash and provider message ID. Keep prepared factual report/analysis snapshots as immutable JSON because they prove what was sent. Split a send-attempt child only if actual retry/history needs it. There are two monthly close reports and one precierre reminder. Payload and envelope are identical on every row. |
| `push_subscriptions` | 1 | Make subscription ID primary and endpoint unique; require active flag, content mode and timestamps. Promote endpoint/key fields with existing access protections, removing repeated documents and GSI strings. Native Web Push endpoint material is an opaque integration value; no separate table for every key component is needed. |
| `assistant_threads` | 36 | Split **35 thread index records** from **one active-thread pointer**. Thread primary identity is session ID; require title/first month/creation/update/expiry. Store the singleton active session as a nullable FK or equivalent constrained pointer. The current pointer references an existing thread. Repeated session IDs across pointer/index rows are a mixed-entity artifact, not duplicate conversations. Keep transcript and memory content in native AgentCore. |

Bulk selection predicates, historical before/after snapshots and sent report facts are purposeful JSON. Normalization means removing redundant operational copies and exposing stable relationships, not reconstructing yesterday's audit record by joining today's movement values.

None of the inspected top-level expiration fields is currently expired. The scheduled SQL dispatcher deletes expired top-level records in supported families; it correctly leaves nested bulk-preview deadlines intact. Thread expiry/deletion must also clear or null the active pointer before/with enforcing a foreign key.

### Storage and control tables

| Table/view | Rows | Audit and recommended direction |
| --- | ---: | --- |
| `projection_state` | 2,449 | **Currently authoritative.** Contains 2,448 live envelopes and one tombstone, plus generation/hash/transformer and old stream metadata. All envelope keys/hashes/version/deletion states pass, and their projections match. Retain while any writer or consumer requires document commands. Eventually archive original migration envelopes as needed and retire this compatibility store after native relational writes become authoritative. Do not rename it and leave the document model unchanged as the final design. |
| `schema_migrations` | 5 | Keep a versioned SQL migration record. Current versions are 1–5. Bootstrap executes an idempotent set of statements, then inserts version markers; future normalization needs explicit ordered changes and validation evidence. No new migration framework is required unless existing deployment tooling has a concrete gap. |
| `runtime_state` | 1 | Current storage authority is `sql`. Keep as operational control while the transition requires it, with valid mode enforcement. Remove obsolete authority branches only after all callers and recovery workflows have been updated. This is not a financial entity. |
| `application_barrier` | 1 | Existing generation row intentionally serializes this single owner's writes/authority changes via native transaction conflict detection. Keep during conversion. Reassess after SQL constraints and transaction boundaries replace legacy assumptions; do not remove the serialization dependency without concurrency verification. |
| `command_receipts` | 0 | Correct relational shape: token primary key, request hash and expiry. Preserve the ten-minute transaction idempotence contract until callers migrate. No records are present. No receipt cleanup appears in the current scheduled expiration path; add bounded cleanup if token usage produces retained expired rows. Do not move receipts into domain JSON. |
| `movement_months` — view | 587 | Already a useful derived relation: movement spend month UNION installment months. It stores no duplicate physical data. Keep or adjust to the normalized keys/month types and preserve multi-month inclusion. It covers rejected history too; product queries still need their status rules. Never treat its row count as a movement count or sum it as spending. |

## Native capabilities to use

Aurora DSQL now documents native primary/unique keys, NOT NULL and CHECK constraints, foreign keys, supported referential actions and deferrable foreign keys. Use those for domain integrity instead of implementing a second application-only foreign-key system. Transaction conflict retries remain necessary. Foreign-key validation incurs additional reads, so verify real mutation behavior and query plans at David's scale. [AWS constraint syntax](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html), [foreign-key behavior](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-foreign-key-constraints.html).

Existing tables have important ALTER restrictions: DSQL does not support dropping primary-key columns through ALTER, or the ordinary PostgreSQL `ALTER COLUMN SET NOT NULL` form. New normalized tables are a practical way to obtain clean primary keys and required fields. For supported additions to existing tables, CHECK/FK constraints must initially be `NOT VALID`, followed by asynchronous validation; UNIQUE can attach to an already-valid unique index. Track native job completion before claiming integrity is enforced over historical rows. [AWS ALTER TABLE support](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html).

Prefer restrictive deletion on financial/audit relationships. Cascading deletes should not erase rejected movements, observations, revisions or prior captures merely because a current profile changes. For operational pointers, nulling/clearing a pointer may be appropriate. Choose per relationship; do not make every FK cascade.

Do not create lookup tables merely to replace small fixed enums with joins. Institution, capture-kind and status constraints can remain checks when there is no independently maintained entity behind the value. Use native S3, SQS, AgentCore, Cognito and backups for their current responsibilities.

## Proposed order of work

1. **Close known integrity gaps.** Validate category membership in all write paths, determine auditable repairs for the 15 live references, investigate two orphan claim targets, and formalize MSI evidence kinds. Review suspected movement duplicates against original files; do not merge based only on amount/day/merchant. Preserve revisions and suppression semantics.
2. **Normalize the core ledger.** Categories/rules and verified account/card identities first, then movements, observations, revisions and tags. Establish direct SQL repositories and transaction boundaries; migrate every mutation path, including ingestion, imports, manual capture, reconciliation and assistant edits. The goal is one live domain authority, not another permanent dual-write layer.
3. **Normalize MSI and imports together.** Create stable import-row identities and typed evidence links, then canonical plan/installment writers. Preserve rejected historical schedules and the existing spend/commitment calculations.
4. **Normalize planning and payroll.** Move payments and payroll lines into children. Preserve empty-parent inheritance semantics, CFDI UUID idempotence, source totals and derived income/Fondo rules.
5. **Normalize wealth and liabilities.** Give captures/holdings real identities, enforce account/day and card/day rules, preserve prior same-day versions and evidence. Validate precision and as-of month-end calculations before switching reads.
6. **Simplify operational tables.** Typed claims/retries, bulk members, deliveries, subscriptions and thread/active-pointer separation. Keep immutable decision/notification facts where JSON is useful.
7. **Retire compatibility after dependencies are gone.** Remove document-command emulation, legacy GSI strings, projection-key primary identities, repeated envelopes and unused stream metadata. Preserve agreed recovery evidence. Frozen DynamoDB remains a retained pre-cutover recovery source; normalization does not authorize deleting it.

Each implementation slice needs a reviewed PR, required quality check and the existing production deployment job. A temporary comparison/backfill is reasonable; promoting a table requires its direct writers and consumers to be ready. Do not leave one path writing JSON while another writes only relational columns.

## Acceptance criteria for implementation

- Clean natural/domain keys, required values and validated native relationships; intentional nullable or legacy cases documented.
- Exact retained observation, revision, payroll and snapshot evidence, with no discarded rejected/history records.
- Equal product financial results by currency and financial month, including Mi parte zero/absence, spent versus committed MSI, rejected/deferred exclusions and foreign authorization behavior.
- Equal monthly-plan inheritance, explicit empty-month behavior, payroll estimates/Fondo derivation and as-of patrimonio results.
- Full write-path coverage, meaningful transaction/idempotency/concurrency checks, and no competing JSON/relational authorities.
- Native backup/recovery preserved, migration restartability verified, and original evidence independently checked where new links depend on it.
- Query plans and a small set of indexes validated for the actual access patterns; no speculative multitenant or generic financial framework.

The audit's recommendation is to start with **category integrity and the core ledger**, while defining import-row provenance before adding MSI evidence constraints. The observed model has substantial redundancy and weak database enforcement, but the live comparison gives a trustworthy baseline for a controlled redesign.

Run record: [normalization audit](autonomous-runs/2026-10-01-normalization-audit.md).

## Implementation progress after the audit

**Current core-ledger status:** guard #186 and bulk-operation extension [#187](https://github.com/DavidCs9/personal-finance-system/pull/187) are merged/deployed and independently accepted with all 19 checked production tables unchanged. The native twelve-table schema, atomic copy and direct relational readers are prepared locally and reproduce all 499 movement records/522 observations/420 revisions against the real baseline. Typed transactional capture/edit/MSI primitives and actual email, Apple Pay and manual consumers are now implemented locally; all 595 workspace tests and workspace typechecks passed, with the subsequently retired SDK capture implementation retained only as a test fixture and its affected checks passing. The proposed copy establishes 110 uniquely evidenced CSV claim relationships while preserving unresolved historical targets and MSI ambiguity. API edits, bulk operations, bank financial apply, remaining readers and deployed financial/evidence gates still need migration. Production migration 14 is inactive; this is an unfinished domain, not a completed normalization slice. See [the active ledger run](autonomous-runs/2026-10-02-native-ledger.md).

The inventory and findings above describe the captured snapshot. The first normalization slice is tracked in [the category integrity run](autonomous-runs/2026-10-01-category-integrity.md) and [native category design](sql-native-categories.md). #174 deployed the authoritative `spend_categories` catalog and membership guards; #175 fixed the standalone mutation SQL identity. Both passed required quality and production acceptance. All 15 unknown category assignments were then restored through ten audited domain undo operations: zero invalid current assignments, unchanged financial fields/tags and all original revisions preserved. Native merchant rules and both validated assignment FKs deployed in #176. Its production reconciliation, independent financial/evidence gates and rolled-back native write smoke passed with zero mismatches; independent SQL acceptance confirms all 174 migrated rules preserved and zero unknown current references. Frozen category/rule projections are recovery evidence, never the final design.

- Card profile slice: guard PR #177 is merged and deployed; private preflight confirms three valid profiles and 25 resolving liability parents. Native `card_profiles` CRUD/readers, retained inactive identity and required-parent CHECK/FKs deployed in #178. Production reconciliation, financial/report/worker/evidence gates and rolled-back native smoke passed with zero mismatches. Independent post-smoke SQL acceptance proves all profiles copied exactly, all 25 liability records unchanged, all four native constraints validated and zero invalid parents. See [native card profile design](sql-native-card-profiles.md) and [run record](autonomous-runs/2026-10-01-native-card-profiles.md).


- **Monthly plans and ordered payments complete:** staged guard [#179](https://github.com/DavidCs9/personal-finance-system/pull/179) and native [#180](https://github.com/DavidCs9/personal-finance-system/pull/180) are merged/deployed/accepted. `month_plans` and `planned_payments` are the sole operational authority with native month/payment keys, typed fields, FK, unique order and money/day/cardinality constraints. Independent pre/post-smoke acceptance preserved all six parents, eight payments, four empty inheritance stops, exact order/values/timestamps and frozen documents. Migration 11 and four validated key/relation constraints are present; all financial/evidence gates passed with zero mismatches. See [native design](sql-native-month-plans.md) and [completed run](autonomous-runs/2026-10-01-native-month-plans.md).


- **Payroll complete:** native [#182](https://github.com/DavidCs9/personal-finance-system/pull/182) is merged/deployed/accepted. `payslips` and `payslip_lines` are the sole operational authority; ingestion uses native UUID uniqueness and atomic ordered children, with no live document claims or payroll read fallback. Independent post-smoke acceptance proves exact parity of all 19 receipts/192 lines, unchanged frozen receipts/claims, three validated key/relation constraints, 14 validated CHECKs, zero invalid parents, a ready payment-date index and immutable operational grants. Production financial/evidence gates passed with zero mismatches, all 19 XML hashes verified and native write smoke rolled back. See [completed run](autonomous-runs/2026-10-02-native-payroll.md).
- **Core ledger/provenance next:** fresh read-only snapshot retains 499 movements, 522 observations, 420 revisions and 15 imports/484 parsed rows. Five MSI evidence identities appear in two import captures, so row identity cannot be globally unique across files. The two Amex claims still suppress original rows whose target movements have disappeared; retained original and duplicate previews establish historical ingestion, not the reason for disappearance. No deletion or invented relationship is justified. Normalize native import captures/ordered rows first, then formalize core relationships and direct financial writers. See [ledger analysis](autonomous-runs/2026-10-02-native-ledger.md) and [import slice](autonomous-runs/2026-10-02-native-imports.md).

- **Native imports complete:** guard [#183](https://github.com/DavidCs9/personal-finance-system/pull/183), native [#184](https://github.com/DavidCs9/personal-finance-system/pull/184) and verifier evidence-access repair [#185](https://github.com/DavidCs9/personal-finance-system/pull/185) are merged/deployed/accepted. `bank_imports`, `bank_import_rows` and `bank_import_candidates` are the sole operational authority for every provider lifecycle; direct transactions preserve applied decisions and prevent partial financial apply. Independent post-smoke acceptance proves exact 15 captures/484 signed rows/39 candidate IDs/38 labels, 44 validated constraints, zero invalid parents and unchanged core/claims/payroll/frozen imports. All 15 original hashes and 12 extraction objects passed; production financial/evidence gates reported zero mismatches and native write smoke rolled back. Historical selections/labels stay evidence, repeated files retain per-capture identity, and unexplained claim targets are preserved. See [completed run](autonomous-runs/2026-10-02-native-imports.md).


**Additional core rollout prerequisite:** old financial readers also need a marker-14 guard before native activation. The existing writer guard alone cannot prevent a still-running old bundle from treating frozen movement envelopes as current finances after a new writer commits. A narrow staged guard checks SQL feeds/details and all source/all-event readers, returning the existing migration-retry response after activation. It changes no financial records or authority. See [reader guard run](autonomous-runs/2026-10-02-native-ledger-read-guard.md); the coherent native ledger release remains unfinished.
