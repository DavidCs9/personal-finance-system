import { addCalendarMonths } from './msi.js';
import { clampDayInMonth } from './card-cycle.js';
import { payrollEmployerKey } from './payroll.js';

export class FinancialPlanError extends Error {
  constructor(message: string, readonly reasonCode: 'invalid_request' | 'conflict' | 'not_found' | 'expired' = 'invalid_request') {
    super(message);
  }
}
export const financialObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinancialPlanError('Se requiere un objeto.');
  return value as Record<string, unknown>;
};
export const financialId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new FinancialPlanError('Usa el identificador UUID exacto de la lectura o preview.');
  return value.toLowerCase();
};
export const financialText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new FinancialPlanError(`${field} es obligatorio (1–200 caracteres).`);
  return value.trim();
};
export const financialMinor = (value: unknown, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw new FinancialPlanError('Importe inválido: usa centavos MXN enteros seguros.');
  return Number(value);
};
export const financialSum = (values: readonly number[]): number => {
  const total = values.reduce((sum, value) => sum + BigInt(financialMinor(value, true)), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new FinancialPlanError('El total excede la precisión monetaria soportada.');
  return Number(total);
};
export const financialDay = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(value)
    || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new FinancialPlanError('Fecha inválida: usa YYYY-MM-DD.');
  return value;
};
export const financialRevision = (value: unknown, current: number): void => {
  if (!Number.isSafeInteger(value) || Number(value) !== current) throw new FinancialPlanError('La revisión cambió o falta. Vuelve a consultar y crea otro preview.', 'conflict');
};
const oneOf = <T extends string>(value: unknown, choices: readonly T[], field: string): T => {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new FinancialPlanError(`${field} inválido.`);
  return value as T;
};
const nullableDay = (value: unknown) => value === null || value === undefined ? null : financialDay(value);

export interface ExpectedIncome {
  readonly id: string;
  readonly name: string;
  readonly employer: string | null;
  readonly amountMxnMinor: number;
  readonly frequency: 'monthly' | 'semimonthly' | 'one_time';
  readonly paymentDays: readonly number[];
  readonly expectedPaymentDate: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly confidence: 'estimated' | 'confirmed';
  readonly status: 'active' | 'archived';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface IncomeOccurrence {
  readonly incomeId: string;
  readonly occurrenceId: string;
  readonly name: string;
  readonly employer: string | null;
  readonly paymentDate: string;
  readonly amountMxnMinor: number;
  readonly confidence: ExpectedIncome['confidence'];
  readonly basis: 'configured_expectation_not_received_income';
  readonly reconciliationStatus: 'unreconciled' | 'possible_payroll_overlap';
}
export interface ActualIncomeReceipt {
  readonly id: string;
  readonly employer: string | null;
  readonly paymentDate: string;
  readonly payrollType: string;
  readonly netMxnMinor: number;
}
export interface IncomeTermination { readonly employer: string; readonly endedOn: string }
export const proposeExpectedIncome = (input: Record<string, unknown>, before: ExpectedIncome | null,
  newId: string, at: string): ExpectedIncome => {
  const action = oneOf(input.action, ['create', 'update', 'archive', 'restore'] as const, 'action');
  if (action === 'create' ? before !== null : before === null) throw new FinancialPlanError('Ingreso no encontrado o ID ocupado.', 'not_found');
  if (before) financialRevision(input.expectedRevision, before.revision);
  if (action === 'archive' || action === 'restore') {
    if (!before || before.status === (action === 'archive' ? 'archived' : 'active')) throw new FinancialPlanError('El ingreso ya tiene ese estado.');
    return { ...before, status: action === 'archive' ? 'archived' : 'active', revision: before.revision + 1, updatedAt: at };
  }
  if (before?.status === 'archived') throw new FinancialPlanError('Restaura el ingreso antes de modificarlo.');
  if (input.clearEndDate === true && input.endDate != null) throw new FinancialPlanError('No combines endDate con clearEndDate.');
  const merged = { ...before, ...input, ...(input.clearEndDate === true ? { endDate: null } : {}), ...(input.clearEmployer === true ? { employer: null } : {}) };
  const frequency = oneOf(merged.frequency, ['monthly', 'semimonthly', 'one_time'] as const, 'frequency');
  // Changing frequency never silently reuses an incompatible old schedule.
  if (before && before.frequency !== frequency && input.paymentDays === undefined && input.expectedPaymentDate === undefined)
    throw new FinancialPlanError('Configura explícitamente el nuevo calendario.');
  const days = frequency === 'one_time' ? [] : merged.paymentDays;
  if (!Array.isArray(days) || days.length !== (frequency === 'monthly' ? 1 : frequency === 'semimonthly' ? 2 : 0)
    || days.some(day => !Number.isInteger(day) || day < 1 || day > 31) || new Set(days).size !== days.length)
    throw new FinancialPlanError('Configura un día mensual o dos días quincenales distintos (1–31). No se infieren días de pago.');
  const startDate = financialDay(merged.startDate);
  const endDate = nullableDay(merged.endDate);
  const expectedPaymentDate = frequency === 'one_time' ? financialDay(merged.expectedPaymentDate) : null;
  if (endDate && endDate < startDate || expectedPaymentDate && (expectedPaymentDate < startDate || endDate && expectedPaymentDate > endDate))
    throw new FinancialPlanError('Las fechas del ingreso no corresponden a su vigencia.');
  return { id: before?.id ?? newId, name: financialText(merged.name, 'name'),
    employer: merged.employer === undefined || merged.employer === null ? null : financialText(merged.employer, 'employer'),
    amountMxnMinor: financialMinor(merged.amountMxnMinor), frequency, paymentDays: [...days].sort((a, b) => a - b),
    expectedPaymentDate, startDate, endDate, confidence: oneOf(merged.confidence, ['estimated', 'confirmed'] as const, 'confidence'),
    status: 'active', revision: (before?.revision ?? 0) + 1, createdAt: before?.createdAt ?? at, updatedAt: at };
};

export const incomeOccurrences = (source: ExpectedIncome, fromMonth: string, toMonth: string,
  actual: readonly ActualIncomeReceipt[], terminations: readonly IncomeTermination[]): readonly IncomeOccurrence[] => {
  if (source.status !== 'active') return [];
  const employerKey = payrollEmployerKey(source.employer ?? undefined);
  const termination = employerKey ? terminations.filter(item => payrollEmployerKey(item.employer) === employerKey)
    .map(item => item.endedOn).sort()[0] : undefined;
  const result: IncomeOccurrence[] = [];
  for (let month = fromMonth, index = 0; month <= toMonth && index < 24; month = addCalendarMonths(month, 1), index++) {
    const dates = source.frequency === 'one_time'
      ? source.expectedPaymentDate?.slice(0, 7) === month ? [source.expectedPaymentDate] : []
      : source.paymentDays.map(day => `${month}-${String(clampDayInMonth(day, month)).padStart(2, '0')}`);
    dates.forEach((paymentDate, slot) => {
      if (paymentDate < source.startDate || source.endDate && paymentDate > source.endDate || termination && paymentDate > termination) return;
      const overlap = actual.some(receipt => receipt.paymentDate.slice(0, 7) === month
        && (!employerKey || !payrollEmployerKey(receipt.employer ?? undefined) || payrollEmployerKey(receipt.employer ?? undefined) === employerKey));
      result.push({ incomeId: source.id, occurrenceId: `${source.id}:${month}:${slot + 1}`, name: source.name,
        employer: source.employer, paymentDate, amountMxnMinor: source.amountMxnMinor, confidence: source.confidence,
        basis: 'configured_expectation_not_received_income', reconciliationStatus: overlap ? 'possible_payroll_overlap' : 'unreconciled' });
    });
  }
  return result;
};

export interface FinancialGoal {
  readonly id: string;
  readonly name: string;
  readonly originalBudgetMxnMinor: number;
  readonly totalBudgetMxnMinor: number;
  readonly targetDate: string | null;
  readonly status: 'planned' | 'active' | 'completed' | 'archived';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface GoalAllocation {
  readonly id: string;
  readonly goalId: string;
  readonly name: string;
  readonly allocatedMxnMinor: number;
  readonly expectedPaymentDate: string | null;
  readonly status: 'active' | 'archived';
  readonly revision: number;
}
export interface GoalPayment {
  readonly id: string;
  readonly allocationId: string;
  readonly amountMxnMinor: number;
  readonly paymentDate: string;
  readonly source: 'manual_attestation' | 'linked_ledger_movement';
  readonly ledgerMovementId: string | null;
  readonly status: 'active' | 'voided';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface FinancialGoalState { readonly goal: FinancialGoal; readonly allocations: readonly GoalAllocation[]; readonly payments: readonly GoalPayment[] }
export const financialGoalFacts = (state: FinancialGoalState) => {
  const allocatedMxnMinor = financialSum(state.allocations.map(item => item.allocatedMxnMinor));
  const paidMxnMinor = financialSum(state.payments.filter(payment => payment.status === 'active').map(payment => payment.amountMxnMinor));
  if (allocatedMxnMinor > state.goal.totalBudgetMxnMinor) throw new FinancialPlanError('Las asignaciones exceden el presupuesto aprobado; modifica explícitamente el presupuesto.');
  const allocations = state.allocations.map(allocation => {
    const paid = financialSum(state.payments.filter(payment => payment.allocationId === allocation.id && payment.status === 'active').map(payment => payment.amountMxnMinor));
    if (paid > allocation.allocatedMxnMinor) throw new FinancialPlanError('El pago excede el importe pendiente de la asignación.');
    return { ...allocation, paidMxnMinor: paid, remainingMxnMinor: allocation.allocatedMxnMinor - paid,
      paymentStatus: allocation.allocatedMxnMinor > 0 && paid === allocation.allocatedMxnMinor ? 'fully_paid' : paid > 0 ? 'partially_paid' : 'no_recorded_payment' };
  });
  const activeLinks = state.payments.flatMap(payment => payment.ledgerMovementId ? [payment.ledgerMovementId] : []);
  if (new Set(activeLinks).size !== activeLinks.length) throw new FinancialPlanError('El movimiento ya tiene un pago; corrige el pago original.');
  return { ...state.goal, currency: 'MXN' as const, allocatedMxnMinor, paidMxnMinor,
    unallocatedMxnMinor: state.goal.totalBudgetMxnMinor - allocatedMxnMinor,
    remainingMxnMinor: state.goal.totalBudgetMxnMinor - paidMxnMinor,
    outstandingAllocatedMxnMinor: allocatedMxnMinor - paidMxnMinor,
    accountingBasis: 'recorded_goal_payments_not_additional_ledger_expenses',
    allocations, payments: state.payments };
};
export type FinancialGoalView = ReturnType<typeof financialGoalFacts>;

export const proposeFinancialGoal = (input: Record<string, unknown>, before: FinancialGoalState | null,
  makeId: () => string, at: string, today: string): FinancialGoalState => {
  const action = oneOf(input.action, ['create_goal', 'update_goal', 'archive_goal', 'add_allocation', 'update_allocation',
    'archive_allocation', 'record_payment', 'correct_payment', 'void_payment'] as const, 'action');
  if ((action === 'create_goal') !== (before === null)) throw new FinancialPlanError('Meta no encontrada o ID ocupado.', 'not_found');
  if (before) financialRevision(input.expectedRevision, before.goal.revision);
  let goal: FinancialGoal = before ? { ...before.goal, revision: before.goal.revision + 1, updatedAt: at }
    : { id: makeId(), name: financialText(input.name, 'name'), originalBudgetMxnMinor: financialMinor(input.totalBudgetMxnMinor),
      totalBudgetMxnMinor: financialMinor(input.totalBudgetMxnMinor), targetDate: nullableDay(input.targetDate),
      status: input.status === undefined ? 'planned' : oneOf(input.status, ['planned', 'active'] as const, 'status'), revision: 1, createdAt: at, updatedAt: at };
  let allocations = [...(before?.allocations ?? [])];
  let payments = [...(before?.payments ?? [])];
  if (before?.goal.status === 'archived' && !['update_goal', 'correct_payment', 'void_payment'].includes(action))
    throw new FinancialPlanError('La meta está archivada; restáurala con update_goal antes de continuar.');
  const newAllocation = (value: unknown): GoalAllocation => {
    const data = financialObject(value);
    return { id: makeId(), goalId: goal.id, name: financialText(data.name, 'allocation.name'),
      allocatedMxnMinor: financialMinor(data.allocatedMxnMinor, true), expectedPaymentDate: nullableDay(data.expectedPaymentDate), status: 'active', revision: 1 };
  };
  const updateAllocation = (value: unknown, archive = false) => {
    const data = financialObject(value);
    const id = financialId(data.allocationId);
    const previous = allocations.find(item => item.id === id);
    if (!previous) throw new FinancialPlanError('Asignación no encontrada en esta meta.', 'not_found');
    financialRevision(data.expectedAllocationRevision, previous.revision);
    const merged = { ...previous, ...data };
    allocations = allocations.map(item => item.id !== id ? item : { ...previous,
      name: financialText(merged.name, 'allocation.name'), allocatedMxnMinor: financialMinor(merged.allocatedMxnMinor, true),
      expectedPaymentDate: data.clearExpectedPaymentDate === true ? null : nullableDay(merged.expectedPaymentDate), status: archive ? 'archived' : previous.status, revision: previous.revision + 1 });
  };
  if (action === 'create_goal') {
    if (input.allocations !== undefined && !Array.isArray(input.allocations)) throw new FinancialPlanError('allocations debe ser una lista.');
    allocations = (input.allocations as unknown[] | undefined ?? []).map(newAllocation);
  }
  if (action === 'update_goal') {
    goal = { ...goal, name: input.name === undefined ? goal.name : financialText(input.name, 'name'),
      totalBudgetMxnMinor: input.totalBudgetMxnMinor === undefined ? goal.totalBudgetMxnMinor : financialMinor(input.totalBudgetMxnMinor),
      targetDate: input.clearTargetDate === true ? null : input.targetDate === undefined ? goal.targetDate : nullableDay(input.targetDate),
      status: input.status === undefined ? goal.status : oneOf(input.status, ['planned', 'active', 'completed', 'archived'] as const, 'status') };
    if (input.allocations !== undefined) {
      if (!Array.isArray(input.allocations)) throw new FinancialPlanError('allocations debe ser una lista de cambios explícitos.');
      const ids = input.allocations.map(value => financialObject(value).allocationId);
      if (new Set(ids).size !== ids.length) throw new FinancialPlanError('Asignaciones repetidas.');
      input.allocations.forEach(value => updateAllocation(value));
    }
  }
  if (action === 'archive_goal') goal = { ...goal, status: 'archived' };
  if (action === 'add_allocation') allocations.push(newAllocation(input.allocation));
  if (action === 'update_allocation' || action === 'archive_allocation') updateAllocation(input, action === 'archive_allocation');
  if (['record_payment', 'correct_payment', 'void_payment'].includes(action)) {
    const previous = action === 'record_payment' ? undefined : payments.find(item => item.id === financialId(input.paymentId));
    if (action !== 'record_payment' && !previous) throw new FinancialPlanError('Pago no encontrado en esta meta.', 'not_found');
    if (previous) { financialRevision(input.expectedPaymentRevision, previous.revision); financialText(input.reason, 'reason'); }
    if (action === 'void_payment') {
      if (previous?.status === 'voided') throw new FinancialPlanError('El pago ya fue anulado.');
      payments = payments.map(item => item.id === previous!.id ? { ...item, status: 'voided', revision: item.revision + 1, updatedAt: at } : item);
    } else {
      const data = financialObject(input.payment);
      const merged = { ...previous, ...data };
      const allocationId = financialId(merged.allocationId ?? input.allocationId);
      const allocation = allocations.find(item => item.id === allocationId);
      if (!allocation || allocation.status !== 'active' && previous?.allocationId !== allocationId) throw new FinancialPlanError('Se requiere una asignación activa de esta meta.');
      financialRevision(input.expectedAllocationRevision, allocation.revision);
      const source = oneOf(merged.source, ['manual_attestation', 'linked_ledger_movement'] as const, 'payment.source');
      const paymentDate = financialDay(merged.paymentDate);
      if (paymentDate > today) throw new FinancialPlanError('Un pago registrado no puede tener una fecha futura. Usa expectedPaymentDate.');
      const ledgerMovementId = source === 'linked_ledger_movement' ? financialId(merged.ledgerMovementId) : null;
      if (source === 'manual_attestation' && data.ledgerMovementId != null) throw new FinancialPlanError('Una declaración manual no crea ni vincula un movimiento bancario.');
      const payment: GoalPayment = { id: previous?.id ?? makeId(), allocationId, amountMxnMinor: financialMinor(merged.amountMxnMinor), paymentDate,
        source, ledgerMovementId, status: 'active', revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? at, updatedAt: at };
      payments = previous ? payments.map(item => item.id === previous.id ? payment : item) : [...payments, payment];
    }
  }
  if (allocations.length > 100 || payments.length > 500) throw new FinancialPlanError('Una meta admite hasta 100 asignaciones y 500 pagos.');
  allocations.sort((a, b) => a.id.localeCompare(b.id));
  payments.sort((a, b) => a.id.localeCompare(b.id));
  const state = { goal, allocations, payments };
  financialGoalFacts(state);
  return state;
};
