import { FinancialPlanError, type ActualIncomeReceipt, type ExpectedIncome, type FinancialGoalState,
  type FinancialGoal, type GoalAllocation, type GoalPayment, type IncomeTermination } from '@finance/domain';
import type { SqlClient } from './projection.js';
export type FinancialWriteKind = 'income' | 'goal' | 'manual_charge' | 'budget';
export interface FinancialWriteOperation {
  readonly operationId: string; readonly owner: string; readonly kind: FinancialWriteKind; readonly action: string;
  readonly entityId: string; readonly createdAt: string; readonly expiresAt: string;
  readonly status: 'pending' | 'applied' | 'failed'; readonly failureCode: string | null;
  readonly before: Record<string, unknown> | null; readonly after: Record<string, unknown>;
  readonly preview: Record<string, unknown>; readonly evidencePreconditions: Record<string, unknown>;
}
type Row = Record<string, unknown>;
const instant = (value: unknown) => new Date(value as string | Date).toISOString();
const day = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const incomeFrom = (row: Row): ExpectedIncome => ({ id: String(row.id), name: String(row.name), employer: row.employer == null ? null : String(row.employer),
  amountMxnMinor: Number(row.amount_mxn_minor), frequency: row.frequency as ExpectedIncome['frequency'],
  paymentDays: [row.payment_day_1, row.payment_day_2].filter(value => value != null).map(Number), expectedPaymentDate: day(row.expected_on),
  startDate: day(row.start_date)!, endDate: day(row.end_date), confidence: row.confidence as ExpectedIncome['confidence'],
  status: row.status as ExpectedIncome['status'], revision: Number(row.revision), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) });
export const readExpectedIncome = async (client: SqlClient, owner: string, id: string): Promise<ExpectedIncome | null> => {
  const row = (await client.query('SELECT * FROM olbia.expected_income WHERE id=$1::uuid AND owner=$2', [id, owner])).rows[0];
  return row ? incomeFrom(row) : null;
};
export const listExpectedIncomeRows = async (client: SqlClient, owner: string, limit: number, cursor?: string): Promise<readonly ExpectedIncome[]> =>
  (await client.query('SELECT * FROM olbia.expected_income WHERE owner=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',
    [owner, cursor ?? null, limit + 1])).rows.map(incomeFrom);
export const readIncomeEvidence = async (client: SqlClient, owner: string, fromDay: string, untilDay: string): Promise<{
  readonly actual: readonly ActualIncomeReceipt[]; readonly terminations: readonly IncomeTermination[];
}> => {
  const actual = (await client.query(`SELECT uuid::text,employer_name,paid_on::text,payroll_type,total_mxn_minor FROM olbia.payslips
    WHERE owner=$1 AND paid_on>=$2::date AND paid_on<$3::date ORDER BY paid_on,uuid LIMIT 2001`, [owner, fromDay, untilDay])).rows;
  if (actual.length > 2000) throw new FinancialPlanError('Demasiados recibos en el rango; consulta un periodo menor.');
  const terminations = (await client.query('SELECT employer_key,ended_on::text FROM olbia.payroll_closures WHERE owner=$1 ORDER BY ended_on,employer_key', [owner])).rows;
  return { actual: actual.map(row => ({ id: String(row.uuid), employer: row.employer_name == null ? null : String(row.employer_name),
    paymentDate: String(row.paid_on), payrollType: String(row.payroll_type), netMxnMinor: Number(row.total_mxn_minor) })),
  terminations: terminations.map(row => ({ employer: String(row.employer_key), endedOn: String(row.ended_on) })) };
};
export const writeExpectedIncome = async (client: SqlClient, owner: string, before: ExpectedIncome | null, after: ExpectedIncome): Promise<void> => {
  const values = [after.id, owner, after.name, after.employer, after.amountMxnMinor, after.frequency,
    after.paymentDays[0] ?? null, after.paymentDays[1] ?? null, after.expectedPaymentDate, after.startDate, after.endDate,
    after.confidence, after.status, after.revision, after.createdAt, after.updatedAt];
  if (!before) await client.query(`INSERT INTO olbia.expected_income
    (id,owner,name,employer,amount_mxn_minor,frequency,payment_day_1,payment_day_2,expected_on,start_date,end_date,confidence,status,revision,created_at,updated_at)
    VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})`, values);
  else if (!(await client.query(`UPDATE olbia.expected_income SET name=$3,employer=$4,amount_mxn_minor=$5,frequency=$6,
    payment_day_1=$7,payment_day_2=$8,expected_on=$9,start_date=$10,end_date=$11,confidence=$12,status=$13,revision=$14,updated_at=$15
    WHERE id=$1 AND owner=$2 AND revision=$16 RETURNING id`, [...values.slice(0, 14), after.updatedAt, before.revision])).rows.length)
    throw new FinancialPlanError('El ingreso cambió; crea otro preview.', 'conflict');
};
const goalFrom = (row: Row): FinancialGoal => ({ id: String(row.id), name: String(row.name), originalBudgetMxnMinor: Number(row.original_budget_mxn_minor),
  totalBudgetMxnMinor: Number(row.total_budget_mxn_minor), targetDate: day(row.target_date), status: row.status as FinancialGoal['status'],
  revision: Number(row.revision), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) });
const allocationFrom = (row: Row): GoalAllocation => ({ id: String(row.id), goalId: String(row.goal_id), name: String(row.name),
  allocatedMxnMinor: Number(row.allocated_mxn_minor), expectedPaymentDate: day(row.expected_payment_date), status: row.status as GoalAllocation['status'], revision: Number(row.revision) });
const paymentFrom = (row: Row): GoalPayment => ({ id: String(row.id), allocationId: String(row.allocation_id), amountMxnMinor: Number(row.amount_mxn_minor),
  paymentDate: day(row.payment_date)!, source: row.source as GoalPayment['source'], ledgerMovementId: row.ledger_movement_id == null ? null : String(row.ledger_movement_id),
  status: row.status as GoalPayment['status'], revision: Number(row.revision), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) });
export const readFinancialGoal = async (client: SqlClient, owner: string, id: string): Promise<FinancialGoalState | null> => {
  const row = (await client.query('SELECT * FROM olbia.financial_goals WHERE id=$1::uuid AND owner=$2', [id, owner])).rows[0];
  if (!row) return null;
  const allocations = (await client.query('SELECT * FROM olbia.goal_allocations WHERE goal_id=$1::uuid ORDER BY id', [id])).rows.map(allocationFrom);
  const payments = (await client.query(`SELECT p.* FROM olbia.goal_payments p JOIN olbia.goal_allocations a ON a.id=p.allocation_id
    WHERE a.goal_id=$1::uuid ORDER BY p.id`, [id])).rows.map(paymentFrom);
  return { goal: goalFrom(row), allocations, payments };
};
export const listFinancialGoalIds = async (client: SqlClient, owner: string, limit: number, status?: string, cursor?: string) =>
  (await client.query(`SELECT id::text FROM olbia.financial_goals WHERE owner=$1 AND ($2::text IS NULL OR status=$2)
    AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4`, [owner, status ?? null, cursor ?? null, limit + 1])).rows.map(row => String(row.id));
export const writeFinancialGoal = async (client: SqlClient, owner: string, before: FinancialGoalState | null, after: FinancialGoalState): Promise<void> => {
  const g = after.goal;
  if (!before) await client.query(`INSERT INTO olbia.financial_goals
    (id,owner,name,original_budget_mxn_minor,total_budget_mxn_minor,target_date,status,revision,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [g.id, owner, g.name, g.originalBudgetMxnMinor, g.totalBudgetMxnMinor, g.targetDate, g.status, g.revision, g.createdAt, g.updatedAt]);
  else if (!(await client.query(`UPDATE olbia.financial_goals SET name=$3,total_budget_mxn_minor=$4,target_date=$5,status=$6,revision=$7,updated_at=$8
    WHERE id=$1 AND owner=$2 AND revision=$9 RETURNING id`, [g.id, owner, g.name, g.totalBudgetMxnMinor, g.targetDate, g.status, g.revision, g.updatedAt, before.goal.revision])).rows.length)
    throw new FinancialPlanError('La meta cambió; crea otro preview.', 'conflict');
  for (const a of after.allocations) {
    const prior = before?.allocations.find(item => item.id === a.id);
    if (!prior) await client.query('INSERT INTO olbia.goal_allocations (id,goal_id,name,allocated_mxn_minor,expected_payment_date,status,revision) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [a.id, g.id, a.name, a.allocatedMxnMinor, a.expectedPaymentDate, a.status, a.revision]);
    else if (a.revision !== prior.revision && !(await client.query(`UPDATE olbia.goal_allocations SET name=$3,allocated_mxn_minor=$4,expected_payment_date=$5,status=$6,revision=$7
      WHERE id=$1 AND goal_id=$2 AND revision=$8 RETURNING id`, [a.id, g.id, a.name, a.allocatedMxnMinor, a.expectedPaymentDate, a.status, a.revision, prior.revision])).rows.length)
      throw new FinancialPlanError('La asignación cambió; crea otro preview.', 'conflict');
  }
  for (const p of after.payments) {
    const prior = before?.payments.find(item => item.id === p.id);
    if (!prior) await client.query(`INSERT INTO olbia.goal_payments (id,allocation_id,amount_mxn_minor,payment_date,source,ledger_movement_id,status,revision,recorded_by,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [p.id, p.allocationId, p.amountMxnMinor, p.paymentDate, p.source, p.ledgerMovementId, p.status, p.revision, owner, p.createdAt, p.updatedAt]);
    else if (p.revision !== prior.revision && !(await client.query(`UPDATE olbia.goal_payments SET allocation_id=$2,amount_mxn_minor=$3,payment_date=$4,source=$5,ledger_movement_id=$6,status=$7,revision=$8,updated_at=$9
      WHERE id=$1 AND revision=$10 RETURNING id`, [p.id, p.allocationId, p.amountMxnMinor, p.paymentDate, p.source, p.ledgerMovementId, p.status, p.revision, p.updatedAt, prior.revision])).rows.length)
      throw new FinancialPlanError('El pago cambió; crea otro preview.', 'conflict');
  }
};
export const readGoalMovements = async (client: SqlClient, ids: readonly string[]): Promise<readonly Row[]> =>
  ids.length ? (await client.query(`SELECT m.id::text,m.status,m.currency,COALESCE(m.personal_amount_minor,m.amount_minor) AS amount_minor,
    to_char(COALESCE(m.occurred_at,m.received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM-DD') AS payment_date,
    EXISTS (SELECT 1 FROM olbia.installment_plans p WHERE p.movement_id=m.id) AS has_msi,
    (SELECT count(*) FROM olbia.ledger_revisions r WHERE r.movement_id=m.id) AS revision_count
    FROM olbia.ledger_movements m WHERE m.id=ANY($1::uuid[])`, [[...ids]])).rows : [];
export const readGoalMovement = async (client: SqlClient, id: string): Promise<Row | null> =>
  (await readGoalMovements(client, [id]))[0] ?? null;
export const paymentMovementUsed = async (client: SqlClient, movementId: string, paymentId: string): Promise<boolean> =>
  (await client.query('SELECT id FROM olbia.goal_payments WHERE ledger_movement_id=$1::uuid AND id<>$2::uuid', [movementId, paymentId])).rows.length > 0;
export const insertFinancialOperation = async (client: SqlClient, operation: FinancialWriteOperation): Promise<void> => {
  await client.query(`INSERT INTO olbia.financial_write_operations
    (operation_id,owner,kind,action,entity_id,created_at,expires_at,status,failure_code,before_state,after_state,preview_facts,evidence_preconditions)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',NULL,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
  [operation.operationId, operation.owner, operation.kind, operation.action, operation.entityId, operation.createdAt, operation.expiresAt,
    operation.before === null ? null : JSON.stringify(operation.before), JSON.stringify(operation.after), JSON.stringify(operation.preview), JSON.stringify(operation.evidencePreconditions)]);
};
export const readFinancialOperation = async (client: SqlClient, owner: string, id: string): Promise<FinancialWriteOperation | null> => {
  const r = (await client.query('SELECT * FROM olbia.financial_write_operations WHERE operation_id=$1::uuid AND owner=$2', [id, owner])).rows[0];
  return r ? { operationId: String(r.operation_id), owner, kind: r.kind as FinancialWriteKind, action: String(r.action), entityId: String(r.entity_id),
    createdAt: instant(r.created_at), expiresAt: instant(r.expires_at), status: r.status as FinancialWriteOperation['status'], failureCode: r.failure_code as string | null,
    before: r.before_state as FinancialWriteOperation['before'], after: r.after_state as FinancialWriteOperation['after'],
    preview: r.preview_facts as FinancialWriteOperation['preview'], evidencePreconditions: r.evidence_preconditions as FinancialWriteOperation['evidencePreconditions'] } : null;
};
export const readFinancialReceipt = async (client: SqlClient, owner: string, id: string): Promise<Record<string, unknown> | null> =>
  ((await client.query('SELECT result FROM olbia.financial_change_receipts WHERE operation_id=$1::uuid AND owner=$2', [id, owner])).rows[0]?.result as Record<string, unknown>) ?? null;
export const appendFinancialReceipt = async (client: SqlClient, operation: FinancialWriteOperation, result: Record<string, unknown>, appliedAt: string,
  movementId?: string): Promise<void> => {
  await client.query(`INSERT INTO olbia.financial_change_receipts (operation_id,owner,kind,income_id,goal_id,movement_id,budget_id,budget_exclusion_id,applied_at,before_state,after_state,result)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)`, [operation.operationId, operation.owner, operation.kind,
    operation.kind === 'income' ? operation.entityId : null, operation.kind === 'goal' ? operation.entityId : null, movementId ?? null, operation.kind === 'budget' && operation.after.entityType === 'budget' ? operation.entityId : null,
    operation.kind === 'budget' && operation.after.entityType === 'exclusion' ? operation.entityId : null, appliedAt,
    operation.before === null ? null : JSON.stringify(operation.before), JSON.stringify(operation.after), JSON.stringify(result)]);
  if (!(await client.query("UPDATE olbia.financial_write_operations SET status='applied' WHERE operation_id=$1 AND owner=$2 AND status='pending' RETURNING operation_id",
    [operation.operationId, operation.owner])).rows.length) throw new FinancialPlanError('La operación cambió; consulta su estado.', 'conflict');
};
export const failFinancialOperation = async (client: SqlClient, owner: string, id: string, failureCode: string): Promise<void> => {
  await client.query("UPDATE olbia.financial_write_operations SET status='failed',failure_code=$3 WHERE operation_id=$1::uuid AND owner=$2 AND status='pending'", [id, owner, failureCode]);
};
export const financialHistory = async (client: SqlClient, owner: string, kind: 'income' | 'goal', id: string) =>
  (await client.query(`SELECT r.operation_id::text,r.applied_at,o.action FROM olbia.financial_change_receipts r
    JOIN olbia.financial_write_operations o ON o.operation_id=r.operation_id
    WHERE r.owner=$1 AND r.${kind === 'income' ? 'income_id' : 'goal_id'}=$2::uuid ORDER BY r.applied_at DESC,r.operation_id LIMIT 50`, [owner, id])).rows
    .map(row => ({ operationId: String(row.operation_id), action: String(row.action), appliedAt: instant(row.applied_at) }));
