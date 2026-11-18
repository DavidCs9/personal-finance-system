import { randomUUID } from 'node:crypto';
import { budgetMonth, budgetMoney, computeBudgetStatus, financialId, FinancialPlanError, monthKeyInZone,
  proposeBudget, type BudgetEntity, type BudgetSpendEvent, type SpendingBudget } from '@finance/domain';
import { readSpendingBudget, readBudgetExclusion, resolveSpendingBudget, listSpendingBudgets, listBudgetExclusions,
  budgetCategoryPreconditions } from '@finance/ledger/native-budgets';
import { readLedgerMovements, type SqlClient } from '@finance/ledger/native-ledger';
import { readerPool, withLedgerReadSnapshot, readSqlFeed } from '../events/sql-reads.js';
import { monthSpendEventsFromFeed } from '../months/summary.js';
import { readSqlPlanRecord } from '../months/sql-reads.js';

export const readBudgetEntity = async (client: SqlClient, owner: string, id: string): Promise<BudgetEntity | null> =>
  await readSpendingBudget(client, owner, id) ?? await readBudgetExclusion(client, owner, id);
export const budgetEvidence = async (client: SqlClient, before: BudgetEntity | null, after: BudgetEntity) => {
  if (after.entityType === 'budget') return { categories: await budgetCategoryPreconditions(client, before as SpendingBudget | null, after) };
  const movement = (await readLedgerMovements(client, { ids: [after.movementId] }))[0];
  if (!movement) throw new FinancialPlanError('Movimiento no encontrado.', 'not_found');
  if (movement.currency !== 'MXN' && (movement.amount as { currency?: unknown } | undefined)?.currency !== 'MXN')
    throw new FinancialPlanError('La exclusión requiere un movimiento MXN.');
  return { movement };
};
export const assertBudgetSlotAvailable = async (client: SqlClient, owner: string, after: BudgetEntity) => {
  const existing = after.entityType === 'budget'
      ? (await client.query('SELECT id FROM olbia.spending_budgets WHERE owner=$1 AND scope=$2 AND effective_month=$3', [owner, after.scope, after.effectiveMonth])).rows
      : (await client.query('SELECT id FROM olbia.budget_exclusions WHERE owner=$1 AND month=$2 AND movement_id=$3::uuid', [owner, after.month, after.movementId])).rows;
  if (existing.length) throw new FinancialPlanError('Ya existe ese registro; consulta su ID/revisión para editarlo.', 'conflict');
};
export const proposeBudgetChange = async (client: SqlClient, owner: string, input: Record<string, unknown>, id: string, at: string) => {
  const prior = input.entityId === undefined ? null : await readBudgetEntity(client, owner, financialId(input.entityId));
  if (input.entityId !== undefined && !prior) throw new FinancialPlanError('Registro no encontrado.', 'not_found');
  // A later recurring change freezes the exact inherited source and creates a new version.
  const successor = prior?.entityType === 'budget' && prior.scope === 'recurring' && input.month !== undefined && String(input.month) > prior.effectiveMonth;
  const source = successor ? prior : null;
  const proposalPrior = successor ? { ...prior, effectiveMonth: budgetMonth(input.month) } as SpendingBudget : prior;
  const proposed = proposeBudget(input, proposalPrior, id, at);
  const after = successor ? { ...proposed, id: randomUUID(), revision: 1, createdAt: at } : proposed;
  const before = successor ? null : prior;
  if (!before) await assertBudgetSlotAvailable(client, owner, after);
  return { prior: before, after, evidence: { ...await budgetEvidence(client, before, after), ...(source ? { sourceBudget: source } : {}) } };
};
export const listBudgets = (owner: string, input: Record<string, unknown> = {}) => withLedgerReadSnapshot(async () => {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new FinancialPlanError('limit debe ser 1–50.');
  return { currency: 'MXN', ...await listSpendingBudgets(readerPool(), owner, Number(limit), input.cursor === undefined ? undefined : financialId(input.cursor)) };
});
export const readBudgetStatus = async (client: SqlClient, owner: string, month: string, now: Date) => {
  const budget = await resolveSpendingBudget(client, owner, month);
  const exclusions = await listBudgetExclusions(client, owner, month);
  const feed = await readSqlFeed([month], client);
  const raw = new Map([...feed.events, ...feed.msiRelated].map(e => [String(e.id), e]));
  const events: BudgetSpendEvent[] = monthSpendEventsFromFeed(feed).map(event => ({ ...event, id: event.id!, categoryId: typeof raw.get(event.id!)?.categoryId === 'string' ? String(raw.get(event.id!)!.categoryId) : null }));
  const plan = await readSqlPlanRecord(owner, month, client);
  const status = computeBudgetStatus({ month, budget, exclusions, events, fixedPayments: plan?.upcomingPayments ?? [], now, missingFixedConfiguration: !plan });
  const catalog = (await client.query('SELECT id,name FROM olbia.spend_categories ORDER BY sort_order,id')).rows;
  return { ...status, generatedAt: now.toISOString(), categories: status.categories.map(row => ({ ...row,
    label: row.categoryId === null ? 'Sin categoría' : catalog.find(c => c.id === row.categoryId)?.name ?? row.categoryId })) };
};
export const getBudgetStatus = (owner: string, input: Record<string, unknown> = {}, now = new Date()) => {
  const month = budgetMonth(input.month ?? monthKeyInZone(now));
  return withLedgerReadSnapshot(() => readBudgetStatus(readerPool(), owner, month, now));
};
export const simulateBudgetPurchase = (owner: string, input: Record<string, unknown>, now = new Date()) => {
  const amount = budgetMoney(input.amountMxnMinor, 1), month = budgetMonth(input.month ?? monthKeyInZone(now));
  if (month < monthKeyInZone(now)) throw new FinancialPlanError('Simula una compra en un mes actual o futuro.');
  return withLedgerReadSnapshot(async () => {
    const before = await readBudgetStatus(readerPool(), owner, month, now);
    const remaining = before.remainingMxnMinor === null ? null : before.remainingMxnMinor - amount;
    const discretionary = before.remainingDiscretionaryMxnMinor === null ? null : before.remainingDiscretionaryMxnMinor - amount;
    const category = input.categoryId === undefined ? null : before.categories.find(c => c.categoryId === input.categoryId) ?? null;
    if (input.categoryId !== undefined && !category) {
      const exists = (await readerPool().query('SELECT id FROM olbia.spend_categories WHERE id=$1', [input.categoryId])).rows.length;
      if (!exists) throw new FinancialPlanError('Categoría no encontrada.');
    }
    return { readOnly: true, month, currency: 'MXN', amountMxnMinor: amount, assumption: 'additional_counted_MXN_purchase_in_selected_month; no_MSI_schedule_or_existing_commitment_inferred', before,
      after: { countedSpentMxnMinor: before.countedSpentMxnMinor + amount, remainingMxnMinor: remaining,
        overspentMxnMinor: remaining === null ? null : Math.max(0, -remaining), remainingDiscretionaryMxnMinor: discretionary,
        safeDailyAllowanceMxnMinor: discretionary === null || before.safeDailyAllowanceMxnMinor === null ? null : Math.floor(Math.max(0, discretionary) / before.remainingDays),
        categoryId: input.categoryId ?? null,
        categoryRemainingMxnMinor: input.categoryId === undefined || !before.configured ? null : (category?.remainingMxnMinor ?? 0) - amount },
    };
  });
};

export const getBudgetHistory = (owner: string, input: Record<string, unknown>, now = new Date()) => {
  const from = budgetMonth(input.fromMonth), to = budgetMonth(input.toMonth);
  const ordinal = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const count = ordinal(to) - ordinal(from) + 1;
  if (count < 1 || count > 12) throw new FinancialPlanError('Consulta de 1 a 12 meses ordenados.');
  return withLedgerReadSnapshot(async () => {
    const client = readerPool();
    const months: (Awaited<ReturnType<typeof readBudgetStatus>> & { periodStatus: string; countedSpendChangeMxnMinor: number | null })[] = [];
    for (let index = ordinal(from); index <= ordinal(to); index++) {
      const month = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      const status = await readBudgetStatus(client, owner, month, now);
      const previous = months.at(-1);
      months.push({ ...status, periodStatus: month < monthKeyInZone(now) ? 'closed' : month === monthKeyInZone(now) ? 'partial' : 'future',
        countedSpendChangeMxnMinor: previous ? status.countedSpentMxnMinor - previous.countedSpentMxnMinor : null });
    }
    const changes = (await client.query(`SELECT r.operation_id::text,r.applied_at,o.action,r.budget_id::text,r.budget_exclusion_id::text
      FROM olbia.financial_change_receipts r JOIN olbia.financial_write_operations o ON o.operation_id=r.operation_id
      WHERE r.owner=$1 AND r.kind='budget' ORDER BY r.applied_at DESC,r.operation_id LIMIT 50`, [owner])).rows;
    return { currency: 'MXN', months, latestChangeReferences: changes, changeReferencesScope: 'latest_50_owner_budget_changes' };
  });
};
