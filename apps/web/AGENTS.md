# Olbia UI personality

These instructions apply to every change under `apps/web`. Treat them as product constraints, not optional visual preferences. The broader rationale lives in [`../../docs/ui-design-brief.md`](../../docs/ui-design-brief.md).

## Product promise

Olbia has two primary financial answers, on separate tabs:

- **Resumen:** how much have I spent this month, and what does that mean for the rest of the month?
- **Patrimonio:** how much do I hold in assets, and how has that changed?

Do not collapse patrimonio into Resumen. Do not let patrimonio analytics compete with the monthly spending hierarchy on Resumen.

### Resumen hierarchy

1. Amount spent this month.
2. Projected month-end result at the current pace.
3. Money remaining after upcoming commitments.
4. Explicit uncertainty for unconfirmed data.
5. Meses sin intereses — dedicated “Planes con fin” section on **Resumen** for this month’s MSI cuotas (fixed total, start and end).
6. Gastos fijos — indefinite recurring services/subscriptions, kept separate from MSI.
7. Fechas de corte — month calendar on **Resumen** for up to three cards’ cut-off and payment days. Cycle reminders only; they do not affect remaining money.
8. Supporting detail and evidence.

### Patrimonio hierarchy

1. **Tienes** — total assets in MXN.
2. Account breakdown (Cajita Nu, Bitso, Interactive Brokers).
3. Daily history (canonical point per day; filter by selected account).
4. Holdings for the selected account’s latest snapshot.

Patrimonio is assets-only. Credit-card balances stay in the spend/cycle domain.

## Personality and voice

Olbia is precise, firm, useful, personal, and premium. It should create constructive pressure without shaming the user.

- Address the user directly: “Has gastado”, “Te quedan”, “Te faltarán”, “Tienes”.
- Explain consequences: “A este ritmo te faltarán $N”.
- Prefer short, factual sentences and concrete amounts.
- Surface uncertainty honestly: “Incluye $N por confirmar”, “Cajita sin actualizar hace N días”.
- Pair warnings with an investigative next step when one exists.
- Never celebrate spending, use streaks or badges, scold the user, or soften a negative projection with wellness language.
- Avoid institutional banking language such as “saldo contable” when plain language is clearer.

## Visual character

- Base palette: ivory background, charcoal surfaces, red for meaningful negative consequences.
- Let tension increase gradually; reserve full red for a genuinely negative projection or critical failure.
- Use sans serif for data and body copy, with a restrained serif for editorial headings.
- Make numeric precision the premium signal: clear hierarchy, tabular figures, deliberate alignment.
- Use moderately rounded surfaces and defined borders. Avoid pill-heavy, bubbly, playful UI.
- Avoid generic corporate-blue fintech styling, gamification, excessive gradients, and ornamental charts.
- Prefer numbers, percentages, comparisons, and concise status text over charts. Add a chart only when it communicates a relationship that the approved numeric hierarchy cannot. On Patrimonio, a minimal sparkline may support the daily history list; it must not replace the numeric list.

## Mobile-first behavior

Assume at least 95% of usage is mobile.

- Design and verify at a narrow mobile viewport before adapting to desktop.
- The primary state must be understandable in a few seconds without horizontal scrolling.
- Keep primary actions reachable and touch targets comfortable.
- Preserve the three-destination model: **Resumen** (month state), **Movimientos** (sortable raw list), **Patrimonio** (assets).
- Patrimonio keeps the month selector visible but disabled (no layout jump between tabs).
- Desktop should be a contained adaptation of the same experience, not a separate dashboard with extra density.

## Financial-state rules

- The calendar month is the reporting period for spend.
- Wealth snapshots use calendar days in `America/Chihuahua`.
- Each month requires its own editable income configuration.
- If income is missing or failed to load, say so prominently and do not present availability or projections as valid.
- Upcoming payments and committed MSI installments affect remaining money and the month-end projection.
- For MSI purchases, “Has gastado” counts only installments marked `spent` for that month. The full principal must not inflate the month total.
- In **Movimientos**, keep a simple sortable raw list. MSI purchases appear as normal rows with badge `MSI i/N` and sort/show by the selected month’s cuota (not the principal). Do not duplicate the Planes con fin block here.
- Show **Meses sin intereses / Planes con fin** only on **Resumen**, listing this month’s spent and committed cuotas with principal total and start–end range.
- Keep **Gastos fijos / Servicios y suscripciones** for indefinite recurring charges only. Do not mix MSI plans into that list.
- Show **Fechas de corte** on **Resumen** after gastos fijos and before push preferences. Card cut-off/payment days are durable profile data, not monthly plan amounts, and must not change “Te quedan”.
- A cuota is never in both committed and spent. Committed MSI rows appear in the Resumen MSI section, not mixed into gastos fijos.
- On statement import, when an MSI row includes `n/N` (and total when available), creating the plan — including Amex “MESES EN AUTOMÁTICO” labels — is preferred over discarding the cuota.
- Projection paces discretionary (non-MSI) spend only, then adds spent MSI cuotas and pending commitments.
- Purchases needing review remain in totals, with the uncertain amount disclosed.
- Rejected purchases do not count toward spending.
- Amex Gold purchases deferred via `MONTO A DIFERIR MESES EN AUTOMÁTICO` use status `deferred_msi`: visible in Movimientos as “Diferido a MSI”, excluded from Has gastado; only the MESES EN AUTOMÁTICO cuota counts.
- Preserve access to transaction provenance and original evidence.
- Cajita manual captures are immutable; same-day replacement keeps prior versions for audit only. Mark Cajita stale after 7 days without a capture.

## Review checklist

Before completing a UI change, verify:

- Does the monthly spending state still dominate on Resumen?
- Does Patrimonio keep a clear assets hierarchy without looking like a second dashboard of widgets?
- Is the consequence of the current spending pace clear?
- Are loading, missing-income, uncertain, empty, failure, stale-Cajita, and negative-projection states honest?
- Does the copy sound firm and useful without shame or cheerleading?
- Does the feature work at a mobile viewport first?
- Are monetary values aligned, correctly formatted, and based on persisted data?
- Does red retain its meaning instead of becoming decoration?
- Is evidence still reachable when the feature affects a financial event?
