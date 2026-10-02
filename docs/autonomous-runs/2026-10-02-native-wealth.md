# Native wealth captures — 2026-10-02

## Objective and completion criteria

Continue David's unbounded normalization goal until he stops it. Olbia must feel born in SQL. Normalize the complete asset/debt capture boundary: account identities, immutable captures and ordered holdings, canonical account/card daily selection, same-day replacement history, direct manual/provider writers and every overview/history/assistant/report reader. Complete migration/grants/gates/rolled-back smoke, PR/quality/linear merge/deploy-production and independent real-data/evidence acceptance before declaring this domain complete. Then choose the next slice.

## Constraints and baseline

David is the sole owner. Root AGENTS, autonomous rules, product north star, UI brief/web AGENTS and Patrimonio contract were read. Preserve three tabs, financial/timezone/as-of/zero/precision semantics and derived Fondo. No new users, sharing, generic provider configuration, manual deployment or direct production financial mutation. Native SQL constraints/OCC/transactions and S3 remain the platform capabilities; no permanent DynamoDB envelope/PK/GSI/emulator model.

Branch `codex/sql-native-wealth-captures` begins directly at fetched origin/main `284084ea4b930b4e70ea5463f18f266af0948fe2` (#190). Ledger #189 is fully deployed and independently accepted. Guard #190 passed final quality `37075098035`, CLEAN/MERGEABLE and squash-merged; main deployment `37075376994` and independent unchanged-data acceptance remain required before this domain releases. Marker 15 is absent.

Fresh private SELECT-only baseline: 122 canonical assets, four prior assets, 22 canonical debts, three prior debts; 437 ordered holdings; 151 exact original evidence objects, all hashes verified. One authenticated owner, three actual asset accounts, three existing card profiles. Every recorded day matches the Chihuahua capture date; every historical replacement resolves to a unique actual successor on the same account/card/day. Source totals equal holdings sums; no duplicate holding IDs, invalid quantities or unsafe integer money. Baselines/evidence proofs live outside Git at `/Users/decs/.local/share/olbia-normalization/2026-10-02-native-wealth/` (directory 700/files 600).

## D1 — Immutable captures plus explicit current daily selection

- Context: Today same-day replacement duplicates the prior capture into a version document while overwriting its daily document, including embedded holdings and full envelopes.
- Evidence and uncertainty: All seven original replacements resolve to actual next captures; capture timestamps are unique in the baseline but future requests can share a millisecond. Historical holding labels/values must remain captured facts, not joins to today's instrument metadata.
- Alternatives: Normalize separate mutable daily snapshot/audit tables and duplicate the captured header when replaced, or store each immutable capture once with a constrained daily pointer and explicit replacement edge. A shared asset/debt table would conflate distinct valuation facts.
- Decision: Use eight relations: asset_accounts, asset_captures, asset_holdings, asset_daily_captures, asset_capture_replacements, liability_captures, liability_daily_captures and liability_capture_replacements. Asset IDs anchor David's actual three capture accounts; Fondo stays derived. UUID capture identities allow simultaneous timestamp values. Composite capture ownership FKs constrain daily pointers and both ends of replacement edges to the same account/card/day. Preserve original prior-version UUIDs as identities of those prior captures; allocate ordinary current/new capture UUIDs using the existing native Node capability. No custom deterministic ID algorithm or document-derived runtime keys.
- Verification/consequences: Originals/holdings/replacement edges are INSERT-only; only daily selection changes. Validate the original seven successors without guessing, preserve historical IDs and compare newly allocated capture IDs by immutable facts/relationships rather than expecting random UUIDs from a rehearsal to match. Test repeated captures, rollback/OCC retry, equal timestamps, real original evidence and ownership FKs. No public snapshot response changes.
- Status: Provisional; foundation/consumers/release pending.

## D2 — Preserve current numeric meaning and signed provider cash

- Context: Asset quantities and FX use JavaScript numbers, while money uses integer minor units. Default SQL numeric precision or nonnegative checks could silently alter existing provider semantics.
- Evidence: All real holdings/FX are finite and current amounts nonnegative. Existing IBKR parser allows signed quantities and its cash holding preserves signed endingCash; this is an existing contract, not a request to add margin features.
- Decision: Use finite double precision for quantities/FX to preserve the current JavaScript value exactly; FX remains positive. Holding money uses signed safe-range bigint, liabilities use nonnegative safe-range bigint and paid-zero stays valid. Preserve per-capture labels, currencies and values. Validate round trips against every real holding/rate, including explicit negative-cash and fractional fixtures. Do not reinterpret or repair provider valuations in this storage slice.
- Status: Provisional; actual typed round-trip proof pending.

## D3 — Derive asset totals with native SQL instead of persisting an application aggregate

- Context: Asset totalMxnMinor is calculated by persistWealthSnapshot from its holdings, then duplicated into every current/prior envelope. It is not an independent provider assertion. Liability amounts, in contrast, are the directly entered balance and have no holding children.
- Evidence: Every retained asset total equals the sum of its captured holding values, and provider evidence contains the immutable original positions/holdings. Native SQL SUM already supports the financial ledger's authoritative calculations.
- Alternatives: Keep the computed total as an immutable header assertion or derive it from the immutable holding rows. The latter removes an unnecessary competing financial value while preserving exactly the original total; original documents/files remain recovery evidence.
- Decision: Derive asset totals by SQL SUM over each capture's ordered holdings (empty capture = zero), validating the original totals before copy and safe-range totals on writes/decoding. Store the direct liability amount in its capture. Derive the fixed MXN response unit from this established reporting contract; source currency remains a typed holding fact. Keep original provider FX/evidence as capture facts.
- Verification/consequences: Compare every canonical/prior total, as-of overview, daily/account/investment history, monthly net trend, precierre and monthly close to the existing real contract. A mismatch rejects copy/activation; no historical total may be repaired by inference. Do not add an aggregate cache or materialized copy.
- Status: Provisional; foundation and real-data proof pending.

## Progress and next steps

Guard #190 release is running. Implement the native schema/copy/read foundation and prove the real data locally while it deploys; do not activate marker 15 or publish a partial domain. Then direct manual/provider writers, independent original/history/current financial gates, native role grants/indexes/bootstrap and rolled-back smoke. All required quality/deployment/independent acceptance remains ahead.

Foundation follow-through: replacement time comes from its actual successor capture, eliminating another duplicate timestamp; old version UUIDs become the prior captures' native identities. Migration allocates UUIDs only for current captures that had none, within the atomic copy attempt; immutable facts/pointers/edges are the independent acceptance oracle for these new identities. Runtime capture UUIDs/timestamps will be allocated before retryable SQL work. Native asset totals remain derived, and the fixed MXN/manual liability response labels remain domain constants rather than duplicated columns. Validate the complete retained source/projection before conversion and reject unknown fields or partial native rows; no runtime reader/writer may call the old projection model.

Guard prerequisite accepted: #190 production workflow `37075376994` and independent post-smoke SELECT-only comparisons pass. Marker 15 remains absent; wealth/card/payroll/recovery data and the native financial ledger are unchanged.

Native foundation locally verified: eight relation definitions and one-time conversion/atomic activation are prepared but deliberately unwired from production bootstrap. Four integration cases pass, including exact capture/history UUID preservation, signed/fractional/provider facts, paid zero, ownership/uniqueness/finite-value constraints and full rollback/partial-copy rejection. Corrected TypeScript narrowing of validated holdings/successors; ledger typecheck now passes. The private real-data harness copies all 126 assets, 25 debt captures, 437 holdings, 144 current daily pointers and seven actual replacement edges in 744 mutations including barrier/marker. Every canonical/prior public fact, original history ID/time, quantity/FX value and SQL-derived asset total matches exactly; all retained rows remain unchanged. Current UUIDs are new native identities, so comparison uses immutable facts/edges as planned. Full readers/writers/gates/grants/bootstrap/smoke/release remain required; this is a local foundation, not native wealth completion.

Empty-capture verification accepted: five foundation integration cases now pass, including an explicit empty provider capture that remains canonical with no manufactured holdings and a derived zero total. The actual 151-capture private proof and corrected ledger typecheck pass.

## D4 — Reuse the native product-reader snapshot for the wealth input bundle

- Context: Typed wealth input requires account metadata, selected capture headers, holding children, liabilities and card profiles. Separate uncoordinated queries could mix current daily pointers from different commit instants. A heterogeneous JSON envelope or another cached projection is unnecessary.
- Evidence: The existing withLedgerReadSnapshot already uses the official Aurora DSQL pool.transaction and shared currentStoreTransaction context; provider snapshots/retries are established by the native ledger. Native bigint/double precision/UUID/date types cover the new facts. [AWS type documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html) confirms double precision and the numeric default precision distinction.
- Decision: Read ordinary typed rows and native SQL SUM inside that existing snapshot, with bounded parent/child queries; reuse an explicitly supplied/current transaction client for verification/writer contexts. Shape nested public holdings in the API decoder only. No stored/read authority envelope, new pool/lock/cache or fallback to recovery documents.
- Verification: Exercise snapshot client reuse/no SDK fallback, exact real capture/date/precision/history/current-pointer reads, empty/paid-zero behavior and sanitized driver failures. Live timing remains a release check.
- Status: Provisional; typed reader implementation and consumers pending.
