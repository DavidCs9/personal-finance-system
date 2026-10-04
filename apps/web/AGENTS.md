# Web implementation rules

Before planning, implementing or reviewing a UI change, read these binding guides completely:

- [Product north star](../../docs/product-north-star.md).
- [UI direction](../../docs/ui-design-brief.md), the canonical hierarchy, voice, visual and interaction rules.
- [Financial rules](../../docs/financial-rules.md), the canonical calculation and financial-state contracts.

Design for David alone and his real data. Preserve Resumen / Movimientos / Patrimonio; assistant stays a global sheet. Net worth and monthly spending remain separate. Follow the guides for MSI, liquidity/estimates, Mi parte, rejected/foreign/deferred states, category/tag semantics, capture freshness and monthly total versus daily account history. Do not reproduce those contracts here or infer new product decisions from implementation details. An explicit personality change updates this file and UI direction together.

## Implement and review

- Verify a narrow mobile viewport first, safe areas, readable primary state without horizontal scroll, comfortable touch targets and reachable actions. Desktop adapts the same contained experience.
- Preserve numeric hierarchy, aligned/tabular money, ivory/charcoal palette and meaningful red. Copy stays direct, precise and useful without shame or celebration.
- Verify honest loading, missing income, uncertainty, empty, failure, stale manual balances and negative projection states against persisted facts. Evidence remains reachable.
- Use the [API client](src/api/client.ts) boundary instead of direct component fetch calls; refresh affected queries after a mutation. Preserve resume/session renewal and network-only financial reads.
- Private mode protects amounts, assistant receipts and restored conversation text/titles. Never expose private reasoning or raw tool payloads.
- Inspect current domain/API contracts when fields or financial meaning change. Run meaningful existing checks; do not invent mirrored tests for reversible presentation edits.

The [web README](README.md) describes local development and demo limitations. [Assistant](../../docs/ai-assistant.md) governs conversation continuity, citations, bounded edits and prompt preservation.
