# Native conversation metadata — 2026-10-03

## Objective and completion criteria

Continue David's indefinite normalization goal until he stops it. **Olbia must feel born in SQL; David Castro is its sole user and owner.** Normalize conversation metadata and active selection end to end, preserving native AgentCore transcript discovery/history and the existing assistant behavior. Complete staged protection, relational copy/constraints/grants, all readers/writers, independent verification, rolled-back smoke, required PR quality/linear merge/deploy-production and real acceptance. A prerequisite guard alone is not completion.

## Constraints and baseline

Root AGENTS, autonomous rules, product north star, UI design brief, web AGENTS, Patrimonio and AI assistant guides apply. Preserve the three tabs/global assistant sheet, one persistent active conversation, explicit New Conversation clearing and private titles. Native AgentCore Memory retains transcripts/events for 365 days; durable memories remain separate. No verification chat, provider event deletion or fabricated transcript is authorized by this audit. Production code releases exclusively through PR/quality/deploy-production; private identifiers, titles and raw data remain outside Git in 700 directories/600 files.

The retained SQL audit contains 35 valid metadata headers and one active pointer resolving to a header, all for David's single owner. A fresh authenticated native `ListSessions(HAS_EVENTS)` audit at `2026-10-03T08:05:44.682Z` found 13 native sessions, all indexed; 22 headers currently have no native events. There are no invalid native IDs or native sessions lacking metadata. Native session discovery was read-only; no event payloads were read. Private evidence lives under `/Users/decs/.local/share/olbia-normalization/2026-10-03-native-threads/`.

## Decisions

### D1 — Keep provider authority and preserve every metadata header

- Context: Headers and native sessions have different counts. Treating all headers as visible transcripts would change current behavior; deleting headers without events would destroy retained metadata without evidence that cleanup is appropriate.
- Evidence and uncertainty: Existing listing intersects metadata with native HAS_EVENTS membership. Native SessionSummary exposes session/actor IDs and creation time, but not application titles, first month or explicit active choice. The reason each of the 22 eventless headers exists is not established by this audit.
- Alternatives: Move transcripts/discovery into SQL, discard eventless headers, or preserve metadata while retaining native provider authority. The first duplicates native retention/history; the second invents destructive cleanup.
- Decision and reason: Copy all 35 headers and the active choice exactly. Keep AgentCore responsible for membership/events and SQL responsible only for the documented metadata/selection gap. Do not regenerate titles or fabricate messages. Maintain existing membership, ordering, TTL and absent-choice versus explicit-null behavior.
- Consequences and verification: Exact relational metadata/selection comparison plus independent read-only native membership parity; injected provider tests exercise backfill/history/deletion without real provider mutations. Revisit cleanup only with evidence and an explicit product need.
- Status: Provisional; audit verified, native implementation pending.

### D2 — Stage protection before native activation

- Context: Old runtimes can backfill headers, change active choice or delete native events after a long provider read. Freezing document writes alone cannot stop an older delete call reaching AgentCore.
- Evidence and uncertainty: All metadata operations are centralized in threads.ts; chat saves metadata before Harness invocation. The existing SQL store barrier already coordinates native activation with legacy mutations. Read-only retained inventory must remain available to isolated recovery verification.
- Alternatives: Depend on deployment order alone, or first deploy marker-18 checks throughout old orchestration and mutation boundaries. Prior releases demonstrate that a separate guard avoids deployment dependency cycles.
- Decision and reason: First deploy marker-18 protection at old operation entry, metadata access and immediately before each native provider call, especially DeleteEvent; block all configured old product read modes and freeze the entire legacy assistant_threads family under the existing store barrier. Reuse SQL clients and maintenance/error contracts. This prerequisite creates no marker 18 and does not change ordinary before-marker behavior.
- Consequences and verification: Before/after-marker tests, mid-pagination activation with zero later provider deletion, sanitized storage errors, both header/active writes and mixed/enclosing rollback. Required quality/deployment plus independent unchanged-data acceptance precedes native release. In-flight provider IO already accepted before activation retains its existing behavior; do not claim SQL/provider atomicity.
- Status: Provisional; guard implementation next.

## Progress and next steps

Branch codex/sql-thread-cutover-guard starts directly from fetched origin/main at monthly-delivery merge 60c8bbef4ca21cdcd4ca231db3ff30c290a3e499. Monthly delivery production workflow 37108405981 is still completing verification; finish its independent acceptance before publishing this prerequisite. Build and validate the guard, then complete the native domain on a fresh main branch.

## Verification results

Read-only actual metadata and native session audits passed. No thread implementation or release checks have run yet.

## Outcome and remaining work

Conversation metadata normalization is in progress. The overall autonomous goal remains active.

Guard local checkpoint: all 18 targeted cases pass (nine existing behavior cases, six old orchestration/provider/read-mode guards and three actual SQL/barrier rollback cases). All 706 workspace tests, all workspace typechecks, 21 Python deployment checks and synthesis pass; all 44 protected retained/identity resource definitions remain exact. Authenticated SELECT-only pre-release capture at `2026-10-03T08:17:08.419Z` retains all 57 non-control tables / 6,846 rows, including all six accepted delivery rows and 36 exact thread records; marker 17 is active and marker 18 absent.

Monthly delivery #195 is now deployed and independently accepted; its completed record accompanies this guard PR. Final fetch/rebase, required final-head quality/CLEAN/MERGEABLE, linear merge/deploy-production and exact unchanged-data guard acceptance remain required. Native metadata activation remains unpublished.
