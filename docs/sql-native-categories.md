# SQL-native category catalog

The architecture target is an application born in SQL; see the binding [north star](product-north-star.md) and [table audit](dsql-normalization-audit.md).

`olbia.spend_categories` is the only live category catalog. Its domain primary key is `id`; `name` and `sort_order` are required typed values. Database checks enforce the ID shape and a nonempty bounded label. Readers query these columns directly. Catalog updates use a SQL transaction and upsert existing/new IDs, preserving the existing API's additive behavior. The application cannot delete catalog rows.

Schema migration 6 copies persisted catalog labels/order first, then inserts missing defaults, and records completion. It is restartable and never repopulates or overwrites the native catalog after completion. A catalog read never seeds defaults, overlays code values or falls back to document data. SQL failure propagates so stale financial classifications are not silently presented.

Single movement changes, merchant rule changes and assistant/bulk category previews/apply/undo check target membership. Prepared operations revalidate their actual changed targets, including undo's previous value. Null is still a valid uncategorized movement; an empty merchant-rule target retains the existing no-assignment contract. Unknown nonempty IDs are rejected before mutation. Catalog membership is checked within an existing domain transaction where one exists.

The previous `olbia.categories` projection and its checkpoint/envelope records remain frozen migration/recovery evidence. They are not a second catalog authority and are never updated by native catalog writes. The document adapter rejects catalog mutations. Migration verification still checks frozen artifacts for internal consistency, while category verification checks canonical SQL columns and the calculations consuming them.

Rollout is staged: deploy the native catalog and membership validation, restore the 15 known invalid assignments through existing audited category undo operations, then add and asynchronously validate native assignment foreign keys in a follow-up PR. Preserve the original revisions and source evidence. Do not add missing categories merely to make invalid references pass validation.

The [run record](autonomous-runs/2026-10-01-category-integrity.md) tracks release and live acceptance. Merchant rules and movement persistence still use temporary compatibility storage and require their own complete normalization slices.
