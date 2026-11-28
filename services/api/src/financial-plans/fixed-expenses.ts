import { createHash } from 'node:crypto';
import { FinancialPlanError, isValidMonth, monthKeyInZone } from '@finance/domain';
import { readerPool, withLedgerReadSnapshot, type ReadSqlClient } from '../events/sql-reads.js';
import { effectiveFixedExpenses } from '../months/effective-fixed-expenses.js';
import { parseMonthlyPlan, type PlannedPaymentRecord } from '../months/monthly-plan.js';

type Scope = 'recurring' | 'month';
type Status = 'active' | 'archived' | 'inherit';
type Action = 'create' | 'update' | 'archive' | 'restore' | 'clear_override';

const readMonth = (month: unknown): string => {
  if (typeof month !== 'string' || !isValidMonth(month)) throw new FinancialPlanError('Indica el mes de vigencia YYYY-MM.');
  return month;
};

export const readFixedExpenseCatalog = async (client: ReadSqlClient, owner: string, month: string) => {
  const rows = (await client.query(`WITH requested AS (SELECT $2::text AS month), ${effectiveFixedExpenses('$1')}
    SELECT c.id,c.name,c.amount_mxn_minor,c.due_day,c.status,c.source,c.effective_month,c.operation_id,
      charge.movement_id AS linked_movement_id
    FROM fixed_configurations c
    LEFT JOIN olbia.planned_payment_charges charge ON charge.month=c.month AND charge.payment_id=c.id
    UNION ALL
    SELECT c.id,c.name,c.amount_mxn_minor,c.due_day,c.status,c.source,c.effective_month,c.operation_id,charge.movement_id
    FROM effective_fixed c
    LEFT JOIN olbia.planned_payment_charges charge ON charge.month=c.month AND charge.payment_id=c.id
    WHERE c.source IN ('linked','month')
    UNION ALL
    SELECT v.payment_id,v.name,v.amount_mxn_minor,v.due_day,v.status,'override',v.effective_month,v.operation_id,NULL::uuid
    FROM current_fixed_versions v WHERE v.scope='month'
    ORDER BY id,source`, [owner, month])).rows;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = String(row.id);
    const entries = grouped.get(id) ?? [];
    entries.push(row);
    grouped.set(id, entries);
  }
  const payment = (row: typeof rows[number] | undefined) => row ? {
    id: String(row.id), name: String(row.name), amountMinor: Number(row.amount_mxn_minor), dueDay: Number(row.due_day),
    status: row.status as Status, effectiveMonth: String(row.effective_month), source: String(row.source),
    operationId: row.operation_id ? String(row.operation_id) : null,
  } : null;
  return [...grouped].map(([id, entries]) => {
    const recurring = payment(entries.find(row => row.source === 'recurring' || row.source === 'legacy'));
    const override = payment(entries.find(row => row.source === 'override'));
    const occurrence = payment(entries.find(row => row.source === 'linked' || row.source === 'month'))
      ?? (override?.status === 'inherit' || !override ? recurring : override);
    const linkedMovementId = entries.find(row => row.linked_movement_id)?.linked_movement_id;
    const expectedRevision = createHash('sha256').update(JSON.stringify(entries.map(row => [
      row.id, row.name, String(row.amount_mxn_minor), row.due_day, row.status, row.source, row.effective_month,
      row.operation_id, row.linked_movement_id,
    ]))).digest('hex');
    return { id, recurring, override, occurrence, linkedMovementId: linkedMovementId ? String(linkedMovementId) : null, expectedRevision };
  });
};

export const listFixedExpenses = (owner: string, input: Record<string, unknown>, now = new Date()) => {
  const month = readMonth(input.month ?? monthKeyInZone(now));
  return withLedgerReadSnapshot(async () => ({
    month, currentMonth: monthKeyInZone(now), currency: 'MXN', expenses: await readFixedExpenseCatalog(readerPool(), owner, month),
  }));
};

export const proposeFixedExpense = async (
  client: ReadSqlClient, owner: string, input: Record<string, unknown>, createId: string, now: Date,
) => {
  const month = readMonth(input.month);
  if (month < monthKeyInZone(now)) throw new FinancialPlanError('El mes ya está cerrado.', 'conflict');
  const action = input.action as Action, scope = input.scope as Scope;
  if (!['create', 'update', 'archive', 'restore', 'clear_override'].includes(action) || !['recurring', 'month'].includes(scope)
      || action === 'clear_override' && scope !== 'month')
    throw new FinancialPlanError('Indica una acción y un alcance válidos.');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200)
    throw new FinancialPlanError('Indica un motivo de hasta 200 caracteres.');
  const id = action === 'create' ? createId : input.paymentId;
  if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new FinancialPlanError('Usa el ID exacto del gasto fijo.');
  if (action === 'create' && (input.paymentId !== undefined || input.expectedRevision !== undefined))
    throw new FinancialPlanError('Para modificar un gasto existente usa su ID y revisión con update.');
  const catalog = await readFixedExpenseCatalog(client, owner, month);
  const before = catalog.find(item => item.id === id) ?? null;
  if (action === 'create' && before) throw new FinancialPlanError('Ya existe ese gasto fijo.', 'conflict');
  if (action !== 'create' && !before) throw new FinancialPlanError('Gasto fijo no encontrado en ese mes.', 'not_found');
  if (before && before.expectedRevision !== input.expectedRevision)
    throw new FinancialPlanError('El gasto fijo cambió. Vuelve a consultar el mes.', 'conflict');
  const prior = scope === 'recurring' ? before?.recurring
    : before?.override && before.override.status !== 'inherit' ? before.override : before?.recurring;
  if (action !== 'create' && !prior) throw new FinancialPlanError('El gasto no existe en ese alcance.');
  if (scope === 'month' && before?.linkedMovementId)
    throw new FinancialPlanError('La ocurrencia tiene un cobro vinculado. Conserva la conciliación y usa un cambio recurrente para los meses siguientes.', 'conflict');
  if (action === 'clear_override' && (!before?.override || before.override.status === 'inherit'))
    throw new FinancialPlanError('Este mes no tiene un ajuste que quitar.');
  if ((action === 'update' || action === 'archive') && prior?.status !== 'active'
      || action === 'restore' && prior?.status !== 'archived')
    throw new FinancialPlanError('El estado actual no permite esa acción.', 'conflict');

  const edits = action === 'create' || action === 'update';
  if (!edits && ['name', 'amountMinor', 'dueDay'].some(key => input[key] !== undefined))
    throw new FinancialPlanError('Los datos de programación se cambian con update.');
  let payment: PlannedPaymentRecord;
  try {
    payment = parseMonthlyPlan(JSON.stringify({ upcomingPayments: [{ id,
      name: input.name === undefined ? prior?.name : input.name,
      amountMinor: input.amountMinor === undefined ? prior?.amountMinor : input.amountMinor,
      dueDay: input.dueDay === undefined ? prior?.dueDay : input.dueDay,
    }] })).upcomingPayments[0]!;
  } catch {
    throw new FinancialPlanError('Revisa el nombre, el importe en centavos y el día de pago (1–31).');
  }
  const status: Status = action === 'clear_override' ? 'inherit' : action === 'archive' ? 'archived' : 'active';
  if (action === 'update' && prior?.name === payment.name && prior.amountMinor === payment.amountMinor && prior.dueDay === payment.dueDay)
    throw new FinancialPlanError('La programación ya tiene esos valores.');

  const next = scope === 'recurring' ? (await client.query(`SELECT MIN(effective_month) AS month
    FROM olbia.fixed_expense_versions WHERE owner=$1 AND payment_id=$2 AND scope='recurring' AND effective_month>$3`,
    [owner, id, month])).rows[0]?.month : null;
  const nextEffectiveMonth = next ? String(next) : null;

  const activePayment = status === 'active' ? payment : status === 'inherit' && before?.recurring?.status === 'active' ? before.recurring : null;
  if (activePayment) {
    const result = await client.query(`WITH requested(month) AS (
      SELECT $2::text UNION SELECT month FROM olbia.month_plans WHERE owner=$1 AND $3='recurring' AND month>$2
      UNION SELECT effective_month FROM olbia.fixed_expense_versions WHERE owner=$1 AND $3='recurring' AND effective_month>$2
    ), ${effectiveFixedExpenses('$1')}
    SELECT month FROM (
      SELECT month,id,status,name FROM effective_fixed
      UNION ALL SELECT month,id,status,name FROM fixed_configurations WHERE $3='recurring'
    ) candidates WHERE status='active' AND id<>$4 AND lower(trim(name))=lower(trim($5))
      AND ($6::text IS NULL OR month<$6) ORDER BY month LIMIT 1`, [owner, month, scope, id, activePayment.name, nextEffectiveMonth]);
    if (result.rows.length) throw new FinancialPlanError(`Ya existe un gasto fijo con ese nombre en ${String(result.rows[0]?.month)}.`, 'conflict');
  }
  const after = { ...payment, scope, status, effectiveMonth: month };
  const request = { action, scope, month, reason: input.reason.trim(), ...(action === 'create' ? {} : {
    paymentId: id, expectedRevision: before?.expectedRevision,
  }), ...(edits ? { name: payment.name, amountMinor: payment.amountMinor, dueDay: payment.dueDay } : {}) };
  return { before, after, nextEffectiveMonth, request };
};
