# DSQL remaining domain reads — 2026-10-01

## Objective and completion criteria

Complete category/rule, standalone card/cycle and read-only worker movement consumers. Deploy shadow through PR/quality/linear merge/deploy-production, verify real data independently of fallback, then promote through a separate guarded PR and repeat verification. Record final evidence and remaining DynamoDB dependencies.

## Constraints

DynamoDB retains every write and authoritative validation/acceptance/dedupe/reconciliation/mutation decision, plus strongly consistent freshness reads. Preserve default categories, rule precedence, complete card metadata, Chihuahua boundaries, financial algorithms and notification behavior. No manufactured financial records, test notifications, local deployments, source replacements, operational-state migration or SQL write cutover. Use default IAM credentials and verify expected STS identity immediately before production operations. Original checkout's three AWS-auth guidance edits are untouched; this worktree starts at refreshed origin/main 9978187.

## Progress and next steps

Read repository/autonomous/product/UI and migration guidance. Created isolated managed worktree and shadow branch. Inspect all consumers and real inventory; implement proportional guarded readers and independent verification, test and complete phased production delivery.

## Decisions

Pending consumer inspection. Current user AWS-auth instructions override older committed login guidance; do not alter the unrelated original edits.

## Verification results

Initial main state matches completed Patrimonio PRs #158–#160. Original checkout has exactly AGENTS.md, docs/dsql-migration-plan.md and docs/dsql-migration-runbook.md modified.

## Outcome and remaining work

In progress; no new production rollout claimed.

### D1 — Reuse projected catalogs/rules/cards and preserve source-only decisions
- Context: These entities already project into SQL; moving authoritative reads would expand migration scope and let lag affect acceptance or classification.
- Evidence and uncertainty: Fresh production scan after verified default STS found 12 persisted category entries (13 effective defaults), 174 rules, no pattern rules, three cards and 492 movements. Rule ties depend on ascending source-key order; official DSQL uses C collation/UTF-8. Real pattern coverage is absent and needs local adversarial tests.
- Alternatives and tradeoffs: New schema/envelopes duplicate retained data; broad replacement of shared readers risks validation and mutation decisions. Existing payloads plus cards.source_item satisfy all read-only contracts.
- Decision and reason: No schema/transformer change. Bootstrap 6 adds SELECT on exactly categories/rules and associates existing card-cycle worker. Explicit strong paginated source readers remain for rule classification, card max-three/liability validation and all movement mutation/manual-dedupe reads. Catalog/rule API, category analytics/assistant/report and standalone card/cycle reads use a new shadow flag. Existing worker/assistant movement readers get a separate shadow flag, leaving API movement guarded mode intact.
- Consequences, verification, and revisit conditions: Verify complete metadata, effective defaults, source key ordering, exact/pattern precedence, deletion/lag/failure and independent columns/content. SQL failure or mismatch selects source; source failure propagates. Revisit only for write-authority phase.
- Status: Implemented; validation in progress.

### D2 — Share financial inputs and verify deterministic notifications without delivery
- Context: SQL attempts inside month/day/card loops multiply outage latency; existing reminder only reads Patrimonio and has no movement input.
- Evidence and uncertainty: Monthly close already requests one four-month movement feed and one wealth bundle. Daily push selects one monthly feed; card-cycle selects cards once before reminder/subscription loops. Assistant compare_months previously selected two monthly feeds. Reader connection/query bounds remain 1.5s/3s.
- Alternatives and tradeoffs: A custom circuit breaker adds state; per-loop selection adds latency. Reuse selected bundles and unchanged domain functions.
- Decision and reason: Assistant comparison loads both months once. Worker flags reuse existing shared movement selection and card selection outside loops. Independent gate compares explicit SQL/source categories/rules/cards/columns and movement inputs, assistant aggregates/ranges, full monthly facts plus deterministic email rendering, daily push and all card reminder dates/content modes including leap/short February. Existing Patrimonio gate covers reminder rendering and evidence without sending.
- Consequences, verification, and revisit conditions: No scheduling/delivery/idempotence behavior changes. Existing native capture/recovery/OCC suffice; no custom telemetry beyond established domain mismatch counters or new replication service. Test SQL call counts on outage and preserve financial algorithms.
- Status: Implemented; validation in progress.

## Pre-PR verification checkpoint

- Full workspace suite passed 414 tests before the two final boundary/source-only additions; seven focused SQL domain tests now pass. All workspace checks, nine Python recovery tests, web build and infrastructure synth passed. Final API suite passed 232 tests, bringing the workspace total to 416; final web build/synth also passed after the additional tests and refined comparison input sharing.
- Private local PostgreSQL projected 189 retained catalog/rule/card records plus the unpersisted default category: 190/190 keys matched after two reconciliation passes, zero mismatches. Native read-only DSQL queries confirmed 13 categories, 174 rules and three cards, source order matches UTF-8 C collation, schema rows [1,2,3], current eleven SELECT grants before rollout.
- All ten protected DynamoDB/DSQL/KMS/S3/mapping resource definitions match the pre-phase deployed template exactly. Synth flags: API ledger guarded/domain shadow; agent ledger/domain shadow; daily ledger shadow; report ledger/domain shadow; cycle domain shadow. Existing planning/wealth remain guarded.
- Review found a subtle risk when sharing distant comparison months: a union could widen each month's MSI +/-24-month window. The shared bundle now reapplies the existing per-month feed scope before calculating each side and preserves invalid-month rejection. A dedicated distant-month regression passes. Financial algorithms are unchanged.
- Source-only movement/card decision regressions pass. Default/rule pagination, exact/longest/tied patterns, stale add/edit/delete, full card timestamp/issuer data, rollback/no-SQL, source failure, independent corruption detection and one-attempt outage loops pass.
- Initial standalone card parser tests exposed an eager environment import. Card configured reads now load their adapter on demand so pure input parsing retains its existing environment-free contract; full tests passed after correction.
- Native docs revalidated SQL/UTF-8 C collation/IAM/Streams recovery. No new schema/projection/recovery gap exists; only existing bootstrap extends grants/association.
- Next: shadow PR/quality/CLEAN/MERGEABLE, linear merge and deploy-production; independent production gate must pass before guarded promotion.
