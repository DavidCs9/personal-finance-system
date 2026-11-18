import { randomUUID } from 'node:crypto';
import { financialGoalFacts, proposeExpectedIncome, proposeFinancialGoal } from '@finance/domain';
import { readExpectedIncome, writeExpectedIncome, readFinancialGoal, writeFinancialGoal,
  insertFinancialOperation, appendFinancialReceipt, readFinancialReceipt, type FinancialWriteOperation } from './financial-plans.js';
import type { SqlClient } from './projection.js';

/** Deployment-owned, fully rolled back by the caller. Never seed personal examples or persist test plans. */
export const smokeNativeFinancialPlans = async (client: SqlClient, owner: string): Promise<void> => {
  const now = new Date().toISOString(), incomeId = randomUUID();
  const income = proposeExpectedIncome({ action: 'create', name: 'SQL verification', amountMxnMinor: 101,
    frequency: 'semimonthly', paymentDays: [15, 31], startDate: '2026-01-01', confidence: 'estimated' }, null, incomeId, now);
  await writeExpectedIncome(client, owner, null, income);
  if ((await readExpectedIncome(client, owner, incomeId))?.amountMxnMinor !== 101 || await readExpectedIncome(client, `${owner}-other`, incomeId))
    throw new Error('Native expected-income ownership/read failed');
  const updated = proposeExpectedIncome({ action: 'update', expectedRevision: 1, amountMxnMinor: 102 }, income, incomeId, now);
  await writeExpectedIncome(client, owner, income, updated);
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
