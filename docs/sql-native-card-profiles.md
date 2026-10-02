# SQL-native card profiles

Olbia must feel born in SQL. Card profiles are domain entities, with `id` as their primary key and typed columns for name, issuer, cycle days and timestamps. `owner` binds David's authenticated access; it does not introduce a multiuser product.

`olbia.card_profiles` is the sole live profile authority. Required names, valid domain IDs, cut-off/payment days 1–31 and supported card issuers are native SQL constraints. Card CRUD accepts domain arguments, reads typed columns and writes SQL directly. The former document keys, SDK commands, payloads, projections and domain fallback flag are removed from live profile operations.

## Historical identity and financial behavior

Deleting a profile sets `deleted_at`. Active readers omit it from cycles, reminders, current/as-of Patrimonio and the three-card limit, preserving existing behavior. Current and historical liability captures remain intact and keep valid native references to the retained profile identity. Recreating the same ID reactivates it, subject to the active-card limit, with the same public creation-time behavior as a legacy delete/recreate.

Both `liability_snapshots.card_id` and `liability_versions.card_id` require a parent through validated native CHECK/FK constraints. These tables' complete normalization remains a separate audit item; this slice establishes their profile relationship without changing financial captures, amounts, versions or evidence. Zero remains a valid paid-off balance. Card profiles remain cycle settings, never expenses or monthly commitments.

All mutations share the existing application transaction and native OCC barrier. Active-card validation for liability capture runs inside that transaction using the application SQL identity. Profile creation/deactivation/reactivation and liability captures therefore cannot bypass each other's validation through concurrent writes. Wealth's complete SQL input bundle remains a single statement; it reads typed profile columns directly without reconstructing a document envelope. Its temporary source path for other domains also uses native profiles.

## Staged migration and recovery

1. Deploy the legacy-writer guard in PR #177. A legacy card write rejects once migration 9 exists; profile deletion explicitly joins the application transaction.
2. Create the native profile table through separately committed, resumable DDL.
3. Use the official Aurora DSQL connector's retrying transaction to update the shared application barrier, copy profiles and commit migration 9 atomically. A legacy mutation either commits before that copy or retries and encounters the guard. There is no dual writing or lost-edit window.
4. Add required-parent CHECKs and FKs to both liability tables using `NOT VALID`, then wait for native `ALTER TABLE ASYNC ... VALIDATE CONSTRAINT` jobs. Commit migration 10 only after all four constraints are validated. [AWS ALTER TABLE documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html).
5. CloudFormation orders native consumers after schema bootstrap and grants. Profile editing may briefly report maintenance while legacy runtimes wait for replacement. Other financial domains continue.

Migration replay skips the copy once marker 9 exists, preserving native edits and inactive profiles. If copying fails or its transaction aborts, the copy, marker and barrier update roll back together. If later relationship validation fails, the reviewed release fails closed and can resume through the next corrected PR; it must not revert to frozen profile writes or erase the marker.

Old `olbia.cards` rows and their checkpoint envelopes remain frozen migration/recovery evidence. Maintenance and evidence gates still verify them, independently of live profile authority. They are not a profile fallback. Retained source resources and backups remain intact; production releases stay owned by `deploy-production`.

## Acceptance

Local integration tests cover copy/marker rollback, interrupted migration replay, preserved latest pre-copy edits, rejected late document writes, invalid source data, typed CRUD, issuer clearing, owner binding, active-card limits, inactive identity/history, reactivation, transaction rollback, native constraints and February cycle clamping. Existing financial/evidence tests cover paid-zero balances, carry-forward, as-of/month-close boundaries, reports and reminders.

Live acceptance compares all migrated profiles to a fresh private preflight and verifies that every existing current/versioned liability record is unchanged. The deployed independent domain gate verifies typed profile mapping, active limits, zero invalid parent references and all four validated constraints. Reconciliation, financial/report/worker calculations and original evidence gates must all pass. The deployed operator upserts/deactivates/reactivates a real native profile inside its rolled-back smoke transaction and verifies retained liability counts. No acceptance step sends notifications or persists financial edits.
