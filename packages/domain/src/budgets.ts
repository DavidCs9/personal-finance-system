import { FinancialPlanError, financialId, financialSum } from './financial-plans.js';
import { computeMonthSummary, dayInZone, daysInCalendarMonth, monthKeyInZone, type MonthFixedPayment, type MonthSpendEvent } from './month-summary.js';

export interface BudgetAllocation { readonly categoryId: string; readonly amountMxnMinor: number }
export interface SpendingBudget {
  readonly entityType: 'budget'; readonly id: string; readonly scope: 'recurring' | 'override'; readonly effectiveMonth: string;
  readonly totalMxnMinor: number; readonly allocations: readonly BudgetAllocation[]; readonly status: 'active' | 'archived';
  readonly revision: number; readonly createdAt: string; readonly updatedAt: string;
}
export interface BudgetExclusion {
  readonly entityType: 'exclusion'; readonly id: string; readonly month: string; readonly movementId: string;
  readonly reason: string; readonly status: 'active' | 'archived'; readonly revision: number;
  readonly createdAt: string; readonly updatedAt: string;
}
export type BudgetEntity = SpendingBudget | BudgetExclusion;
export const budgetMonth = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1000-01') throw new FinancialPlanError('month debe ser YYYY-MM.');
  return value;
};
export const budgetMoney = (value: unknown, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new FinancialPlanError('El importe debe ser centavos MXN enteros seguros, sin negativos.');
  return Number(value);
};
export const validateBudget = (budget: SpendingBudget): void => {
  budgetMoney(budget.totalMxnMinor);
  const seen = new Set<string>();
  if (budget.allocations.length > 100) throw new FinancialPlanError('Máximo 100 categorías por presupuesto.');
  for (const item of budget.allocations) {
    if (typeof item.categoryId !== 'string' || !item.categoryId.trim() || seen.has(item.categoryId)) throw new FinancialPlanError('Categorías inválidas o repetidas.');
    seen.add(item.categoryId); budgetMoney(item.amountMxnMinor);
  }
  if (financialSum(budget.allocations.map(item => item.amountMxnMinor)) > budget.totalMxnMinor)
    throw new FinancialPlanError('Las asignaciones exceden el presupuesto total. Enmienda el total explícitamente o reasigna.');
};
export const proposeBudget = (input: Record<string, unknown>, before: BudgetEntity | null, id: string, at: string): BudgetEntity => {
  const action = String(input.action), todayMonth = monthKeyInZone(new Date(at));
  if (before && input.expectedRevision !== before.revision) throw new FinancialPlanError('Revisión desactualizada; vuelve a consultar.', 'conflict');
  const exclusion = action === 'exclude_movement' || action === 'include_movement';
  if (before && (before.entityType === 'exclusion') !== exclusion) throw new FinancialPlanError('Tipo de registro incompatible.');
  const month = budgetMonth(before ? before.entityType === 'budget' ? before.effectiveMonth : before.month : input.month);
  if (month < todayMonth && (before?.entityType === 'budget' ? before.scope === 'recurring' : action === 'set_recurring'))
    throw new FinancialPlanError('No se pueden reescribir configuraciones recurrentes de meses cerrados; usa un override mensual explícito.');
  if (input.month !== undefined && input.month !== month) throw new FinancialPlanError('El mes de un registro es inmutable; crea una configuración para el nuevo mes.');
  const common = { id, revision: (before?.revision ?? 0) + 1, createdAt: before?.createdAt ?? at, updatedAt: at };
  if (exclusion) {
    if (action === 'include_movement' && !before) throw new FinancialPlanError('Exclusión no encontrada.', 'not_found');
    const reason = input.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw new FinancialPlanError('La exclusión/inclusión requiere un motivo explícito (máximo 500 caracteres).');
    const prior = before as BudgetExclusion | null;
    if (prior && input.movementId !== undefined && input.movementId !== prior.movementId) throw new FinancialPlanError('El movimiento de una exclusión es inmutable.');
    return { ...common, entityType: 'exclusion', month, movementId: prior?.movementId ?? financialId(input.movementId), reason: reason.trim(),
      status: action === 'exclude_movement' ? 'active' : 'archived' };
  }
  if (!['set_recurring', 'set_override', 'reallocate', 'archive', 'restore'].includes(action)) throw new FinancialPlanError('Acción de presupuesto inválida.');
  if (!before && !['set_recurring', 'set_override'].includes(action)) throw new FinancialPlanError('Presupuesto no encontrado.', 'not_found');
  const prior = before as SpendingBudget | null;
  const scope = action === 'set_recurring' ? 'recurring' : action === 'set_override' ? 'override' : prior!.scope;
  if (prior && scope !== prior.scope) throw new FinancialPlanError('El tipo de presupuesto es inmutable.');
  if (prior?.status === 'archived' && action !== 'restore') throw new FinancialPlanError('Restaura el presupuesto antes de editarlo.');
  let allocations: BudgetAllocation[] = [...(prior?.allocations ?? [])];
  if (input.allocations !== undefined) {
    if (!Array.isArray(input.allocations)) throw new FinancialPlanError('allocations debe ser una lista completa de categorías/importes.');
    allocations = input.allocations.map(value => {
      if (!value || typeof value !== 'object') throw new FinancialPlanError('Asignación inválida.');
      return { categoryId: (value as BudgetAllocation).categoryId, amountMxnMinor: budgetMoney((value as BudgetAllocation).amountMxnMinor) };
    });
  }
  if (action === 'reallocate') {
    if (input.totalMxnMinor !== undefined || input.allocations !== undefined) throw new FinancialPlanError('Reasignar sólo acepta origen, destino e importe.');
    const amount = budgetMoney(input.amountMxnMinor, 1), from = String(input.fromCategoryId), to = String(input.toCategoryId);
    if (from === to) throw new FinancialPlanError('Elige dos categorías distintas.');
    const source = allocations.find(item => item.categoryId === from);
    if (!source || source.amountMxnMinor < amount) throw new FinancialPlanError('La categoría origen no tiene asignación suficiente.');
    allocations = allocations.map(item => ({ ...item, amountMxnMinor: item.amountMxnMinor + (item.categoryId === from ? -amount : item.categoryId === to ? amount : 0) }));
    if (!allocations.some(item => item.categoryId === to)) allocations.push({ categoryId: to, amountMxnMinor: amount });
  }
  if (['archive', 'restore'].includes(action) && (input.totalMxnMinor !== undefined || input.allocations !== undefined))
    throw new FinancialPlanError('Archivar/restaurar conserva los importes.');
  const result: SpendingBudget = { ...common, entityType: 'budget', scope, effectiveMonth: month,
    totalMxnMinor: budgetMoney(input.totalMxnMinor ?? prior?.totalMxnMinor), allocations: allocations.sort((a, b) => a.categoryId.localeCompare(b.categoryId)),
    status: action === 'archive' ? 'archived' : 'active' };
  validateBudget(result); return result;
};
export const budgetWarning = (spent: number, limit: number) => spent >= limit ? '100' : BigInt(spent) * 10n >= BigInt(limit) * 9n ? '90' : BigInt(spent) * 10n >= BigInt(limit) * 7n ? '70' : 'normal';
export interface BudgetSpendEvent extends MonthSpendEvent { readonly id: string; readonly categoryId?: string | null }
export const computeBudgetStatus = (input: { month: string; budget: SpendingBudget | null; events: readonly BudgetSpendEvent[];
  fixedPayments: readonly MonthFixedPayment[]; exclusions: readonly BudgetExclusion[]; now: Date; missingFixedConfiguration?: boolean; additionalIncompleteMovementIds?: readonly string[] }) => {
  const { month, budget, fixedPayments, now } = input;
  const events = input.events.filter(event => event.currency === 'MXN');
  const excluded = new Set(input.exclusions.filter(item => item.status === 'active' && item.month === month).map(item => item.movementId));
  const summary = (values: readonly BudgetSpendEvent[], fixed: readonly MonthFixedPayment[]) => computeMonthSummary({
    month, events: values, fixedPayments: fixed, incomeMinor: 0, incomeConfigured: false, upcomingPaymentsMinor: 0, now });
  const gross = summary(events, fixedPayments);
  // An excluded effective linked charge excludes the whole occurrence too; it must not reappear as unlinked programming.
  const linkedExcluded = new Set(fixedPayments.filter(payment => payment.reconciliation?.valid && excluded.has(payment.reconciliation.eventId))
    .map(payment => payment.reconciliation!.eventId));
  const counted = summary(events.filter(event => !excluded.has(event.id)), fixedPayments.filter(payment => !payment.reconciliation?.valid || !linkedExcluded.has(payment.reconciliation.eventId)));
  for (const value of [gross.spentMinor, counted.spentMinor, counted.upcomingMinor, counted.projectedSpendMinor])
    if (!Number.isSafeInteger(value)) throw new FinancialPlanError('El total excede la precisión monetaria soportada.');
  const invalidFixedLinks = fixedPayments.filter(payment => payment.reconciliation && !payment.reconciliation.valid).map(payment => payment.id);
  const current = monthKeyInZone(now), days = daysInCalendarMonth(month), elapsed = month < current ? days : month > current ? 0 : dayInZone(now);
  const remainingDays = month < current ? 0 : month > current ? days : days - elapsed + 1;
  const active = budget?.status === 'active' ? budget : null;
  const upcoming = month < current ? 0 : counted.upcomingMinor;
  const remaining = active ? active.totalMxnMinor - counted.spentMinor : null;
  const discretionary = remaining === null ? null : remaining - upcoming;
  if (discretionary !== null && !Number.isSafeInteger(discretionary)) throw new FinancialPlanError('El total excede la precisión monetaria soportada.');
  const utilization = (spent: number, limit: number) => limit > 0 ? spent / limit * 100 : null;
  const categoryIds = [...new Set([...events.map(event => event.categoryId ?? null), ...(active?.allocations.map(item => item.categoryId) ?? [])])];
  const categories = categoryIds.map(categoryId => {
    const selected = events.filter(event => (event.categoryId ?? null) === categoryId);
    const grossSpent = summary(selected, []).spentMinor;
    const spent = summary(selected.filter(event => !excluded.has(event.id)), []).spentMinor;
    const allocation = active?.allocations.find(item => item.categoryId === categoryId);
    const limit = active ? allocation?.amountMxnMinor ?? 0 : null;
    return { categoryId, allocationConfigured: !!allocation, limitMxnMinor: limit, grossSpentMxnMinor: grossSpent, countedSpentMxnMinor: spent,
      remainingMxnMinor: limit === null ? null : limit - spent, overspentMxnMinor: limit === null ? null : Math.max(0, spent - limit),
      utilizationPercent: limit === null ? null : utilization(spent, limit), warning: limit === null ? null : budgetWarning(spent, limit) };
  });
  const invalidExclusions = input.exclusions.filter(item => item.status === 'active' && (!events.some(event => event.id === item.movementId && !['rejected','pending_foreign','deferred_msi'].includes(event.status)))).map(item => item.id);
  const incomplete = [...new Set([...events.filter(event => event.msi?.needsScheduleCompletion && !['rejected', 'deferred_msi', 'pending_foreign'].includes(event.status)).map(event => event.id),
    ...(input.additionalIncompleteMovementIds ?? [])])].filter(id => !excluded.has(id));
  const allocationTotal = active ? financialSum(active.allocations.map(item => item.amountMxnMinor)) : null;
  return { month, currency: 'MXN', timeZone: 'America/Chihuahua', budget, configured: !!active,
    grossSpentMxnMinor: gross.spentMinor, countedSpentMxnMinor: counted.spentMinor, excludedSpentMxnMinor: gross.spentMinor - counted.spentMinor,
    uncertainMxnMinor: counted.uncertainMinor, upcomingCommitmentsMxnMinor: upcoming, remainingMxnMinor: remaining,
    overspentMxnMinor: remaining === null ? null : Math.max(0, -remaining), remainingDiscretionaryMxnMinor: discretionary,
    unallocatedMxnMinor: active ? active.totalMxnMinor - allocationTotal! : null,
    utilizationPercent: active ? utilization(counted.spentMinor, active.totalMxnMinor) : null,
    warning: active ? budgetWarning(counted.spentMinor, active.totalMxnMinor) : null,
    elapsedPercent: elapsed / days * 100, elapsedDays: elapsed, daysInMonth: days, remainingDays,
    paceRatio: active && active.totalMxnMinor > 0 && elapsed > 0 ? (counted.spentMinor / active.totalMxnMinor) / (elapsed / days) : null,
    projectedCountedSpendMxnMinor: counted.projectedSpendMinor,
    safeDailyAllowanceMxnMinor: discretionary === null || !remainingDays || incomplete.length ? null : Math.floor(Math.max(0, discretionary) / remainingDays),
    allowanceBasis: 'budget_limit_less_counted_spending_and_known_unreconciled_fixed_and_committed_msi; not_bank_balance',
    categories, exclusions: input.exclusions, incompleteScheduleMovementIds: incomplete, inapplicableExclusionIds: invalidExclusions, invalidFixedPaymentLinkIds: invalidFixedLinks,
    foreignMovementIds: input.events.filter(event => event.currency !== 'MXN').map(event => event.id),
    warnings: [...(invalidExclusions.length ? ['Hay exclusiones sin gasto aplicable en el mes; revisa su movimiento y estado.'] : []),
      ...(invalidFixedLinks.length ? ['Hay vínculos de fijos inválidos; conservan su programación por revisar.'] : []),
      ...(incomplete.length ? ['Hay calendarios MSI incompletos; no se puede confirmar una cantidad diaria segura.'] : []),
      ...(input.missingFixedConfiguration ? ['Sin programación de gastos fijos; la cantidad diaria sólo contempla compromisos conocidos.'] : []),
      'Las metas/asignaciones no son gasto. No se descuentan de nuevo. Los abonos/reembolsos siguen el tratamiento de Ledger, sin conciliación inferida.'],
  };
};
