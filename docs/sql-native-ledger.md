# Native financial ledger

Olbia must feel born in SQL. David's canonical financial facts, capture provenance, edits and installment relationships have one relational authority; document keys and duplicated operational envelopes are retained only as recovery evidence.

This coherent release activates migration 14 after the already deployed core and bulk guards (#186/#187). Production acceptance is pending until the PR, required quality, linear merge, deploy-production and independent live gates finish. The [run record](autonomous-runs/2026-10-02-native-ledger.md) records the design decisions and release evidence.

## Relations and authority

| Relation | Domain key and purpose |
| --- | --- |
| `ledger_movements` | Movement UUID; typed current money, currency, status, dates, account assertions, category and personal amount. Required primary-observation ownership uses a deferred composite FK. |
| `ledger_observations` | Observation UUID and movement FK; unique insertion position, immutable original source, amount, account, parser and evidence assertions. Canonical money may differ after a posted foreign transaction or MSI interpretation. |
| `ledger_movement_warnings` | Movement and ordered position; current review warnings. |
| `ledger_observation_warnings` | Observation and ordered position; immutable original parsing warnings. |
| `ledger_tags` | Movement and ordered position; unique tag per movement. |
| `ledger_revisions` | Original text revision ID, movement FK and optional bulk-operation FK; immutable changed-by/time/change evidence. |
| `ledger_bulk_operations` | Operation UUID; owner, typed lifecycle times/status and immutable original selection/change assertions. |
| `ledger_bulk_members` | Operation and ordered position; unique movement FK and immutable preview/before/after assertions. Preview totals derive from these members. |
| `installment_plans` | Movement FK; typed plan terms, status and schedule-completion state. |
| `installment_entries` | Movement and installment index; unique month, typed cuota/status/date/confirmation, explicit provenance kind and exact bank-capture row FK when proven. |
| `installment_evidence_candidates` | Installment and candidate capture coordinates; real installment/import-row FKs preserve historical ambiguity. |
| `source_claims` | Capture kind and domain token; immutable original claim assertions and explicit linked, intentionally suppressed, unresolved-suppression or historical-missing outcome. |

No native relation uses PK/SK/GSI, document routing identities, projection source envelopes or an operational payload column. JSON is confined to variable original provider metadata and immutable audit assertions. Account details are original capture assertions; they do not invent an account catalog or equate every purchase with a card profile.

Original observations, warnings, revisions, claims and bulk members are INSERT-only for application identities. Bulk updates are limited to lifecycle columns. Canonical movements support INSERT/UPDATE; tags/current warnings/MSI relations support their actual replacement operations. Product readers cannot read retained recovery claims or projection state. The isolated deployed verifier can read current and retained facts, with no write grants.

## Financial behavior

All email, Apple Pay, manual, bank statement/CSV capture, single edits, category assignments and normal/assistant bulk preview/apply/undo use direct SQL. Canonical movements and immutable original captures commit in the same provider transaction. Source-kind/token uniqueness gives idempotence; original files use native S3 conditional creation outside retryable SQL callbacks. Linked captures preserve original evidence and annotations, while posted MXN can promote a pending USD authorization without rewriting the USD capture.

Feeds, detail, all-event queries, summaries, analytics, reports, assistant tools and workers read native typed relations directly. Capture arrays/counts derive from ordered observations. Detail derives original source/parser fields from the primary capture. Raw email follows an actual email observation even when a shortcut was captured first. Installment membership follows its real month relation without a purchase-age cutoff. The existing movement_months view derives spend and installment membership from current native relations and stores no duplicate data.

Zero personal share differs from absence; spending uses personal share while bank matching uses original gross money. Pending USD stays outside posted MXN spending. MSI confirmation points to an owning capture/hash/ordered row, never a globally assumed row identity. Repeated identities retain explicit ambiguity and all candidate relations. Unexplained historical targets remain assertions, not fabricated parents or deleted suppression claims.

Every financial mutation and the one-time copy share the deployed application barrier. Aurora DSQL's transaction wrapper owns snapshots, optimistic conflict resolution and retries. Bank apply reserves its complete row budget, including observations/warnings, MSI replacements, claims, deferral, revisions and final import completion. An over-limit or interrupted apply rolls back the whole import and all financial facts. The provider owns byte/time limits; external evidence preparation does not repeat on SQL retry.

## Migration and verification

Bootstrap adds the native tables, validates deferred primary-observation ownership, waits for parent/time revision and installment-month indexes, and grants existing runtime roles. It then decodes the retained facts fail-closed and copies all twelve relations plus marker 14 in one transaction. Restart sees the marker and never recopies later native edits. Retained observations/revisions/imports and the DynamoDB recovery source remain unchanged.

A separately deployed reader guard rejects legacy financial reads after activation, and deployed writer guards reject late document mutations. This prevents frozen values from being served as current finances during Lambda replacement. Obsolete financial read-mode flags are removed; unrelated wealth/operational compatibility remains scoped to their unfinished domains.

The deployed read-only gate uses a separate bounded SQL snapshot for each phase. Current typed fields, original provenance/history, independent SQL monthly totals, ordered feeds/ranges/detail, planning, wealth, domain and operational contracts are checked independently. Original object hashes are collected in SQL and rehashed outside the provenance snapshot; inline originals are valid only for actual Apple Pay captures. Public results expose counts, mismatch totals and timing/scan information, never private rows or financial totals.

The deployed native smoke exercises capture replay, personal zero, category/tags/status/current-versus-original warnings, revisions, MSI replacement, bulk lifecycle and suppression replay. It explicitly checks deferred constraints before deliberately rolling back. Deployment requires current-native provenance/evidence success and an explicitly native ledger smoke; an older successful probe cannot satisfy the release gate. Independent SELECT-only post-deployment acceptance must also compare the exact native copy and retained prerequisites against the private real-data baseline.
