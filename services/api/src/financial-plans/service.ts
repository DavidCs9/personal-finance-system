import { manualReconciliationProposal, normalizeManualReconciliation, prepareManualReconciliationApply,
  type ManualReconciliation } from '../events/manual-reconciliation.js';
import { proposeBudgetChange, readBudgetEntity, budgetEvidence, assertBudgetSlotAvailable } from './budgets.js';
import { applyFixedReconciliation, applyMsiReconciliation, fixedReconciliationProposal, msiReconciliationProposal } from './reconciliation.js';
import { type BudgetEntity } from '@finance/domain';
import { writeBudgetEntity } from '@finance/ledger/native-budgets';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { addCalendarMonths, dayKeyInZone, monthKeyInZone, FINANCE_TIME_ZONE, isValidMonth,
  FinancialPlanError, financialId, financialObject, financialSum, financialGoalFacts, incomeOccurrences, summarizeFutureIncome,
  proposeExpectedIncome, proposeFinancialGoal, maybeAutoAmexMsi, payrollEmployerKey, MX_BANKING_CALENDAR_VERSION,
  type ExpectedIncome, type FinancialGoalState, type GoalPayment, type MonthFutureIncome, type MonthlyReceivedTotal } from '@finance/domain';
import { applicationSqlClient, withSqlTransaction } from '@finance/ledger/sql-runtime';
import { readExpectedIncome, listExpectedIncomeRows, readIncomeEvidence, writeExpectedIncome, readFinancialGoal,
  readMonthlyReceived, writeMonthlyReceived, listFinancialGoalIds, writeFinancialGoal, readGoalMovement, readGoalMovements, paymentMovementUsed, insertFinancialOperation,
  readFinancialOperation, readFinancialReceipt, appendFinancialReceipt, failFinancialOperation, financialHistory,
  type FinancialWriteOperation, type FinancialWriteKind } from '@finance/ledger/native-financial-plans';
import { readerPool, withLedgerReadSnapshot } from '../events/sql-reads.js';
import { parseManualEntry, manualEntryFingerprint, type ManualEntryInput } from '../events/manual-entry-input.js';
import { prepareManualEvent, previousManualCapture } from '../events/manual-entry.js';
import { manualCreditFundEvidence, parseManualCredit, prepareManualCredit, previousManualCredit } from '../events/manual-credit.js';
import type { SqlClient } from '@finance/ledger/native-ledger';

const jsonObject = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const same = (left: unknown, right: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
const page = (input: Record<string, unknown>, maximum: number) => {
  const limit = input.limit ?? maximum;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maximum) throw new FinancialPlanError(`limit debe estar entre 1 y ${maximum}.`);
  return { limit: Number(limit), cursor: input.cursor === undefined ? undefined : financialId(input.cursor) };
};
export const financialMonthRange = (input: Record<string, unknown>, now = new Date()) => {
  const fromMonth = input.fromMonth ?? monthKeyInZone(now);
  if (typeof fromMonth !== 'string' || !isValidMonth(fromMonth) || fromMonth < '1000-01') throw new FinancialPlanError('fromMonth debe ser YYYY-MM.');
  const toMonth = input.toMonth ?? addCalendarMonths(fromMonth, 11);
  if (typeof toMonth !== 'string' || !isValidMonth(toMonth) || toMonth < '1000-01') throw new FinancialPlanError('toMonth debe ser YYYY-MM.');
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  const count = index(toMonth) - index(fromMonth) + 1;
  if (count < 1 || count > 24) throw new FinancialPlanError('Consulta un rango ordenado de hasta 24 meses inclusivos.');
  return { fromMonth, toMonth, months: Array.from({ length: count }, (_, offset) => addCalendarMonths(fromMonth, offset)) };
};
const incomeFacts = (sources: readonly ExpectedIncome[], range: ReturnType<typeof financialMonthRange>, context: Awaited<ReturnType<typeof readIncomeEvidence>>) => {
  const occurrences = sources.flatMap(source => incomeOccurrences(source, range.fromMonth, range.toMonth, context.actual, context.terminations));
  return {
    currency: 'MXN', timeZone: FINANCE_TIME_ZONE, fromMonth: range.fromMonth, toMonth: range.toMonth,
    sources: sources.map(source => ({ ...source, amountBasis: 'per_payment_occurrence', confidenceBasis: 'owner_configured_expectation_not_received_income',
      confirmedTerminationDate: context.terminations.find(item => source.employer && payrollEmployerKey(item.employer) === payrollEmployerKey(source.employer))?.endedOn ?? null })),
    occurrences, actualPayroll: context.actual,
    expectedTotalsScope: 'returned_sources', actualPayrollScope: 'owner_month_range_do_not_sum_across_pages',
    monthlyTotals: range.months.map(month => {
      const scheduled = occurrences.filter(item => (item.paymentDate?.slice(0, 7) ?? item.periodMonth) === month);
      const actual = context.actual.filter(item => item.paymentDate.slice(0, 7) === month);
      const overlap = scheduled.some(item => item.reconciliationStatus === 'possible_payroll_overlap');
      const unknownAmount = scheduled.some(item => item.amountMxnMinor === null);
      const sumKnown = (confidence?: ExpectedIncome['confidence']) => financialSum(scheduled
        .filter(item => confidence === undefined || item.confidence === confidence)
        .flatMap(item => item.amountMxnMinor === null ? [] : [item.amountMxnMinor]));
      const byConfidence = (confidence: ExpectedIncome['confidence']) =>
        scheduled.some(item => item.confidence === confidence && item.amountMxnMinor === null) ? null : sumKnown(confidence);
      const expectedKnownMxnMinor = sumKnown();
      return { month, expectedScheduledMxnMinor: unknownAmount ? null : expectedKnownMxnMinor, expectedKnownMxnMinor,
        unknownExpectedOccurrences: scheduled.filter(item => item.amountMxnMinor === null).length,
        provisionalCalendarOccurrences: scheduled.filter(item => item.calendarStatus === 'cnbv_calendar_provisional').length,
        estimatedExpectedMxnMinor: byConfidence('estimated'),
        confirmedExpectedMxnMinor: byConfidence('confirmed'),
        actualPayrollMxnMinor: financialSum(actual.map(item => item.netMxnMinor)), actualPayslipCount: actual.length,
        overlapStatus: overlap ? 'unresolved_payroll_overlap' : 'no_overlap_identified_not_reconciled',
        remainingExpectedMxnMinor: overlap || unknownAmount ? null : expectedKnownMxnMinor,
        combinedActualAndExpectedMxnMinor: null };
    }),
    limitations: ['Expected income is a configured expectation, including when confirmed; it is not money received.',
      'No automatic payroll reconciliation. Same-employer or unidentified-employer payroll is an unresolved overlap, never an additional verified deposit.',
      'Actual payroll and expected schedules are separate totals; never add unresolved expectations to actual income.',
      'Configured amounts are per occurrence. A partial month without an explicit override can have an unknown net amount and date.',
      'CNBV business-day dates outside published calendar coverage are provisional. The employer may use an explicit month override.',
      'Confirmed employment termination caps future occurrences.'],
  };
};
export const listExpectedIncome = async (owner: string, input: Record<string, unknown> = {}, now = new Date()) => {
  const range = financialMonthRange(input, now), paging = page(input, 50);
  return withLedgerReadSnapshot(async () => {
    const client = readerPool();
    const rows = await listExpectedIncomeRows(client, owner, paging.limit, paging.cursor);
    const context = await readIncomeEvidence(client, owner, `${range.fromMonth}-01`, `${addCalendarMonths(range.toMonth, 1)}-01`);
    const sources = rows.slice(0, paging.limit);
    return { ...incomeFacts(sources, range, context), nextCursor: rows.length > paging.limit ? sources.at(-1)!.id : null };
  });
};

export const getMonthFutureIncome = async (owner: string, month: string, now: Date, observedIncome: boolean): Promise<MonthFutureIncome> => {
  if (month < dayKeyInZone(now).slice(0, 7)) return summarizeFutureIncome(month, now, [], observedIncome);
  const plan = await listExpectedIncome(owner, { fromMonth: month, toMonth: month }, now);
  return summarizeFutureIncome(month, now, plan.occurrences, observedIncome, Boolean(plan.nextCursor));
};
export const getExpectedIncome = async (owner: string, incomeId: unknown, input: Record<string, unknown> = {}, now = new Date()) => {
  const id = financialId(incomeId), range = financialMonthRange(input, now);
  return withLedgerReadSnapshot(async () => {
    const client = readerPool(), source = await readExpectedIncome(client, owner, id);
    if (!source) throw new FinancialPlanError('Ingreso no encontrado.', 'not_found');
    const context = await readIncomeEvidence(client, owner, `${range.fromMonth}-01`, `${addCalendarMonths(range.toMonth, 1)}-01`);
    return { ...incomeFacts([source], range, context), history: await financialHistory(client, owner, 'income', id) };
  });
};
const movementProblem = (payment: GoalPayment, movement: Awaited<ReturnType<typeof readGoalMovement>>) => {
  if (!movement || !['accepted', 'needs_review'].includes(String(movement.status)) || movement.currency !== 'MXN' || movement.has_msi === true
    || Number(movement.amount_minor) !== payment.amountMxnMinor || movement.payment_date !== payment.paymentDate)
    return 'El movimiento vinculado no acredita el importe propio/fecha de este pago MXN sin MSI; revisa o corrige el registro.';
  return null;
};
const goalFacts = async (client: SqlClient, state: FinancialGoalState) => {
  const facts = financialGoalFacts(state);
  // References are not raw evidence. Stored payment assertions survive later ledger edits, with an explicit warning.
  const links = state.payments.filter(item => item.ledgerMovementId);
  const movements = new Map((await readGoalMovements(client, links.map(item => item.ledgerMovementId!))).map(row => [String(row.id), row]));
  const linkedPaymentWarnings = [];
  for (const payment of links) {
    const movement = movements.get(payment.ledgerMovementId!) ?? null;
    const problem = movementProblem(payment, movement) ?? (movement?.status === 'needs_review' ? 'El movimiento vinculado conserva importe por confirmar; el registro de pago no elimina esa incertidumbre.' : null);
    if (problem) linkedPaymentWarnings.push({ paymentId: payment.id, ledgerMovementId: payment.ledgerMovementId, message: problem });
  }
  return { ...facts, linkedPaymentWarnings };
};
export const getFinancialGoal = async (owner: string, goalId: unknown) => {
  const id = financialId(goalId);
  return withLedgerReadSnapshot(async () => {
    const client = readerPool(), state = await readFinancialGoal(client, owner, id);
    if (!state) throw new FinancialPlanError('Meta no encontrada.', 'not_found');
    return { ...await goalFacts(client, state), history: await financialHistory(client, owner, 'goal', id) };
  });
};
export const listFinancialGoals = async (owner: string, input: Record<string, unknown> = {}) => {
  const paging = page(input, 10);
  if (input.status !== undefined && !['planned', 'active', 'completed', 'archived'].includes(String(input.status))) throw new FinancialPlanError('status inválido.');
  return withLedgerReadSnapshot(async () => {
    const client = readerPool(), ids = await listFinancialGoalIds(client, owner, paging.limit, input.status as string | undefined, paging.cursor);
    const goals = [];
    for (const id of ids.slice(0, paging.limit)) goals.push(await goalFacts(client, (await readFinancialGoal(client, owner, id))!));
    return { currency: 'MXN', goals, nextCursor: ids.length > paging.limit ? ids[paging.limit - 1] : null };
  });
};
const linkedPreconditions = async (client: SqlClient, before: FinancialGoalState | null, after: FinancialGoalState) => {
  const evidence: Record<string, unknown> = {};
  for (const payment of after.payments) {
    const prior = before?.payments.find(item => item.id === payment.id);
    if (payment.source !== 'linked_ledger_movement' || payment.status === 'voided' || prior?.revision === payment.revision) continue;
    const movement = await readGoalMovement(client, payment.ledgerMovementId!);
    const problem = movementProblem(payment, movement);
    if (problem) throw new FinancialPlanError(problem);
    if (await paymentMovementUsed(client, payment.ledgerMovementId!, payment.id)) throw new FinancialPlanError('El movimiento ya está vinculado a otro pago; corrige ese pago.', 'conflict');
    evidence[payment.id] = movement;
  }
  return evidence;
};
const manualFacts = (value: Record<string, unknown> | null) => {
  if (!value) return null;
  const amount = financialObject(value.amount);
  const plan = value.msi && typeof value.msi === 'object' ? value.msi as Record<string, unknown> : null;
  const installments = Array.isArray(plan?.installments) ? plan.installments as Record<string, unknown>[] : [];
  return { id: value.id, institution: value.institution, merchantRaw: value.merchantRaw, status: value.status,
    amountMinor: amount.amountMinor, currency: amount.currency, personalAmountMinor: value.personalAmountMinor ?? null,
    occurredOn: dayKeyInZone(new Date(String(value.occurredAt ?? value.receivedAt))),
    msi: plan ? { months: plan.months, principalMinor: plan.principalMinor, cuotaMinor: plan.cuotaMinor, origin: plan.origin,
      installments: installments.map(item => ({ index: item.index, month: item.month, amountMinor: item.amountMinor, status: item.status })) } : null };
};
const manualExisting = async (client: SqlClient, owner: string, input: ManualEntryInput) =>
  manualFacts(await previousManualCapture(client, manualEntryFingerprint(owner, input)) ?? null);
const validPending = (operation: FinancialWriteOperation | null, kind?: FinancialWriteKind, now = new Date()): FinancialWriteOperation => {
  if (!operation || kind && operation.kind !== kind) throw new FinancialPlanError('Operación no encontrada para este dueño/tipo.', 'not_found');
  if (operation.status === 'failed') throw new FinancialPlanError('El preview falló. Consulta su estado y crea otro preview.', 'conflict');
  if (operation.status === 'pending' && operation.expiresAt <= now.toISOString()) throw new FinancialPlanError('El preview expiró. Vuelve a consultar y crea otro.', 'expired');
  return operation;
};
export const previewFinancialChange = async (owner: string, kind: FinancialWriteKind, input: Record<string, unknown>, now = new Date()) => {
  if (!owner.trim()) throw new FinancialPlanError('Falta el dueño autenticado.');
  const at = now.toISOString(), today = dayKeyInZone(now);
  let entityId = kind === 'budget' && input.entityId !== undefined ? financialId(input.entityId) : kind === 'income' && input.action !== 'create'
    ? financialId(input.incomeId) : kind === 'goal' && input.action !== 'create_goal' ? financialId(input.goalId) : randomUUID();
  const manual = kind === 'manual_reconciliation' ? await normalizeManualReconciliation(owner, input, now) : undefined;
  // Writes only an authentic preview record. Current domain records are unchanged.
  return withSqlTransaction(async client => {
    let before: Record<string, unknown> | null = null, after: Record<string, unknown>, preview: Record<string, unknown>, evidencePreconditions: Record<string, unknown> = {};
    if (kind === 'monthly_received') {
      if (typeof input.month !== 'string' || !isValidMonth(input.month) || input.month < '1000-01' || input.month > today.slice(0, 7))
        throw new FinancialPlanError('Elige un mes actual o anterior.');
      const amount = input.amountMinor;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)
        throw new FinancialPlanError('Indica el total en centavos MXN, desde cero.');
      const prior = await readMonthlyReceived(client, owner, input.month);
      if (input.expectedRevision !== (prior?.revision ?? 0))
        throw new FinancialPlanError('El total recibido cambió. Vuelve a consultar el mes.', 'conflict');
      entityId = prior?.id ?? entityId;
      const total: MonthlyReceivedTotal = { id: entityId, month: input.month, amountMinor: amount,
        revision: (prior?.revision ?? 0) + 1, updatedAt: at };
      before = prior ? { ...prior } : null;
      after = { ...total };
      preview = { before, after, effect: 'declared_month_total_only; bank_credits_unchanged' };
    } else if (kind === 'budget') {
      const proposed = await proposeBudgetChange(client, owner, input, entityId, at);
      entityId = proposed.after.id;
      before = proposed.prior ? jsonObject(proposed.prior) : null; after = jsonObject(proposed.after);
      evidencePreconditions = jsonObject(proposed.evidence);
      preview = { before, after, inheritedSourceBudget: proposed.evidence.sourceBudget ?? null, effect: 'budget_configuration_only; ledger_actuals_unchanged' };
    } else if (kind === 'fixed_reconciliation') {
      const proposed = await fixedReconciliationProposal(client, owner, input);
      entityId = proposed.movementId;
      before = jsonObject(proposed.before); after = jsonObject(proposed.after);
      evidencePreconditions = jsonObject(proposed.evidence);
      preview = { before, after, evidence: evidencePreconditions,
        effect: proposed.after.eventId === null ? 'restore_unlinked_fixed_programming' : 'cover_fixed_occurrence_without_adding_spend' };
    } else if (kind === 'msi_reconciliation') {
      const proposed = await msiReconciliationProposal(client, owner, input, at);
      entityId = proposed.after.movementId;
      before = jsonObject(proposed.before); after = jsonObject(proposed.after);
      evidencePreconditions = jsonObject(proposed.evidence);
      preview = { before, after, evidence: evidencePreconditions, effect: 'reconcile_existing_purchase_without_new_charge' };
    } else if (kind === 'income') {
      const prior = input.action === 'create' ? null : await readExpectedIncome(client, owner, entityId);
      const proposed = proposeExpectedIncome(input, prior, entityId, at);
      const currentMonth = monthKeyInZone(now);
      const overrideMonth = input.monthOverride === undefined ? input.clearMonthOverride : financialObject(input.monthOverride).month;
      const fromMonth = typeof overrideMonth === 'string' ? overrideMonth
        : input.action === 'create' && proposed.startDate.slice(0, 7) < currentMonth ? proposed.startDate.slice(0, 7) : currentMonth;
      const toMonth = fromMonth > '9998-01' ? '9999-12' : addCalendarMonths(fromMonth, 23);
      const range = financialMonthRange({ fromMonth, toMonth }, now);
      const context = await readIncomeEvidence(client, owner, `${range.fromMonth}-01`, `${addCalendarMonths(range.toMonth, 1)}-01`);
      before = prior ? jsonObject(prior) : null; after = jsonObject(proposed);
      evidencePreconditions = jsonObject({ ...context, calendarVersion: MX_BANKING_CALENDAR_VERSION });
      preview = { before: prior, after: proposed, affectedPaymentOccurrences: {
        fromMonth: range.fromMonth, toMonth: range.toMonth,
        before: prior ? incomeOccurrences(prior, range.fromMonth, range.toMonth, context.actual, context.terminations) : [],
        after: incomeOccurrences(proposed, range.fromMonth, range.toMonth, context.actual, context.terminations),
        beyondPreviewHorizon: 'Query list_expected_income for other configured periods; this is not a cash-flow forecast.',
      }, accounting: incomeFacts([proposed], range, context) };
    } else if (kind === 'goal') {
      const prior = input.action === 'create_goal' ? null : await readFinancialGoal(client, owner, entityId);
      // Reserve the create ID in the preview so apply never invents a new identity.
      let firstId = true;
      const proposed = proposeFinancialGoal(input, prior, () => {
        if (!prior && firstId) { firstId = false; return entityId; }
        return randomUUID();
      }, at, today);
      before = prior ? jsonObject(prior) : null; after = jsonObject(proposed);
      evidencePreconditions = await linkedPreconditions(client, prior, proposed);
      preview = { before: prior ? await goalFacts(client, prior) : null, after: await goalFacts(client, proposed),
        reason: typeof input.reason === 'string' ? input.reason.trim() : null };
    } else if (manual) {
      const { token, ...proposal } = await manualReconciliationProposal(client, owner, manual);
      entityId = manual.movementId ?? entityId;
      after = jsonObject(manual);
      evidencePreconditions = { token };
      preview = jsonObject(proposal);
    } else if (kind === 'manual_credit') {
      const parsed = parseManualCredit(input, now);
      const prior = await previousManualCredit(client, owner, parsed);
      const fundReconciliation = await manualCreditFundEvidence(client, owner, parsed, prior);
      if (prior) entityId = prior.movementId;
      before = prior ? jsonObject(prior) : null;
      after = jsonObject({ ...parsed, confirmedPosted: true });
      preview = { before, after: { ...parsed, movementId: prior?.movementId ?? entityId },
        effect: prior ? 'existing_idempotent_capture' : 'record_posted_bank_credit',
        snapshotCoverage: 'unverified', modifiesCashSnapshots: false, modifiesBudget: false, fundReconciliation };
    } else {
      const parsed = parseManualEntry(JSON.stringify(input));
      before = await manualExisting(client, owner, parsed); after = jsonObject(parsed);
      evidencePreconditions = { previousCapture: before };
      preview = { before, after: { ...parsed, occurredAt: undefined, id: before?.id ?? entityId,
        automaticMsi: maybeAutoAmexMsi({ institution: parsed.institution, amountMinor: parsed.amountMinor, occurredAt: parsed.occurredAt, receivedAt: at }) ?? null },
        classification: 'registro_manual', effect: before ? 'existing_idempotent_capture' : 'create_observed_charge_with_canonical_accounting',
        warning: 'Esta operación registra un cobro observado; no uses un ingreso esperado ni un compromiso futuro como evidencia.' };
    }
    const action = kind === 'monthly_received' ? 'set_monthly_received' : kind === 'manual_charge' ? 'register_manual_charge' : kind === 'manual_credit' ? 'register_manual_credit' : String(input.action);
    const operation: FinancialWriteOperation = { operationId: randomUUID(), owner, kind, action,
      entityId, createdAt: at, expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(), status: 'pending', failureCode: null,
      before, after, preview: jsonObject(preview), evidencePreconditions };
    await insertFinancialOperation(client, operation);
    return { ok: true, operationId: operation.operationId, kind, status: 'pending', expiresAt: operation.expiresAt, ...operation.preview };
  });
};
export const applyFinancialChange = async (owner: string, operationId: unknown, kind?: FinancialWriteKind, now = new Date()) => {
  const id = financialId(operationId);
  // Prepare originals outside SQL retry callbacks. No business mutation can occur here.
  const initial = validPending(await readFinancialOperation(applicationSqlClient(), owner, id), kind, now);
  if (initial.status === 'applied') return (await readFinancialReceipt(applicationSqlClient(), owner, id))!;
  const manualApply = initial.kind === 'manual_charge'
    ? await prepareManualEvent(JSON.stringify(initial.after), owner, { movementId: initial.entityId, observationId: initial.operationId }) : undefined;
  try {
    const reconciliationApply = initial.kind === 'manual_reconciliation'
      ? await prepareManualReconciliationApply(owner, initial.after as ManualReconciliation,
        { movementId: initial.entityId, operationId: id }, initial.evidencePreconditions.token)
      : undefined;
    const creditApply = initial.kind === 'manual_credit'
      ? await prepareManualCredit(parseManualCredit(initial.after, now), owner, { movementId: initial.entityId, observationId: initial.operationId })
      : undefined;
    return await withSqlTransaction(async client => {
      const operation = validPending(await readFinancialOperation(client, owner, id), kind, new Date());
      if (operation.status === 'applied') return (await readFinancialReceipt(client, owner, id))!;
      let result: Record<string, unknown>, movementId: string | undefined;
      let receiptOperation = operation;
      const appliedAt = new Date().toISOString();
      if (operation.kind === 'monthly_received') {
        const proposed = operation.after as unknown as MonthlyReceivedTotal;
        const current = await readMonthlyReceived(client, owner, proposed.month);
        if (!same(current, operation.before))
          throw new FinancialPlanError('El total recibido cambió. Vuelve a consultar el mes.', 'conflict');
        const total = { ...proposed, updatedAt: appliedAt };
        await writeMonthlyReceived(client, owner, total);
        receiptOperation = { ...operation, after: { ...total } };
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt, monthlyReceived: total };
      } else if (operation.kind === 'budget') {
        const before = await readBudgetEntity(client, owner, operation.entityId);
        if (!same(before, operation.before)) throw new FinancialPlanError('El presupuesto/exclusión cambió después del preview.', 'conflict');
        const after = operation.after as unknown as BudgetEntity;
        const effectiveMonth = after.entityType === 'budget' ? after.effectiveMonth : after.month;
        if (after.entityType === 'budget' && after.scope === 'recurring' && effectiveMonth < monthKeyInZone(new Date(appliedAt))) throw new FinancialPlanError('El mes del preview ya está cerrado.', 'conflict');
        const evidence = await budgetEvidence(client, before, after);
        const source = operation.evidencePreconditions.sourceBudget as BudgetEntity | undefined;
        const currentEvidence = { ...evidence, ...(source ? { sourceBudget: await readBudgetEntity(client, owner, source.id) } : {}) };
        if (!same(currentEvidence, operation.evidencePreconditions)) throw new FinancialPlanError('La categoría o movimiento cambió después del preview.', 'conflict');
        if (!before) await assertBudgetSlotAvailable(client, owner, after);
        await writeBudgetEntity(client, owner, before, after);
        result = { ok: true, operationId: id, kind: 'budget', status: 'applied', appliedAt, budgetEntity: await readBudgetEntity(client, owner, operation.entityId) };
      } else if (operation.kind === 'fixed_reconciliation') {
        const proposed = await fixedReconciliationProposal(client, owner, operation.after);
        if (!same(proposed.before, operation.before) || !same(proposed.evidence, operation.evidencePreconditions))
          throw new FinancialPlanError('El fijo, su vínculo o el movimiento cambió después del preview.', 'conflict');
        await applyFixedReconciliation(client, owner, proposed, appliedAt);
        movementId = proposed.movementId;
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt,
          month: proposed.after.month, paymentId: proposed.after.paymentId, linkedMovementId: proposed.after.eventId,
          programmedAmountMinor: proposed.checked.payment.amountMinor, movement: proposed.evidence.movement };
      } else if (operation.kind === 'msi_reconciliation') {
        const proposed = await msiReconciliationProposal(client, owner, operation.after, appliedAt);
        if (!same(proposed.before, operation.before) || !same(proposed.evidence, operation.evidencePreconditions))
          throw new FinancialPlanError('El plan o la evidencia bancaria cambió después del preview.', 'conflict');
        const plan = await applyMsiReconciliation(owner, proposed, appliedAt);
        movementId = proposed.after.movementId;
        receiptOperation = { ...operation, after: jsonObject({ ...proposed.after, plan }) };
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt, movementId, plan,
          bankRow: proposed.after.bankRow };
      } else if (operation.kind === 'income') {
        const before = await readExpectedIncome(client, owner, operation.entityId);
        if (!same(before, operation.before)) throw new FinancialPlanError('El ingreso cambió después del preview.', 'conflict');
        // Use the financial preview horizon (not a UTC-derived month) stored in its facts.
        const coverage = financialObject(operation.preview.affectedPaymentOccurrences);
        const context = await readIncomeEvidence(client, owner, `${String(coverage.fromMonth)}-01`, `${addCalendarMonths(String(coverage.toMonth), 1)}-01`);
        const expected = operation.evidencePreconditions;
        const current = expected.calendarVersion === undefined ? context : { ...context, calendarVersion: MX_BANKING_CALENDAR_VERSION };
        if (!same(current, expected)) throw new FinancialPlanError('La nómina, la salida laboral o el calendario bancario cambió después del preview.', 'conflict');
        const after = operation.after as unknown as ExpectedIncome;
        await writeExpectedIncome(client, owner, before, after);
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt, income: await readExpectedIncome(client, owner, operation.entityId) };
      } else if (operation.kind === 'goal') {
        const before = await readFinancialGoal(client, owner, operation.entityId);
        if (!same(before, operation.before)) throw new FinancialPlanError('La meta o sus pagos cambiaron después del preview.', 'conflict');
        const after = operation.after as unknown as FinancialGoalState;
        financialGoalFacts(after);
        if (!same(await linkedPreconditions(client, before, after), operation.evidencePreconditions)) throw new FinancialPlanError('La evidencia vinculada cambió después del preview.', 'conflict');
        await writeFinancialGoal(client, owner, before, after);
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt,
          goal: await goalFacts(client, (await readFinancialGoal(client, owner, operation.entityId))!) };
      } else if (operation.kind === 'manual_reconciliation') {
        const movement = await reconciliationApply!(client, appliedAt);
        movementId = String(movement.id);
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt,
          movement: movement.credit ? { id: movementId, status: movement.status } : { ...manualFacts(movement), accountLastFour: (movement as Record<string, unknown>).accountLastFour },
          ...(movement.credit ? { credit: movement.credit } : {}) };
      } else if (operation.kind === 'manual_credit') {
        const captured = await creditApply!(client, appliedAt);
        movementId = captured.credit.movementId;
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt, ...captured,
          snapshotCoverage: 'unverified', modifiesCashSnapshots: false, modifiesBudget: false };
      } else {
        const input = operation.after as unknown as ManualEntryInput;
        if (!same(await manualExisting(client, owner, input), operation.evidencePreconditions.previousCapture)) throw new FinancialPlanError('El cobro ya fue registrado o cambió después del preview; consulta antes de repetirlo.', 'conflict');
        const movement = await manualApply!(client);
        movementId = String(movement.id);
        result = { ok: true, operationId: id, kind: operation.kind, status: 'applied', appliedAt, movement: manualFacts(movement) };
      }
      await appendFinancialReceipt(client, receiptOperation, result, appliedAt, movementId);
      return result;
    });
  } catch (error) {
    if (error instanceof FinancialPlanError) {
      await withSqlTransaction(client => failFinancialOperation(client, owner, id, error.reasonCode));
    }
    // Unknown SQL/transport outcomes must be recovered through status, never by making up another operation.
    throw error;
  }
};
export const getFinancialWriteStatus = async (owner: string, operationId: unknown, now = new Date()) => {
  const id = financialId(operationId);
  return withLedgerReadSnapshot(async () => {
    const client = readerPool(), operation = await readFinancialOperation(client, owner, id);
    if (!operation) return { ok: false, operationId: id, status: 'not_found', message: 'No hay un preview propio con este ID. No repitas una escritura sin leer el estado actual.' };
    const result = await readFinancialReceipt(client, owner, id);
    const status = result ? 'applied' : operation.failureCode === 'expired' || operation.status === 'pending' && operation.expiresAt <= now.toISOString() ? 'expired' : operation.status;
    return { ok: true, operationId: id, kind: operation.kind, action: operation.action, status, expiresAt: operation.expiresAt,
      result, failureCode: operation.failureCode,
      recovery: status === 'applied' ? 'Consulta el registro actual para verificarlo; el recibo acredita esta operación histórica.'
        : status === 'pending' ? 'Aplica sólo este operationId si la instrucción explícita sigue vigente.' : 'Vuelve a consultar y crea otro preview; no repitas este apply.' };
  });
};
