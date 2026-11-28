import { readSpendingBudget, writeBudgetEntity, resolveSpendingBudget } from './budgets.js';
import { proposeBudget, monthKeyInZone, type SpendingBudget } from '@finance/domain';
import { randomUUID } from 'node:crypto';
import { financialGoalFacts, incomeOccurrences, proposeExpectedIncome, proposeFinancialGoal } from '@finance/domain';
import { readExpectedIncome, writeExpectedIncome, readFinancialGoal, writeFinancialGoal,
  insertFinancialOperation, appendFinancialReceipt, appendFixedExpenseVersion, readFinancialReceipt, type FinancialWriteOperation } from './financial-plans.js';
import type { SqlClient } from './projection.js';

/** Deployment-owned, fully rolled back by the caller. Never seed personal examples or persist test plans. */
export const smokeNativeFinancialPlans = async (client: SqlClient, owner: string): Promise<void> => {
  const now = new Date().toISOString(), incomeId = randomUUID();
  const budgetOwner = `${owner}:verification:${randomUUID()}`;
  const budget = proposeBudget({ action: 'set_override', month: monthKeyInZone(new Date(now)), totalMxnMinor: 101 }, null, randomUUID(), now) as SpendingBudget;
  await writeBudgetEntity(client, budgetOwner, null, budget);
  if ((await resolveSpendingBudget(client, budgetOwner, budget.effectiveMonth))?.totalMxnMinor !== 101 || await readSpendingBudget(client, owner, budget.id))
    throw new Error('Native budget ownership/read failed');
  const budgetOperation: FinancialWriteOperation = { operationId: randomUUID(), owner: budgetOwner, kind: 'budget', action: 'set_override',
    entityId: budget.id, createdAt: now, expiresAt: new Date(Date.parse(now) + 60000).toISOString(), status: 'pending', failureCode: null,
    before: null, after: JSON.parse(JSON.stringify(budget)), preview: {}, evidencePreconditions: {} };
  await insertFinancialOperation(client, budgetOperation);
  await appendFinancialReceipt(client, budgetOperation, { verified: true }, now);
  if (!(await readFinancialReceipt(client, budgetOwner, budgetOperation.operationId))?.verified) throw new Error('Native budget audit receipt failed');
  const fixed = { id: randomUUID(), effectiveMonth: budget.effectiveMonth, scope: 'recurring', status: 'active',
    name: 'SQL verification', amountMinor: 101, dueDay: 31 } as const;
  const fixedOperation: FinancialWriteOperation = { ...budgetOperation, entityId: fixed.id, operationId: randomUUID(),
    kind: 'fixed_expense', action: 'create', after: fixed };
  await insertFinancialOperation(client, fixedOperation);
  await appendFixedExpenseVersion(client, budgetOwner, fixedOperation.operationId, fixed);
  await appendFinancialReceipt(client, fixedOperation, { verified: true }, now);
  if (!(await readFinancialReceipt(client, budgetOwner, fixedOperation.operationId))?.verified)
    throw new Error('Native fixed expense version and receipt failed');
  const income = proposeExpectedIncome({ action: 'create', name: 'SQL verification', amountMxnMinor: 101,
    frequency: 'semimonthly', paymentDays: [15, 31], startDate: '2026-01-01', confidence: 'estimated' }, null, incomeId, now);
  await writeExpectedIncome(client, owner, null, income);
  if ((await readExpectedIncome(client, owner, incomeId))?.amountMxnMinor !== 101 || await readExpectedIncome(client, `${owner}-other`, incomeId))
    throw new Error('Native expected-income ownership/read failed');
  const adjusted = proposeExpectedIncome({ action: 'update', expectedRevision: 1, amountMxnMinor: 102,
    paymentRules: [{ kind: 'previous_business_day', day: 16 }, { kind: 'last_business_day' }],
    startDate: '2026-04-21' }, income, incomeId, now);
  await writeExpectedIncome(client, owner, income, adjusted);
  const read = await readExpectedIncome(client, owner, incomeId);
  const dates = read && incomeOccurrences(read, '2026-04', '2026-05', [], []);
  if (!dates || dates.length !== 3 || dates[0]?.scheduleBasis !== 'partial_month_unknown' ||
    dates[0]?.amountMxnMinor !== null || dates[1]?.paymentDate !== '2026-05-15' ||
    dates[2]?.paymentDate !== '2026-05-29' || dates[2]?.amountMxnMinor !== 102)
    throw new Error('Native business-day income schedule failed');
  const exception = proposeExpectedIncome({ action: 'update', expectedRevision: 2, monthOverride: {
    month: '2026-04', paymentDate: '2026-04-29', amountMxnMinor: 37, reason: 'SQL verification',
  } }, read, incomeId, now);
  await writeExpectedIncome(client, owner, read, exception);
  const overridden = await readExpectedIncome(client, owner, incomeId);
  const actualOverride = overridden && incomeOccurrences(overridden, '2026-04', '2026-04', [], []);
  if (!actualOverride || actualOverride.length !== 1 || actualOverride[0]?.paymentDate !== '2026-04-29' ||
    actualOverride[0]?.amountMxnMinor !== 37 || actualOverride[0]?.scheduleBasis !== 'month_override')
    throw new Error('Native monthly income override failed');
  const initial = proposeFinancialGoal({ action: 'create_goal', name: 'SQL verification', totalBudgetMxnMinor: 100,
    allocations: [{ name: 'SQL allocation', allocatedMxnMinor: 100 }] }, null, randomUUID, now, '2026-01-02');
  await writeFinancialGoal(client, owner, null, initial);
  const paid = proposeFinancialGoal({ action: 'record_payment', expectedRevision: 1,
    allocationId: initial.allocations[0].id, expectedAllocationRevision: 1,
    payment: { source: 'manual_attestation', paymentDate: '2026-01-01', amountMxnMinor: 40 } }, initial, randomUUID, now, '2026-01-02');
  await writeFinancialGoal(client, owner, initial, paid);
  const fresh = await readFinancialGoal(client, owner, initial.goal.id);
  if (!fresh || financialGoalFacts(fresh).remainingMxnMinor !== 60 || await readFinancialGoal(client, `${owner}-other`, initial.goal.id))
    throw new Error('Native goal accounting/ownership failed');
  const corrected = proposeFinancialGoal({ action: 'correct_payment', expectedRevision: 2,
    paymentId: paid.payments[0].id, expectedPaymentRevision: 1, expectedAllocationRevision: 1,
    reason: 'SQL verification', payment: { amountMxnMinor: 30 } }, paid, randomUUID, now, '2026-01-02');
  await writeFinancialGoal(client, owner, paid, corrected);
  if (financialGoalFacts((await readFinancialGoal(client, owner, initial.goal.id))!).remainingMxnMinor !== 70)
    throw new Error('Native payment correction failed');
  const operation: FinancialWriteOperation = { operationId: randomUUID(), owner, kind: 'goal', action: 'correct_payment',
    entityId: corrected.goal.id, createdAt: now, expiresAt: new Date(Date.parse(now) + 60000).toISOString(), status: 'pending', failureCode: null,
    before: JSON.parse(JSON.stringify(paid)), after: JSON.parse(JSON.stringify(corrected)), preview: {}, evidencePreconditions: {} };
  await insertFinancialOperation(client, operation);
  await appendFinancialReceipt(client, operation, { verified: true }, now);
  if (!(await readFinancialReceipt(client, owner, operation.operationId))?.verified) throw new Error('Native financial audit receipt failed');
};
