# Native SQL Patrimonio

**Olbia must feel born in SQL. David is its sole owner.** Assets and card debt use native financial capture relations, without document keys, embedded authority envelopes, source freshness checks or read-mode fallback. Original S3 files and frozen migration tables preserve recovery evidence. The [run record](autonomous-runs/2026-10-02-native-wealth.md) records decisions and release acceptance; [PR #191](https://github.com/DavidCs9/personal-finance-system/pull/191) is deployed and independently accepted.

## Financial model

| Relation | Meaning and constraints |
| --- | --- |
| `asset_accounts` | David's three capture accounts, with display metadata/order. Native account primary key; runtime read-only. Fondo stays derived from payroll. |
| `asset_captures` | One immutable captured header with UUID, account FK, authenticated provenance, Chihuahua day/time, source, optional FX and original evidence reference. |
| `asset_holdings` | Immutable ordered children of the capture; parent/position primary key and unique holding ID within that parent. Captured labels/currencies/quantities remain historical facts. |
| `asset_daily_captures` | One selected capture per account/day. Composite ownership FK; only capture selection can change. |
| `asset_capture_replacements` | Explicit prior → replacing capture on the same account/day, with unique ends and ownership FKs. Replacement time comes from the replacing capture. |
| `liability_captures` | Immutable UUID capture with existing card FK, authenticated provenance, day/time, direct nonnegative MXN amount and evidence. Zero means paid. |
| `liability_daily_captures` | One selected capture per card/day, with matching capture ownership. |
| `liability_capture_replacements` | Immutable same-card/day replacement relationships. |

Asset totals are derived with SQL `SUM` over captured holding values; empty holdings derive zero. Money uses safe-range integer minor units. Finite double precision preserves existing provider quantities/FX, including signed IBKR cash and quantities. Migration validates every original total before copying; it cannot repair values by inference. Liability amount is a directly entered fact, rather than a holdings aggregate.

Existing prior-version UUIDs become the identities of those immutable prior captures. Former daily documents had no capture identity, so migration allocates native UUIDs atomically. Independent acceptance compares their original facts and relationships rather than rehearsal UUIDs. Every actual historical replacement must resolve to an evidenced successor; ambiguous linkage fails activation.

## Reads and writes

Manual Cajita, card balances and scheduled/manual Bitso/IBKR syncs share the native capture primitive. Capture UUID/time and integer/precision validation precede evidence IO. S3 conditional creation preserves content-addressed originals. The existing connector transaction, activation barrier and OCC retry insert a header/holdings/replacement and update daily selection atomically. Only daily `capture_id` changes; originals and history are INSERT-only. A later committed capture replaces the daily selection even when its measurement time is equal or earlier, preserving the existing behavior without losing either UUID capture.

Typed product reads reuse the existing official transaction snapshot and shared current transaction context. SQL selects current headers and derives totals; ordered holding rows become nested public objects in the API. Native account metadata supplies the existing display order, with derived Fondo in its established position. History/report/assistant/reminder consumers share that input contract. Month-end carry-forward, first-day exclusion, paid zero, Fondo yearly derivation and the Resumen / Movimientos / Patrimonio model remain intact.

Product and store roles cannot read the four frozen wealth financial tables. The isolated verifier/admin can read recovery assertions; maintenance retains SELECT only. Native product/store/verifier reads are SELECT-only. Application/operator originals have INSERT without UPDATE/DELETE, and daily selection has INSERT plus UPDATE(capture_id). Account metadata has no runtime write grant. Existing primary/unique indexes cover the observed capture/holding/replacement access patterns; actual plans/timings determine any later secondary index.

## Activation and verification

The staged [guard #190](https://github.com/DavidCs9/personal-finance-system/pull/190) prevents old wealth bundles from reading/writing frozen financial state after marker 15. Bootstrap provider version 17 prepares DDL and role permissions, requires native ledger marker 14, and copies all retained wealth facts plus marker 15 in one transaction. Partial native data or invalid source/projection facts fail closed. Re-running an activated migration preserves every capture.

The independent verifier constructs its current/history oracle directly from typed rows, exact integer sums and explicit pointer/replacement relationships. It checks required native constraints and every public financial/history/investment/close/reminder result. Frozen assertions prove immutable originals and preserved prior UUIDs/successors, while legitimate later native captures remain authoritative. Original object IO happens after the SQL snapshot closes; the existing unique-object hash verifier also checks owner/account/card/day, captured holdings/direct amount and FX against the actual provider/manual evidence format. Private content never appears in public verification output.

The deployed IAM-only smoke calls the same capture primitive, exercising equal-time replacements, signed quantities/cash, empty asset totals and paid-zero debt with actual native permissions. It checks integrity and rolls the complete transaction back. The routine deployment gate requires both native ledger and native wealth smoke proofs. Release proceeds only through required PR quality, CLEAN/MERGEABLE, linear merge and `deploy-production`, followed by independent SELECT-only comparison of original/native/recovery data and grants.

The private baseline contains 151 exact original captures, 437 holdings and seven replacements. Local comparison covers all original facts, 60 overview/history/reminder dates, 196 investment queries and three monthly-close wealth comparisons with zero mismatches. These are observed verification counts, not live application counters. Frozen DynamoDB/recovery resources remain retained; removing them requires a separate decision.
