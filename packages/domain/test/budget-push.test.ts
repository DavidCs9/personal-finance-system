import { expect, it } from 'vitest';
import { budgetPushAlerts, budgetPushMessage } from '../src/budget-push.js';
import { BUDGET_EXCLUSION_TAG, computeBudgetStatus, type SpendingBudget } from '../src/budgets.js';

const month = '2030-04';
const now = new Date('2030-04-12T18:00:00Z');
const budget: SpendingBudget = {
  id: 'fictional-budget', entityType: 'budget', scope: 'recurring', effectiveMonth: month, totalMxnMinor: 10000,
  allocations: [{ categoryId: 'food', amountMxnMinor: 6000 }], status: 'active', revision: 1,
  createdAt: now.toISOString(), updatedAt: now.toISOString(),
};
const purchase = { id: 'fictional-movement', amountMinor: 5600, currency: 'MXN', categoryId: 'food',
  status: 'accepted', receivedAt: now.toISOString() };
const alertsFrom = (input: Partial<Parameters<typeof computeBudgetStatus>[0]>) => {
  const status = computeBudgetStatus({ month, now, budget, events: [], fixedPayments: [], exclusions: [], ...input });
  return budgetPushAlerts({ ...status, categories: status.categories.map(row => ({ ...row, label: 'Despensa' })) });
};

it('uses shared counted spend and known commitments, with a separate threshold for allocated categories', () => {
  const alerts = alertsFrom({
    events: [purchase, { ...purchase, id: 'extra', amountMinor: 10000, categoryId: 'travel', tags: [BUDGET_EXCLUSION_TAG] },
      { ...purchase, id: 'unallocated', amountMinor: 1400, categoryId: 'other' }],
    fixedPayments: [{ id: 'pending', amountMinor: 2300 },
      { id: 'linked', amountMinor: 5600, reconciliation: { valid: true, eventId: purchase.id } }],
  });
  expect(alerts).toEqual([
    { scope: 'total', label: 'Presupuesto mensual', threshold: 90, marginMinor: 700, includesCommitments: true },
    { scope: 'category:food', label: 'Despensa', threshold: 90, marginMinor: 400, includesCommitments: false },
  ]);
  expect(budgetPushMessage(month, alerts, 'amounts', '/').body)
    .toBe('Presupuesto mensual alcanzó el 90% con los compromisos conocidos. Despensa alcanzó el 90%.');
  expect(budgetPushMessage(month, alerts, 'private', '/')).toEqual({
    title: 'Olbia', body: 'Hay avisos de presupuesto en tu Resumen.', tag: 'budget-2030-04', navigate: '/',
  });
});

it('ignores missing and unused zero budgets, and alerts for spend against an explicit zero limit', () => {
  const zero = { ...budget, totalMxnMinor: 0, allocations: [{ categoryId: 'food', amountMxnMinor: 0 }] };
  expect(alertsFrom({ budget: null, events: [purchase] })).toEqual([]);
  expect(alertsFrom({ budget: zero })).toEqual([]);
  expect(alertsFrom({ budget: zero, events: [purchase] })).toMatchObject([
    { scope: 'total', threshold: 100, marginMinor: -5600 },
    { scope: 'category:food', threshold: 100, marginMinor: -5600 },
  ]);
});
