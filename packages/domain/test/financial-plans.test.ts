import { beforeEach, describe, expect, it } from 'vitest';
import { financialDay, financialGoalFacts, incomeOccurrences, proposeExpectedIncome, proposeFinancialGoal, FinancialPlanError,
  type ExpectedIncome, type FinancialGoalState } from '../src/financial-plans.js';
const at = '2026-11-17T18:00:00.000Z';
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
beforeEach(() => { seq = 0; });
const salary = (changes: Record<string, unknown> = {}) => proposeExpectedIncome({ action: 'create', name: 'Net salary', employer: 'Employer',
  amountMxnMinor: 69228_00, frequency: 'monthly', paymentDays: [31], startDate: '2026-11-23', confidence: 'estimated', ...changes }, null, id(), at);
const wedding = (): FinancialGoalState => proposeFinancialGoal({ action: 'create_goal', name: 'Personal wedding commitment', totalBudgetMxnMinor: 400000_00,
  allocations: [{ name: 'Wedding planner', allocatedMxnMinor: 65000_00 }, { name: 'Remaining contribution', allocatedMxnMinor: 85000_00 },
    { name: 'Honeymoon', allocatedMxnMinor: 200000_00 }, { name: 'Dress', allocatedMxnMinor: 50000_00 }] }, null, id, at, '2026-11-17');
const pay = (state: FinancialGoalState, amount = 65000_00) => proposeFinancialGoal({ action: 'record_payment', expectedRevision: state.goal.revision,
  allocationId: state.allocations[0]!.id, expectedAllocationRevision: state.allocations[0]!.revision,
  payment: { source: 'manual_attestation', amountMxnMinor: amount, paymentDate: '2026-11-17' } }, state, id, at, '2026-11-17');

describe('expected income contracts', () => {
  it('generates explicit full occurrences, clamps short months and never prorates a partial first month', () => {
    const source = salary();
    expect(incomeOccurrences(source, '2026-11', '2027-02', [], []).map(row => [row.paymentDate, row.amountMxnMinor]))
      .toEqual([['2026-11-30', 69228_00], ['2026-12-31', 69228_00], ['2027-01-31', 69228_00], ['2027-02-28', 69228_00]]);
  });
  it('keeps both distinct configured semimonthly occurrences even when short-month clamping gives the same date', () => {
    const source = salary({ frequency: 'semimonthly', paymentDays: [30, 31], amountMxnMinor: 34614_00 });
    const rows = incomeOccurrences(source, '2027-02', '2027-02', [], []);
    expect(rows.map(row => row.paymentDate)).toEqual(['2027-02-28', '2027-02-28']);
    expect(new Set(rows.map(row => row.occurrenceId)).size).toBe(2);
  });
  it('requires explicit schedules and exact one-time dates rather than assuming employer paydays', () => {
    for (const input of [{ paymentDays: undefined }, { frequency: 'semimonthly', paymentDays: [15, 15] },
      { frequency: 'one_time', expectedPaymentDate: undefined }, { paymentDays: [32] }]) expect(() => salary(input)).toThrow(FinancialPlanError);
    const source = salary({ frequency: 'one_time', expectedPaymentDate: '2026-12-15', confidence: 'confirmed' });
    expect(incomeOccurrences(source, '2026-11', '2027-02', [], [])).toMatchObject([{ paymentDate: '2026-12-15', confidence: 'confirmed', basis: 'configured_expectation_not_received_income' }]);
  });
  it('never treats same-employer/date/amount payroll as automatic reconciliation', () => {
    const source = salary();
    const actual = [{ id: id(), employer: 'EMPLOYER', paymentDate: '2026-11-30', payrollType: 'O', netMxnMinor: source.amountMxnMinor }];
    expect(incomeOccurrences(source, '2026-11', '2026-12', actual, []).map(row => row.reconciliationStatus))
      .toEqual(['possible_payroll_overlap', 'unreconciled']);
    expect(incomeOccurrences(source, '2026-11', '2026-11', [{ ...actual[0]!, employer: null }], [])[0]?.reconciliationStatus).toBe('possible_payroll_overlap');
  });
  it('respects explicit employment terminations, archival, revision conflicts and restores without altering actual payroll', () => {
    const source = salary();
    const actual = [{ id: id(), employer: 'Employer', paymentDate: '2026-11-15', payrollType: 'O', netMxnMinor: 12345 }];
    const original = structuredClone(actual);
    expect(incomeOccurrences(source, '2026-11', '2027-02', actual, [{ employer: 'Employer', endedOn: '2026-12-01' }])).toHaveLength(1);
    const archived = proposeExpectedIncome({ action: 'archive', expectedRevision: 1 }, source, id(), at);
    expect(incomeOccurrences(archived, '2026-11', '2027-02', [], [])).toEqual([]);
    expect(proposeExpectedIncome({ action: 'restore', expectedRevision: 2 }, archived, id(), at)).toMatchObject({ status: 'active', revision: 3 });
    expect(() => proposeExpectedIncome({ action: 'update', expectedRevision: 0, amountMxnMinor: 1 }, source, id(), at)).toThrow(/revisión/);
    expect(actual).toEqual(original);
  });
  it('updates net amounts and schedule with explicit revision while preserving source identity', () => {
    const before = salary();
    const after = proposeExpectedIncome({ action: 'update', expectedRevision: 1, amountMxnMinor: 70000_00, frequency: 'semimonthly', paymentDays: [15, 30] }, before, id(), at);
    expect(after).toMatchObject({ id: before.id, amountMxnMinor: 70000_00, paymentDays: [15, 30], revision: 2 });
    expect(before.amountMxnMinor).toBe(69228_00);
  });
  it.each(['2027-02-29', '2026-13-01', '2026-00-01', '2026-11-31'])('rejects impossible calendar day %s', value => {
    expect(() => financialDay(value)).toThrow(FinancialPlanError);
  });
});

describe('financial goal accounting', () => {
  it('creates all wedding allocations atomically and records the 65,000 payment inside the original 400,000 commitment', () => {
    const before = wedding();
    expect(financialGoalFacts(before)).toMatchObject({ originalBudgetMxnMinor: 400000_00, allocatedMxnMinor: 400000_00,
      paidMxnMinor: 0, remainingMxnMinor: 400000_00, unallocatedMxnMinor: 0 });
    const after = financialGoalFacts(pay(before));
    expect(after).toMatchObject({ totalBudgetMxnMinor: 400000_00, allocatedMxnMinor: 400000_00, paidMxnMinor: 65000_00, remainingMxnMinor: 335000_00,
      allocations: [{ paymentStatus: 'fully_paid', remainingMxnMinor: 0 }, {}, {}, {}] });
  });
  it('supports partial payments, rejects overpayment and preserves unallocated budget', () => {
    const state = wedding();
    expect(financialGoalFacts(pay(state, 10000_00))).toMatchObject({ paidMxnMinor: 10000_00, remainingMxnMinor: 390000_00,
      allocations: [{ paymentStatus: 'partially_paid', remainingMxnMinor: 55000_00 }, {}, {}, {}] });
    expect(() => pay(state, 65000_01)).toThrow(/excede/);
    const simple = proposeFinancialGoal({ action: 'create_goal', name: 'Goal', totalBudgetMxnMinor: 10000, allocations: [{ name: 'Part', allocatedMxnMinor: 4000 }] }, null, id, at, '2026-11-17');
    expect(financialGoalFacts(simple)).toMatchObject({ unallocatedMxnMinor: 6000, remainingMxnMinor: 10000, outstandingAllocatedMxnMinor: 4000 });
  });
  it('requires an explicit budget amendment for more allocations and supports atomic transfers', () => {
    const before = wedding();
    expect(() => proposeFinancialGoal({ action: 'add_allocation', expectedRevision: 1, allocation: { name: 'Extra', allocatedMxnMinor: 1 } }, before, id, at, '2026-11-17')).toThrow(/presupuesto/);
    const after = proposeFinancialGoal({ action: 'update_goal', expectedRevision: 1, allocations: [
      { allocationId: before.allocations[1]!.id, expectedAllocationRevision: 1, allocatedMxnMinor: 75000_00 },
      { allocationId: before.allocations[2]!.id, expectedAllocationRevision: 1, allocatedMxnMinor: 210000_00, expectedPaymentDate: '2027-03-10' },
    ] }, before, id, at, '2026-11-17');
    expect(financialGoalFacts(after).allocatedMxnMinor).toBe(400000_00);
    const amended = proposeFinancialGoal({ action: 'update_goal', expectedRevision: 2, totalBudgetMxnMinor: 410000_00 }, after, id, at, '2026-11-17');
    expect(financialGoalFacts(amended)).toMatchObject({ originalBudgetMxnMinor: 400000_00, totalBudgetMxnMinor: 410000_00, unallocatedMxnMinor: 10000_00 });
  });
  it('corrects and voids explicitly without changing the original snapshot or manufacturing a ledger movement', () => {
    const state = pay(wedding());
    const payment = state.payments[0]!;
    const corrected = proposeFinancialGoal({ action: 'correct_payment', expectedRevision: 2, paymentId: payment.id, expectedPaymentRevision: 1,
      expectedAllocationRevision: 1, reason: 'Correct amount', payment: { amountMxnMinor: 60000_00 } }, state, id, at, '2026-11-17');
    expect(financialGoalFacts(corrected).paidMxnMinor).toBe(60000_00);
    expect(payment.amountMxnMinor).toBe(65000_00);
    expect(corrected.payments[0]).toMatchObject({ id: payment.id, revision: 2, ledgerMovementId: null });
    const voided = proposeFinancialGoal({ action: 'void_payment', expectedRevision: 3, paymentId: payment.id, expectedPaymentRevision: 2, reason: 'Was not a payment' }, corrected, id, at, '2026-11-17');
    expect(financialGoalFacts(voided)).toMatchObject({ paidMxnMinor: 0, remainingMxnMinor: 400000_00 });
    expect(voided.payments[0]).toMatchObject({ id: payment.id, status: 'voided', revision: 3 });
  });
  it('preserves financial assertions when archiving goals or allocations', () => {
    const before = pay(wedding());
    const archived = proposeFinancialGoal({ action: 'archive_goal', expectedRevision: 2 }, before, id, at, '2026-11-17');
    expect(financialGoalFacts(archived)).toMatchObject({ status: 'archived', paidMxnMinor: 65000_00, remainingMxnMinor: 335000_00 });
    const allocation = proposeFinancialGoal({ action: 'archive_allocation', expectedRevision: 2, allocationId: before.allocations[0]!.id,
      expectedAllocationRevision: 1 }, before, id, at, '2026-11-17');
    expect(financialGoalFacts(allocation)).toMatchObject({ paidMxnMinor: 65000_00, allocatedMxnMinor: 400000_00 });
  });
  it('rejects payment dates in the future, invalid revisions and unsafe monetary amounts', () => {
    const state = wedding();
    expect(() => proposeFinancialGoal({ action: 'record_payment', expectedRevision: 1, allocationId: state.allocations[0]!.id, expectedAllocationRevision: 1,
      payment: { amountMxnMinor: 1, source: 'manual_attestation', paymentDate: '2026-11-18' } }, state, id, at, '2026-11-17')).toThrow(/futura/);
    expect(() => proposeFinancialGoal({ action: 'archive_goal', expectedRevision: 0 }, state, id, at, '2026-11-17')).toThrow(/revisión/);
    expect(() => salary({ amountMxnMinor: 1.2 })).toThrow(/centavos/);
    expect(() => salary({ amountMxnMinor: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/centavos/);
  });
});

it('can transfer a full allocation down to zero without calling it paid or changing the total budget', () => {
  const before = wedding();
  const next = proposeFinancialGoal({ action: 'update_goal', expectedRevision: 1, allocations: [
    { allocationId: before.allocations[0].id, expectedAllocationRevision: 1, allocatedMxnMinor: 0 },
    { allocationId: before.allocations[1].id, expectedAllocationRevision: 1, allocatedMxnMinor: 150000_00 },
  ] }, before, id, at, '2026-11-17');
  expect(financialGoalFacts(next)).toMatchObject({ allocatedMxnMinor: 400000_00,
    allocations: [{ allocatedMxnMinor: 0, paidMxnMinor: 0, paymentStatus: 'no_recorded_payment' }, {}, {}, {}] });
});
