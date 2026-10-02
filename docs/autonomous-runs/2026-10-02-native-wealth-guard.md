# Wealth rollout protection — 2026-10-02

## Objective and completion criteria

Continue David's unbounded normalization objective: Olbia must feel born in SQL. Complete the financial ledger's production acceptance first, then stage protection for legacy asset/debt readers and writers before their native capture domain activates migration 15. This prerequisite must pass tests, required PR quality, linear merge, deploy-production and independent unchanged-data acceptance. It does not claim wealth normalization complete.

## Constraints and current state

David is Olbia's sole owner. Keep Resumen / Movimientos / Patrimonio and their financial semantics intact; Fondo remains derived from payroll. Preserve zero balances, historical captures, original evidence, fractional quantities/FX and prior-month as-of behavior. No local deployment or direct financial changes.

The branch starts directly from fetched origin/main `8f1b05731d59a7f21285f065f75ff2d789826660`. Ledger #189 passed final quality 37073535451, CLEAN/MERGEABLE and squash-merged; its production workflow 37073889294 and independent acceptance are pending. Do not advance this prerequisite's release ahead of that acceptance.

A fresh authenticated SELECT-only snapshot at 22:39 UTC proves 122 current asset captures, four prior asset captures, 22 current liabilities and three prior liabilities. All 437 holdings reconcile to their captured totals and retain valid quantities/integer money; all 151 captures retain evidence. Every prior capture's recorded supersession time resolves to an actual successor on the same account/card/day. Durable private baselines live outside Git under `/Users/decs/.local/share/olbia-normalization/2026-10-02-native-wealth/` (directory 700/files 600).

## D1 — Protect the entire existing wealth boundary before native activation

- Context: Wealth still reads/writes snapshot documents and their SQL projections. A future atomic copy alone cannot prevent older Lambda bundles from changing frozen documents or serving those balances after a native capture succeeds.
- Evidence and uncertainty: The ledger rollout exposed a real AgentCore dependency cycle, so function ordering is insufficient. Its staged marker guard is already proven and deployed. The four wealth families share existing API and scheduled sync consumers; explicit source and SQL readers remain callable outside configured selection. Migration 15 is not activated and no native wealth schema is introduced here.
- Alternatives and tradeoffs: Add a separate runtime authority flag, restructure infrastructure dependencies, or stage the existing SQL migration-marker/maintenance response across the four document families and all public/internal wealth readers. The staged guard requires an ordinary prerequisite release but no new resource, permission or financial authority.
- Decision and reason: Before migration 15, preserve current behavior. After it, old snapshot/version mutations and explicit/configured/source wealth reads fail closed with the existing MigrationPausedException; no projection/SDK fallback may serve retained balances. The future coherent native wealth release removes these old readers. Keep provider schema/version/grants unchanged because existing application/product roles already read schema_migrations.
- Consequences and verification: Prove all four old families and mutation command forms cannot alter retained data after activation, including whole-transaction rollback. Prove all direct/configured/source/audit/account/overview/agent paths reject without financial queries/SDK calls, while pre-activation values remain intact. Run appropriate complete checks and independent real-data acceptance after the reviewed release. Revisit only if an actual consumer bypass is found.
- Status: Provisional; implementation and release pending.

## Progress and next steps

Ledger production acceptance remains first. Implement/test the bounded protection, then PR/quality; merge only after #189 is fully accepted. No migration 15, native wealth table, production financial mutation or new infrastructure resource is authorized by this guard.

Local verification accepted: all 643 workspace tests across 95 files pass, every workspace typecheck passes, and complete synthesis preserves all 15 protected resource definitions. The guard reader case exercises 13 direct/configured/source/consumer paths plus each configured fallback mode without financial SQL/SDK calls after activation. Writer cases cover all four capture/version families and command forms, including mixed/sequential transaction rollback and paid-zero preservation. An unrelated exception fixture initially lacked its required entityType; corrected the fixture without weakening the runtime guard. Ledger #189 CloudFormation update has completed; its financial/evidence/smoke gate and independent acceptance remain first.
