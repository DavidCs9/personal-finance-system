import { isValidMonth, InvalidMonthlyPlanError, type MonthlyPlanRecord, type PaymentReconciliationRecord } from './monthly-plan.js';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import type { JsonObject } from '../http/response.js';

export const reconciliationMovementColumns = `m.id::text AS reconciliation_event_id,m.merchant_raw AS reconciliation_merchant,
  COALESCE(m.personal_amount_minor,m.amount_minor) AS reconciliation_amount,m.amount_minor AS reconciliation_gross,
  COALESCE(m.occurred_at,m.received_at) AS reconciliation_occurred_at,m.status AS reconciliation_status,
  m.currency AS reconciliation_currency,
  to_char(COALESCE(m.occurred_at,m.received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM') AS reconciliation_month,
  EXISTS(SELECT 1 FROM olbia.installment_plans ip WHERE ip.movement_id=m.id) AS reconciliation_has_msi`;
const planColumns = `plan.month,plan.updated_at,payment.id,payment.name,payment.amount_mxn_minor,payment.due_day,payment.sort_order,${reconciliationMovementColumns}`;
const chargeJoins = (targetMonth: string) => `LEFT JOIN olbia.planned_payment_charges charge ON charge.month=${targetMonth}
  AND charge.month=payment.month AND charge.payment_id=payment.id
  LEFT JOIN olbia.ledger_movements m ON m.id=charge.movement_id`;
export const reconciliationFromRow = (row: JsonObject, month: string): PaymentReconciliationRecord | undefined => {
  if (!row.reconciliation_event_id) return undefined;
  const invalidReason = !['accepted','needs_review'].includes(String(row.reconciliation_status))
    ? 'El movimiento fue rechazado o ya no cuenta como gasto.'
    : row.reconciliation_currency !== 'MXN' ? 'El movimiento no está registrado en MXN.'
      : !(Number(row.reconciliation_gross)>0) ? 'El movimiento no tiene un importe bruto positivo.'
        : row.reconciliation_has_msi === true ? 'El movimiento tiene un plan MSI.'
          : row.reconciliation_month !== month ? 'El movimiento pertenece a otro mes.' : undefined;
  return { eventId: String(row.reconciliation_event_id), merchantRaw: String(row.reconciliation_merchant),
    amountMinor: Number(row.reconciliation_amount), grossAmountMinor: Number(row.reconciliation_gross),
    occurredAt: new Date(row.reconciliation_occurred_at as string | Date).toISOString(), valid: invalidReason === undefined,
    ...(invalidReason ? { invalidReason } : {}) };
};
export const planReadStatement = `WITH plan AS (
    SELECT month,updated_at FROM olbia.month_plans WHERE owner=$1 AND month <= $2 ORDER BY month DESC LIMIT 1
  ) SELECT ${planColumns} FROM plan LEFT JOIN olbia.planned_payments payment ON payment.month=plan.month
  ${chargeJoins('$2')} ORDER BY payment.sort_order`;
export const planFromRows = (rows: readonly JsonObject[], targetMonth = String(rows[0]?.month)): MonthlyPlanRecord | undefined => rows.length ? ({
  month: rows[0]!.month as string, updatedAt: new Date(rows[0]!.updated_at as string | Date).toISOString(),
  upcomingPayments: rows.filter(row => row.id !== null).map(row => ({ id: row.id as string, name: row.name as string,
    amountMinor: Number(row.amount_mxn_minor), dueDay: row.due_day as number,
    ...(reconciliationFromRow(row,targetMonth) ? { reconciliation: reconciliationFromRow(row,targetMonth) } : {}) })),
}) : undefined;
export const readSqlPlanRecord = async (owner: string, month: string, client: ReadSqlClient = readerPool()): Promise<MonthlyPlanRecord | undefined> => {
  if (!isValidMonth(month)) throw new InvalidMonthlyPlanError('month is invalid.');
  return planFromRows((await client.query(planReadStatement, [owner, month])).rows,month);
};
export const readSqlAllPlanRecords = async (owner: string, client: ReadSqlClient = readerPool()): Promise<readonly MonthlyPlanRecord[]> => {
  const rows = (await client.query(`SELECT ${planColumns} FROM olbia.month_plans plan
    LEFT JOIN olbia.planned_payments payment ON payment.month=plan.month ${chargeJoins('plan.month')}
    WHERE plan.owner=$1 ORDER BY plan.month,payment.sort_order`, [owner])).rows;
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) { const month = row.month as string; groups.set(month, [...(groups.get(month) ?? []), row]); }
  return [...groups.values()].map(rows => planFromRows(rows)!);
};

export { payrollReadStatement, readSqlPayslipsForMonth, readSqlPayslipsForYear, readSqlPayslipRecord } from '../imports/payroll-sql.js';
