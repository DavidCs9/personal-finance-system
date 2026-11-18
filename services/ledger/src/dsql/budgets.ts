import { FinancialPlanError, validateBudget, type BudgetEntity, type SpendingBudget, type BudgetExclusion } from '@finance/domain';
import type { SqlClient } from './projection.js';
const instant = (value: unknown) => new Date(value as string | Date).toISOString();
const exclusionFrom = (r: Record<string, unknown>): BudgetExclusion => ({ entityType: 'exclusion', id: String(r.id), month: String(r.month), movementId: String(r.movement_id), reason: String(r.reason),
  status: r.status as BudgetExclusion['status'], revision: Number(r.revision), createdAt: instant(r.created_at), updatedAt: instant(r.updated_at) });
export const readSpendingBudget = async (client: SqlClient, owner: string, id: string): Promise<SpendingBudget | null> => {
  const r = (await client.query('SELECT * FROM olbia.spending_budgets WHERE id=$1::uuid AND owner=$2', [id, owner])).rows[0];
  if (!r) return null;
  const allocations = (await client.query('SELECT category_id,amount_mxn_minor FROM olbia.budget_allocations WHERE budget_id=$1::uuid ORDER BY category_id', [id])).rows
    .map(row => ({ categoryId: String(row.category_id), amountMxnMinor: Number(row.amount_mxn_minor) }));
  const result: SpendingBudget = { entityType: 'budget', id, scope: r.scope as SpendingBudget['scope'], effectiveMonth: String(r.effective_month), totalMxnMinor: Number(r.total_mxn_minor),
    status: r.status as SpendingBudget['status'], revision: Number(r.revision), createdAt: instant(r.created_at), updatedAt: instant(r.updated_at), allocations };
  validateBudget(result); return result;
};
export const readBudgetExclusion = async (client: SqlClient, owner: string, id: string): Promise<BudgetExclusion | null> => {
  const r = (await client.query('SELECT * FROM olbia.budget_exclusions WHERE id=$1::uuid AND owner=$2', [id, owner])).rows[0];
  return r ? exclusionFrom(r) : null;
};
export const resolveSpendingBudget = async (client: SqlClient, owner: string, month: string): Promise<SpendingBudget | null> => {
  const row = (await client.query(`SELECT id::text FROM olbia.spending_budgets WHERE owner=$1 AND
    ((scope='override' AND effective_month=$2) OR (scope='recurring' AND effective_month<=$2))
    ORDER BY scope ASC,effective_month DESC LIMIT 1`, [owner, month])).rows[0];
  return row ? readSpendingBudget(client, owner, String(row.id)) : null;
};
export const listSpendingBudgets = async (client: SqlClient, owner: string, limit: number, cursor?: string) => {
  const ids = (await client.query('SELECT id::text FROM olbia.spending_budgets WHERE owner=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3', [owner, cursor ?? null, limit + 1])).rows;
  const budgets = [];
  for (const row of ids.slice(0, limit)) budgets.push((await readSpendingBudget(client, owner, String(row.id)))!);
  return { budgets, nextCursor: ids.length > limit ? budgets.at(-1)!.id : null };
};
export const listBudgetExclusions = async (client: SqlClient, owner: string, month: string) => {
  const rows = (await client.query('SELECT * FROM olbia.budget_exclusions WHERE owner=$1 AND month=$2 ORDER BY id LIMIT 501', [owner, month])).rows;
  if (rows.length > 500) throw new FinancialPlanError('Más de 500 exclusiones en el mes; no se puede devolver un total completo.');
  return rows.map(exclusionFrom);
};
/** Retains archived category identities; only new/changed assignments must be active. */
export const budgetCategoryPreconditions = async (client: SqlClient, before: SpendingBudget | null, after: SpendingBudget) => {
  const changed = after.allocations.filter(a => !before?.allocations.some(b => b.categoryId === a.categoryId && b.amountMxnMinor === a.amountMxnMinor));
  if (!changed.length) return [];
  const rows = (await client.query(`SELECT c.id,COALESCE(l.archived,false) AS archived,COALESCE(l.revision,1) AS revision
    FROM olbia.spend_categories c LEFT JOIN olbia.category_lifecycle l ON l.category_id=c.id WHERE c.id=ANY($1::text[]) ORDER BY c.id`, [changed.map(a => a.categoryId)])).rows;
  if (rows.length !== changed.length || rows.some(row => row.archived)) throw new FinancialPlanError('Las asignaciones nuevas requieren categorías activas del catálogo.');
  return rows;
};
export const writeBudgetEntity = async (client: SqlClient, owner: string, before: BudgetEntity | null, after: BudgetEntity) => {
  if (after.entityType === 'exclusion') {
    if (!before) await client.query(`INSERT INTO olbia.budget_exclusions (id,owner,month,movement_id,reason,status,revision,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [after.id, owner, after.month, after.movementId, after.reason, after.status, after.revision, after.createdAt, after.updatedAt]);
    else if (!(await client.query(`UPDATE olbia.budget_exclusions SET reason=$3,status=$4,revision=$5,updated_at=$6
      WHERE id=$1::uuid AND owner=$2 AND revision=$7 RETURNING id`, [after.id, owner, after.reason, after.status, after.revision, after.updatedAt, before.revision])).rows.length)
      throw new FinancialPlanError('La exclusión cambió.', 'conflict');
    return;
  }
  validateBudget(after);
  if (!before) await client.query(`INSERT INTO olbia.spending_budgets (id,owner,scope,effective_month,total_mxn_minor,status,revision,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [after.id, owner, after.scope, after.effectiveMonth, after.totalMxnMinor, after.status, after.revision, after.createdAt, after.updatedAt]);
  else {
    if (!(await client.query(`UPDATE olbia.spending_budgets SET total_mxn_minor=$3,status=$4,revision=$5,updated_at=$6
      WHERE id=$1::uuid AND owner=$2 AND revision=$7 RETURNING id`, [after.id, owner, after.totalMxnMinor, after.status, after.revision, after.updatedAt, before.revision])).rows.length)
      throw new FinancialPlanError('El presupuesto cambió.', 'conflict');
    await client.query('DELETE FROM olbia.budget_allocations WHERE budget_id=$1::uuid', [after.id]);
  }
  for (const a of after.allocations) await client.query('INSERT INTO olbia.budget_allocations (budget_id,category_id,amount_mxn_minor) VALUES ($1,$2,$3)', [after.id, a.categoryId, a.amountMxnMinor]);
};
