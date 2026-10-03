# SQL-native category catalog

The architecture target is an application born in SQL; see the binding [north star](product-north-star.md) and [table audit](dsql-normalization-audit.md).

Catalog/rules and category integrity are deployed and independently accepted through [PR #176](https://github.com/DavidCs9/personal-finance-system/pull/176). The [completed run](autonomous-runs/2026-10-01-category-integrity.md) preserves all audited repairs and acceptance evidence; the [current table audit](sql-relational-table-audit.md) records the later native ledger relationships.

`olbia.spend_categories` is the only live category catalog. Its domain primary key is `id`; `name` and `sort_order` are required typed values. Database checks enforce the ID shape and a nonempty bounded label. Readers query these columns directly. Catalog updates use a SQL transaction and upsert existing/new IDs, preserving the existing API's additive behavior. The application cannot delete catalog rows.

Schema migration 6 copies persisted catalog labels/order first, then inserts missing defaults, and records completion. It is restartable and never repopulates or overwrites the native catalog after completion. A catalog read never seeds defaults, overlays code values or falls back to document data. SQL failure propagates so stale financial classifications are not silently presented.

Single movement changes, merchant rule changes and assistant/bulk category previews/apply/undo check target membership. Prepared operations revalidate their actual changed targets, including undo's previous value. Null is still a valid uncategorized movement; an empty merchant-rule target retains the existing no-assignment contract. Unknown nonempty IDs are rejected before mutation. Catalog membership is checked within an existing domain transaction where one exists.

The previous `olbia.categories` projection and its checkpoint/envelope records remain frozen migration/recovery evidence. They are not a second catalog authority and are never updated by native catalog writes. The product document adapter is retired, and native product roles have no frozen-table access. Migration verification still checks frozen artifacts for internal consistency, while category verification checks canonical SQL columns and the calculations consuming them.

`olbia.merchant_rules` is the only live rule authority after migration 7. Its primary key is the normalized `merchant_key`; rule ID, pattern, nullable category reference, source and timestamp are typed columns. Direct SQL upserts preserve existing rule IDs. UTF-8 merchant-key ordering preserves the previous exact/longest/equal-pattern precedence. The API still returns an empty string for no assignment, while SQL uses `NULL`. Retired rule document writers are rejected, and frozen projections remain recovery evidence.

The original rollout created the rule category FK before copying rules and validated the then-live movement FK through native `ALTER TABLE ASYNC`. Bootstrap waited for `pg_constraint.convalidated` before marker 8. The later native ledger now enforces the current `ledger_movements.category_id` FK; the earlier movement FK remains with frozen recovery. The read verification gate independently checks validated current relationships and zero unknown current assignments. Deployment smoke upserts native catalog/rule values within its existing rolled-back transaction.

The completed staged rollout deployed catalog membership validation, restored the 15 known invalid assignments through ten audited category undo operations, and deployed native rules and validated assignment FKs. All original revisions/source evidence were preserved and 15 category-only revisions added. No categories were invented merely to make invalid references pass validation.

Movement persistence is now the accepted [native ledger](sql-native-ledger.md), with a current category FK and direct SQL writers. Historic revision JSON retains the actual past classifications rather than rewriting them to match today's catalog.
