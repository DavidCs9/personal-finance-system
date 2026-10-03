# SQL-native monthly plans and payments

[PR #180](https://github.com/DavidCs9/personal-finance-system/pull/180) is deployed and independently accepted; marker 11 is active. The [completed run](autonomous-runs/2026-10-01-native-month-plans.md) preserves exact parent/child, empty-month, financial/evidence and rollback acceptance. See the [current table audit](sql-relational-table-audit.md) for subsequent native domains.

Olbia must feel born in SQL. `month_plans` uses the calendar month (`YYYY-MM`) as its domain primary key, with David's access binding and a typed update timestamp. `planned_payments` contains typed payment identity, name, MXN amount, due day and ordering position. A native FK links each payment to its month; `(month,id)` is its primary key and `(month,sort_order)` is unique. CHECKs enforce names/IDs, safe positive integer amounts, due days 1–31 and positions 0–99. Those unique bounded positions also enforce the 100-payment limit natively.

The public month API continues to return income derived from payroll, including provisional/twin estimates and Fondo semantics, plus the month's fixed-expense list. Legacy stored income remains frozen evidence. Card cycles and MSI remain separate from fixed expenses. There are no new users or tenant abstractions; `owner` retains the existing authenticated access binding.

## Inheritance and writes

A missing month inherits the latest stored parent on or before the requested month. The native reader selects that parent and LEFT JOINs its ordered payments in one bounded SQL statement. An explicit empty parent is therefore preserved and stops older payments from returning. Reads never create an inherited parent. Future plans do not affect earlier months.

Saving updates only the chosen parent and replaces its complete child list inside the existing application transaction/barrier. Payment IDs and order are preserved, including reorderings of existing IDs; earlier months remain unchanged. Saving an empty list retains its parent. Native reads share the current write transaction so the returned response sees the saved state. Card/payment amounts and all payroll-derived results retain their existing public semantics.

Live plan service operations no longer use SDK/table arguments, prefixed keys, command envelopes or JSON payloads. Plan SQL errors propagate. Payroll also uses one native SQL authority after its receipt/line normalization; the temporary planning comparison flag is removed. See [native payroll](sql-native-payroll.md).

## Staged migration and recovery

PR #179 deploys unique-payment-ID validation and a legacy-write guard before native copying. Legacy month-plan writes reject after migration 11 exists; existing valid edits continue before that marker. All affected legacy writers already share the application transaction/barrier.

The native release creates empty tables through resumable DDL, with native PK/UNIQUE/CHECK/FK constraints installed. The official connector's retrying transaction then updates the application barrier, validates the retained list shape, copies all parents and ordered children and records migration 11 together. A failed/interrupted transaction rolls everything back. An old writer commits before the copy or retries and encounters the guard; there is no dual-write window. CloudFormation orders native consumers/grants after bootstrap. Plan editing may briefly report maintenance until runtimes are replaced.

Replay skips the copy after marker 11, preserving native edits and empty parents. Frozen `monthly_plans` projections/checkpoint envelopes remain migration/recovery evidence and are still independently verified. Their legacy income and original arrays are never a competing live plan authority. Retained source resources and backups remain intact.

Native SQL capabilities are documented in [AWS CREATE TABLE](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html); production releases remain exclusively PR/quality/deploy-production.

## Acceptance

Local tests cover latest pre-copy edits, exact parent/child values/order, empty parents, late-writer rejection, copy/marker/barrier rollback, replay without overwriting native edits, malformed retained arrays/duplicate IDs, native parent membership, unique order/identity and financial precision. Native service tests cover gaps/year boundaries, read-only inheritance, empty-stop propagation, atomic reorder/replace, prior-month preservation, owner binding and transaction rollback. Existing payroll/financial/report/worker tests continue to verify provisional income, estimates, Fondo, commitments and date clamping.

Production reconciliation, financial/report/worker/evidence gates must pass. The deployed planning gate checks native parent/child mapping, membership and validated PK/UNIQUE/FK state while separately checking frozen evidence and payroll. The deployed operator replaces a real month's child list and clears it inside a rolled-back transaction, proving the empty parent remains. Independent read-only acceptance compares every real parent/child, ID, amount, due day, position and timestamp with a fresh private baseline, checks the empty parents and marker/constraints, and confirms frozen source records remain unchanged after smoke. No acceptance step sends notifications or persists financial edits.
