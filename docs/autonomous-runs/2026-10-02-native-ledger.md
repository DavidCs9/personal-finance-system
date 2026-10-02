# Native core ledger and import provenance — 2026-10-02

## Objective and completion criteria

Continue David's authorized autonomous normalization after payroll passes deployed acceptance. Replace the core movement document authority with native movement identities, typed financial fields, relational observations/revisions/tags/MSI and direct transactional readers and writers. Establish accurate import provenance and claim semantics before enforcing relationships. Finish staged PRs, required quality, linear merges, deploy-production, financial/evidence gates and independent real-data acceptance before claiming the ledger slice complete.

## Constraints

- Olbia belongs to David alone and must feel born in SQL. No permanent command emulator, operational payload/envelope authority, duplicate canonical financial facts or inferred multi-user model.
- Preserve original observations, all revisions, rejected/deferred history, Mi parte zero/absence, currencies, foreign authorization reconciliation, MSI rounding/status/schedules and source suppression semantics.
- Preserve immutable original S3 evidence and historical import decisions. Raw financial records stay outside Git; private analysis is in `/tmp/olbia-native-ledger/`.
- Production release only through PR/quality/deploy-production. Immediately verify AWS identity before production reads. Do not repair claims or financial records through direct SQL writes.

## Progress and next steps

- Payroll native #182 is merged/deployed/accepted with zero financial/evidence mismatches and exact independent receipt/line parity. That prerequisite is complete.
- Inspected current movement readers, saveObservedEvent reconciliation, manual creation, category/UI mutations, bulk edit mutations and statement/CSV insertion/link flows. They still use document commands and embedded movement/MSI payloads despite SQL reads being authoritative.
- The initial audit identifies 499 movements, 522 observations, 405 original revisions (420 after audited category repair), 83 tags, 20 plans and 108 installments. Fresh consistent read-only snapshots confirm these counts. Native imports are now deployed and independently accepted after #184/#185, including all original evidence and rolled-back write smoke.
- Trace two explicitly dangling Amex claim targets and all overloaded MSI evidence identities against retained imports and original extraction evidence. Neither a repeated purchase signature nor a missing target justifies deleting a claim or fabricating a relationship.
- Map every financial writer and consumer, choose the coherent migration boundary, record design dilemmas before implementation and add native constraints only after the real historical cases are understood.

## Decisions

### D1 — Stage one guard for the complete ledger authority boundary

- Context: Moving movements while leaving older runtimes able to change their observations, revisions or suppression claims would create competing authorities. A blocked late movement write must not commit an earlier claim or operational side effect.
- Evidence and uncertainty: Every current movement, observation and revision routes through the existing SQL adapter. Tags and MSI are projected from movement writes. Email, Apple Pay, manual entry and bank imports use non-CFDI `DEDUPE#` claims; ignored email also creates targetless source claims. CFDI claims already belong to frozen payroll recovery. Individual edits use the shared application transaction; bulk edits and observed-event creation use adapter transactions; native import apply wraps the whole financial operation. Native imports #184 has merged and its independent copy/constraint/grant acceptance passed; final deployment verification is still running.
- Alternatives and tradeoffs: Guard only movement documents, allowing detached histories/claims to drift; dual-write both representations; pause all domains; or stage a marker guard across movements, observations, revisions and every non-CFDI source claim under the existing application barrier.
- Decision and reason: Deploy the complete adapter guard before core migration 14. Once marker 14 exists, reject Put/Update/Delete for all three event families and all non-CFDI dedupe claims. Tags/MSI freeze through their parent movement. Existing reads remain recovery reads; unrelated exception, bulk-preview, notification and native-domain operations remain available. The later native release must migrate every live ledger reader/writer; the guard alone does not normalize the ledger or activate marker 14.
- Consequences and verification: Test all mutation forms/families, complete historical reads, mixed/sequential transaction rollback with no receipt or operational residue, interrupted marker rollback, actual observed-event create/reconcile/retry paths and all three native bank apply paths. Live guard acceptance must prove exact unchanged core/import/payroll data and marker 14 absent. Native copy must update the same application barrier and marker atomically, preventing a concurrent older transaction from committing against its snapshot.
- Status: Decided before implementation. No marker-14 migration or native core copy has run.

### D2 — Preserve actual identity and evidence semantics in the core design

- Context: Applying generic UUID/account/source assumptions would discard real history or change the public financial contract.
- Evidence and uncertainty: The consistent baseline has valid UUIDs for all 499 movement IDs and 522 observation IDs, but 236 of 420 revision IDs are deterministic bulk-operation strings. Twenty-three linked observations omit account assertions. Eight movement capture-source arrays contain repeated entries; their order and multiplicity differ from a DISTINCT observation-source list. All current observation counts match their children, and every retained primary observation resolves to its own movement. Two Amex claim targets remain unexplained missing history.
- Alternatives and tradeoffs: Force all IDs to UUID, reconstruct observations from current accounts, deduplicate historical source arrays, or explicitly model the retained identity/ordered assertions while deriving only facts proven equivalent.
- Decision and reason: Keep revision IDs as domain text; preserve nullable observation account assertions and ordered capture-source assertions until their writer semantics are fully mapped. Do not infer account/card FKs from mutable descriptions or delete dangling claims. Current native DSQL supports deferrable foreign keys, so investigate a deferred same-movement primary-observation relation before inventing a nullable pointer/workaround. Schema details remain provisional until full writer/read coverage and real-data preflight validate them.
- Consequences and verification: Exact migration mapping must include optional absence, ordering, repeated assertions, primary observation and original claims. Test foreign authorization promotion, bulk revision identities, missing historical accounts and repeated source links. Validate direct SQL financial results and evidence independently.
- Status: Provisional, recorded before native schema implementation. [DSQL deferrable foreign keys](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html#Deferrability) verified in current official documentation.

### D3 — Derive capture summaries from ordered observation children

- Context: Repeated capture-source entries are observation history, while storing both a counter/source list and observation children creates redundant operational facts.
- Evidence and uncertainty: Independent real-data mapping proves that all 499 source arrays, including the eight repeated-source cases, exactly equal the full ordered observation source list. All 522 observations preserve this representation; no source multiplicity or primary-source mismatches exist. Incoming emails can be processed out of arrival order, so future append order cannot safely be inferred solely from observed timestamps.
- Alternatives and tradeoffs: Keep duplicated movement counters/arrays, use DISTINCT and lose repeated assertions, or give observations a native per-movement position and derive both response fields from that relation.
- Decision and reason: In the upcoming native schema, preserve observation insertion order with a unique per-movement position, derive `captureSources` and `observationCount` directly, and keep an explicit primary-observation relationship. Copy positions from the proven historical ordering; future append operations assign the next position transactionally. No extra capture-source table or stored movement counter is needed.
- Consequences and verification: Require exact retained source list/count/primary parity, immutable child order, out-of-order email/Apple Pay reconciliation tests and native uniqueness under concurrent ingestion. Native schema and consumers are not implemented yet.
- Status: Provisional; private exact-order mapping is `/tmp/olbia-native-ledger/observation-order-preflight-private.json`.

Further claim analysis: all 110 targetless CSV claims have exactly one retained observation matching the claimed row identity, source object, CSV row number/transaction ID, merchant and calendar day. They must not be labeled ignored email merely because the old writer omitted `eventId`. This is evidence for a possible explicit relationship backfill in the reviewed native migration, not authorization for a local financial repair. Three genuinely targetless email source claims and the two unexplained Amex targets still require distinct semantics. Private association evidence is `/tmp/olbia-native-ledger/csv-target-association-private.json`.

## Verification results

Guard preparation checkpoint: 11 native storage/observed-event integration tests passed. The actual bank-import suite now runs six cases, preserving its three completion-interruption checks and adding core-cutover rollback/clean-retry coverage for all three providers. The actual category/mutation/bulk service check proves category/rule, tags, Mi parte zero, MSI, reject/verify, revisions and operation state remain unchanged when core cutover blocks an old runtime. All 549 workspace tests passed (domain 28, web 55, API 287, ingestion 20, ledger 134, notify 9, infrastructure 16), all workspace typechecks and synthesis passed; all 11 protected resource definitions are unchanged. Marker 14 is not activated by this prerequisite. The core guard was retained locally while the import permission defect was repaired in #185; full import acceptance is still required before releasing this guard.

Release prerequisite satisfied: #185 workflow `37026917085` completed successfully with zero financial/evidence mismatches, native import smoke rolled back and final independent exact acceptance passed. Core guard branch is based directly on fetched `origin/main` at `b314569`. Twenty Python deployment/recovery tests also passed. Fresh SELECT-only guard preflight at `2026-10-02T15:34:56.759Z` captures 19 core/import/payroll/category/card/plan tables with marker 14 absent; private before/after acceptance will verify every row after deployment. Guard PR/quality/release acceptance are next; the native core schema/readers/writers are still unfinished.

Fresh consistent SQL snapshot completed; the core still contains 499 movements, 522 observations, 420 revisions, 83 tags, 20 plans and 108 installments. Traced both dangling Amex claim identities to retained parsed previews; no record proves the reason their target movements vanished. Native imports are the chosen first dependency because MSI evidence identities repeat across captures. The staged import guard and atomic apply boundary have seven integration cases; all 506 workspace tests, typechecks and CDK synthesis passed with 11 protected resources unchanged. The import guard release and native domain implementation remain next.

## Outcome and remaining work

Active. The bounded [native import slice](2026-10-02-native-imports.md) is complete. Release the prepared marker-14 guard, verify unchanged production state, then finish the coherent native core model and every financial reader/writer. The core ledger remains a substantial unfinished normalization domain; a prerequisite guard is not normalization completion.
