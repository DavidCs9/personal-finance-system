# Assistant

Olbia's global financial assistant follows the [UI](ui-design-brief.md) and [financial rules](financial-rules.md). Answers use deterministic tool facts with citations; tools never reconstruct a document-store authority.

## Runtime and access

Cognito JWT → dedicated REST API POST /agent/chat → streaming Lambda → AgentCore Harness → IAM Gateways. Ledger's other routes stay on HTTP API. Browser reads SSE with fetch/ReadableStream, not EventSource; it never calls AgentCore. Authorizer/handler restrict claims.sub to AgentOwnerSub; tools use the configured AGENT_OWNER, never a model/browser-supplied owner. CORS permits Olbia's web origin, including authorization errors.

Harness owns the loop. Finance read tools and bounded mutations use separate Gateway/Lambda targets. Native Cedar Policy Engine ENFORCE denies by default and permits only the eight mutation actions to the exact Harness IAM role. Read tools have no write authority; no generic database-write tool or public /bulk-edits endpoint exists. Managed Web Search preserves citations; code interpreter is off.

Harness/Memory/Web Search run in us-east-1; finance Gateway/tools/DSQL in us-east-2. Model/prompt/inference are resolved at runtime, not hardcoded. The Sonnet adaptive-thinking path omits temperature from its invocation and reserves reasoning/answer tokens according to the adapter; provider configuration remains in Prompt Management. Inspect [agent code](../services/api/src/agent) for exact streaming/tool contracts.

## Tools and financial meaning

| Tools | Purpose |
| --- | --- |
| month_snapshot, spend_by_category, spend_by_merchant, list_movements, compare_months | Canonical spending, evidence, categories and comparisons; disclose truncation/uncertainty/date precision. |
| plan_month_scenario | Deterministic currency, commitments, inclusive days/nights and month-close scenarios; derive the requested budget rather than asking David to invent it. |
| wealth_snapshot | Neto/assets/debts, read-only. |
| investment_history | Market investments Bitso + IBKR, account/holding selection, as-of/range/all-time history. |
| WebSearch | Current public information with links/citations. |
| preview/apply/undo_tag_edit; apply_tag_edits | Bounded tag-only operations. |
| preview/apply/undo_category_edit; apply_category_edits | Bounded category-only operations. |

Investment history excludes Cajita/Fondo/debts/Neto. Default period all; as-of uses latest evidence on/before date. Global series carries each account forward and exposes coverage, ages, partial/mixed dates. Variation includes FX and is not flow-adjusted return. Symbol ambiguity returns candidate holding IDs, never guesses. Unit-price extremes exclude pre-buy/post-sell days; extrema use daily evidence even if displayed monthly. Range change and first/last in-range change are distinct. Expected no_data/ambiguous/invalid states are data, technical failures are errors.

## Mutations

An explicit chat instruction authorizes the bounded tags/category change. In the same turn:

1. Resolve exact movement IDs or inclusive date range plus explicit selector. Tags accepts exact merchantRaw/sourceTags/onlyUntagged; categories merchantRaw/sourceCategoryId/onlyUncategorized. Dates alone are rejected. Only accepted movements are eligible.
2. Preview returns every affected movement and freezes IDs, previous/next values, count and amount. Maximum 49 movements per operation; batch accepts 1–12 nonoverlapping operations under existing limits.
3. Apply exactly those operation IDs atomically, creating a revision per movement. Changed preconditions/expired previews reject apply and require a fresh preview. Apply/undo are idempotent; undo restores frozen before-state under current preconditions.
4. SSE mutation refreshes ledger and shows factual receipt per operation. No second UI confirmation; undo is requested by chat. Category edits never change merchant rules. Tags never change financial totals.

## Conversations and memory

AgentCore Memory owns raw transcript/discovery and 365-day retention; durable facts/preferences are separate. SQL conversation_threads stores original title/first month/activity/expiry; assistant_thread_selection stores David's active choice with FK. Listing intersects metadata with provider HAS_EVENTS and can backfill visible older sessions. Eventless headers are not invented history or grounds for destructive cleanup.

Closing sheet/reloading/changing month keeps session; month supplies next-turn context. New Conversation clears active choice without deleting old threads. GET /agent/threads lists recent conversations; detail restores visible provider events; PUT /agent/threads/active selects/clears; DELETE removes provider events before atomic metadata/selection cleanup. Provider failure preserves metadata; provider and SQL deletion are not one transaction. Scheduled metadata expiry is separate from provider retention.

Memories never mutate ledger/totals. Long-term strategies reject assistant inference, intermediate calculations, current balances and unconfirmed units/dates; explicit user correction replaces prior fact. Keep conversations and durable memories independently visible/deletable. Private mode protects restored text/titles/receipts. Show citations and compact tool status/duration, never raw financial inputs, private reasoning text/signatures or restored activity as live. Failed tools remain visibly unavailable while other results may support a partial answer.

## Prompt Management

**Binding:** private prompt, profile and voice live exclusively in Bedrock Prompt Management. Never commit them or add application seeds/default/fallback prompts or model/inference defaults. Active pointer: SSM /personal-finance-v1/agent/runtime-system-prompt-version-arn → immutable version ARN. Runtime reads it with ~30-second cache, GetPrompt and Harness overrides. Required version: nonempty text/system prompt, modelId, temperature and maxTokens configuration. CDK owns retained AWS::Bedrock::Prompt; CI preserves current DRAFT through NoEcho parameters, without storing private content in Git. Deploys do not promote versions or change pointer.

Before creating/promoting a version, read active version and latest personal-profile baseline; merge new behavior without losing profile, voice or retained operational rules. Baseline v10 preserves v5's private profile plus continuity/investment/research behavior; only an explicitly approved successor replaces it. Verify all preserved sections before version creation and again by reading back immutable version; only then move SSM pointer. Never substitute generic v9/profile-less text. Rollback selects a verified prior immutable version. These are authorized runtime prompt operations, separate from code deployment; verify AWS identity as in [operations](operations.md).

Monthly-close analysis reads only private profile/voice from that same version, excluding chat tool rules and prompt text from persisted reports. [Agent runtime README](../services/api/src/agent/README.md) points here for enforcement and to deterministic scenario/golden tests for validation.
