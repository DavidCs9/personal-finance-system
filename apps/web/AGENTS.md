# Olbia UI personality

These instructions apply to every change under `apps/web`. Treat them as product constraints, not optional visual preferences. The broader rationale lives in [`../../docs/ui-design-brief.md`](../../docs/ui-design-brief.md).

## Product promise

Olbia has two primary financial answers, on separate tabs:

- **Resumen:** how much have I spent this month, and what does that mean for the rest of the month?
- **Patrimonio:** what is my net worth today (assets − card balances), and how has that changed?

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

1. **Neto** — assets minus card outstanding balances in MXN (hero on the total view).
2. Account breakdown (Cajita Nu, Fondo de ahorro, Bitso, Interactive Brokers).
3. **Debes** — outstanding balances for up to three cards (manual capture; includes MSI).
4. Daily history (canonical point per day; net on the total view; filter by selected asset account).
5. Holdings for the selected account’s latest snapshot.

Card cycle profiles (cut-off / payment days) stay on Resumen. Outstanding balances are captured on Patrimonio and subtract from Neto.

## Personality and voice

Olbia is precise, firm, useful, personal, and premium. It should create constructive pressure without shaming the user.

- Address the user directly: “Has gastado”, “Te quedan”, “Te faltarán”, “Neto”, “Debes”.
- Explain consequences: “A este ritmo te faltarán $N”.
- Prefer short, factual sentences and concrete amounts.
- Surface uncertainty honestly: “Incluye $N por confirmar”, “Cajita sin actualizar hace N días”, “Tarjeta sin actualizar hace N días”.
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
- Preserve the three-destination model: **Resumen** (month state), **Movimientos** (sortable raw list), **Patrimonio** (net worth).
- The **assistant** is a global sheet opened from the topbar (not a fourth tab). Its visible thread clears when the sheet closes or the month changes, while durable conversational memory remains user-scoped, visible, and deletable inside the sheet. It must never change ledger data or financial calculations. Ground answers in tool results; show citation chips. Private mode blurs amounts in the sheet too. See [`../../docs/ai-assistant.md`](../../docs/ai-assistant.md).
- Patrimonio keeps the month selector enabled so you can change period without leaving the tab (Patrimonio totals themselves stay current, not month-scoped).
- Desktop should be a contained adaptation of the same experience, not a separate dashboard with extra density.

## Financial-state rules

- The calendar month is the reporting period for spend.
- Wealth snapshots use calendar days in `America/Chihuahua`.
- Each month’s liquidez comes from uploaded CFDI nómina XMLs (net `Total` by `FechaPago`). With one ordinary payslip in the current month, Resumen estimates the second quincena; the estimate clears when a second ordinary arrives or the calendar month closes.
- In the current month with zero payslips yet, use provisional liquidez from the last 1–2 ordinary payslips (2× last, or sum of the two newest) so Resumen stays usable; label it provisional and prompt for this month’s XML. Past months without payslips stay unconfigured.
- Tapping **Liquidez** opens **Nómina del mes**: liquidez (payslip nets + estimate/provisional) plus **Compensación del mes** (liquidez + fondo SAT `004`, with twin fondo when the 2ª quincena estimate is active). Opening a payslip shows liquidez, fondo retenido, ISR, and IMSS first; full CFDI lines stay behind an expand control. Resumen % and Te quedan stay anchored to liquidez only.
- If liquidez is missing or failed to load (no payslips and no prior ordinary pattern), say so prominently and do not present availability or projections as valid. Prompt to upload the nómina XML instead of typing a manual total.
- Upcoming payments and committed MSI installments affect remaining money and the month-end projection.
- For MSI purchases, “Has gastado” counts only installments marked `spent` for that month. The full principal must not inflate the month total.
- In **Movimientos**, keep a simple sortable raw list. MSI purchases appear as normal rows with badge `MSI i/N` and sort/show by the selected month’s cuota (not the principal). Show a category badge; edit category in the event sheet (updates the event and, when confirmed, the merchant→category rule). Do not duplicate the Planes con fin block here.
- Spend-by-category answers use the same “Has gastado” semantics as Resumen (MSI cuota of the month, not full ticket). `categoryId` null/absent means Sin categoría; disclose uncategorized amounts when answering.
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
- Card liability captures are immutable the same way; `amountMinor` may be 0 (paid off). Mark each card stale after 7 days without a capture. Capture the total outstanding balance (includes MSI).
- Bitso syncs via API (scheduled and “Actualizar”); on failure keep the last good snapshot and surface the error honestly.
- IBKR syncs via Flex Query + Banxico FIX; on failure keep the last good snapshot and surface the error honestly.
- Fondo de ahorro is a derived Patrimonio account: calendar-year sum of CFDI nómina deducciones SAT `004` (employee + employer portions into the fund). It counts fully in assets with an illiquid-until-December label. Do not invent a liquidation reset until a clear December XML fixture exists.
- Patrimonio total history is a **monthly** net trend from `2026-08` onward (not daily). Per-account history can stay day-grained.

## Review checklist

Before completing a UI change, verify:

- Does the monthly spending state still dominate on Resumen?
- Does Patrimonio keep a clear Neto → assets → Debes hierarchy without looking like a second dashboard of widgets?
- Is the consequence of the current spending pace clear?
- Are loading, missing-income, uncertain, empty, failure, stale-Cajita, stale-card-debt, and negative-projection states honest?
- Does the copy sound firm and useful without shame or cheerleading?
- Does the feature work at a mobile viewport first?
- Are monetary values aligned, correctly formatted, and based on persisted data?
- Does red retain its meaning instead of becoming decoration?
- Is evidence still reachable when the feature affects a financial event?
