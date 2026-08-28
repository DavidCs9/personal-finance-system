# Analytics product goal

## Goal

Turn movement categories, merchants, and tags into a clear explanation of spending:

> What changed, why did it change, and is it likely to continue?

Analytics should help the user act before the month closes. It should deepen **Resumen** and **Movimientos**, not become a fourth navigation tab or a generic collection of charts.

## Questions to answer

1. Where did my money go?
2. Why am I spending more or less than before?
3. Which expenses were contextual or exceptional rather than normal?

## Meaning of the data

- **Categories** describe what kind of expense a movement is. They are mutually exclusive, so their amounts can add up to **Has gastado**.
- **Merchants** show where the money was spent and provide the evidence behind a category.
- **Tags** describe context, purpose, or ownership, such as `viaje:cdmx`, `trabajo`, `compartido`, or `extraordinario`. Tags may overlap, so tag totals must be presented as lenses and must never be added together as a breakdown of total spending.

## First experience

Add a compact **En qué se fue** section to the supporting detail of **Resumen**, after its MSI, fixed-expense, and card-cycle hierarchy, with a **Ver análisis** action for deeper exploration. The analysis should remain mobile-first and use ranked numeric rows before charts.

The first version should include:

1. **Headline** — total spent and the difference against the equivalent elapsed period of the previous month.
2. **Category breakdown** — amount, percentage, and change for each category.
3. **What changed** — the categories, merchants, or movements that explain the difference.
4. **Tag lenses** — amount and movement count for each context, with an explicit warning that contexts may overlap.
5. **Top merchants** — ranked within the selected month or category.
6. **Data confidence** — uncategorized and unconfirmed amounts, with a path to review the affected movements.

Tapping any category, merchant, tag, or confidence issue should open the matching evidence in **Movimientos**.

## Financial semantics

Every analytics amount must use the same rules as **Has gastado**:

- Count only the month's spent MSI installment, not the full purchase principal.
- Use **Mi parte** when present.
- Include movements needing review and disclose their uncertain amount.
- Exclude rejected movements, deferred-MSI purchases, and foreign authorizations awaiting a posted MXN charge.
- Keep uncategorized spending visible rather than silently grouping it into another category.

For the current month, comparisons use the same number of elapsed calendar days in the comparison month. Completed months may be compared as full months.

If a legacy MSI installment has no confirmed calendar day, exclude it from an elapsed-day comparison and disclose the omitted amount instead of inventing a date.

## Not in the first version

- Category budgets or goals.
- Automated anomaly detection.
- Category-level forecasting.
- A dense desktop-only dashboard.
- Decorative pie charts or charts that replace precise amounts.

## Success criteria

Within a few seconds, the user can identify the largest area of spending, understand the main reason spending changed, and reach the movements that support the explanation.
