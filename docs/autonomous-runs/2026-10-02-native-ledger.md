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
- The initial audit identifies 499 movements, 522 observations, 405 original revisions (420 after audited category repair), 83 tags, 20 plans and 108 installments. A fresh consistent read-only SQL snapshot is being collected rather than relying on stale counts.
- Trace two explicitly dangling Amex claim targets and all overloaded MSI evidence identities against retained imports and original extraction evidence. Neither a repeated purchase signature nor a missing target justifies deleting a claim or fabricating a relationship.
- Map every financial writer and consumer, choose the coherent migration boundary, record design dilemmas before implementation and add native constraints only after the real historical cases are understood.

## Decisions

No schema or cleanup decision has been implemented. Current work is analysis of the core ledger and its provenance dependencies, not a claim that a renamed projection or additional columns normalize the domain.

## Verification results

Fresh consistent SQL snapshot completed; the core still contains 499 movements, 522 observations, 420 revisions, 83 tags, 20 plans and 108 installments. Traced both dangling Amex claim identities to retained parsed previews; no record proves the reason their target movements vanished. Native imports are the chosen first dependency because MSI evidence identities repeat across captures. The staged import guard and atomic apply boundary have seven integration cases; all 506 workspace tests, typechecks and CDK synthesis passed with 11 protected resources unchanged. The import guard release and native domain implementation remain next.

## Outcome and remaining work

Active. Continue the bounded [native import slice](2026-10-02-native-imports.md) before enforcing core provenance relationships. The core ledger remains a substantial unfinished normalization domain.
