import { isValidMonth, InvalidMonthlyPlanError, type MonthlyPlanRecord } from './monthly-plan.js';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import type { JsonObject } from '../http/response.js';

const planColumns = `plan.month,plan.updated_at,payment.id,payment.name,payment.amount_mxn_minor,payment.due_day,payment.sort_order`;
export const planReadStatement = `WITH plan AS (
    SELECT month,updated_at FROM olbia.month_plans WHERE owner=$1 AND month <= $2 ORDER BY month DESC LIMIT 1
  ) SELECT ${planColumns} FROM plan LEFT JOIN olbia.planned_payments payment ON payment.month=plan.month ORDER BY payment.sort_order`;
export const planFromRows = (rows: readonly JsonObject[]): MonthlyPlanRecord | undefined => rows.length ? ({
  month: rows[0]!.month as string, updatedAt: new Date(rows[0]!.updated_at as string | Date).toISOString(),
  upcomingPayments: rows.filter(row => row.id !== null).map(row => ({ id: row.id as string, name: row.name as string,
    amountMinor: Number(row.amount_mxn_minor), dueDay: row.due_day as number })),
}) : undefined;
export const readSqlPlanRecord = async (owner: string, month: string, client: ReadSqlClient = readerPool()): Promise<MonthlyPlanRecord | undefined> => {
  if (!isValidMonth(month)) throw new InvalidMonthlyPlanError('month is invalid.');
  return planFromRows((await client.query(planReadStatement, [owner, month])).rows);
};
export const readSqlAllPlanRecords = async (owner: string, client: ReadSqlClient = readerPool()): Promise<readonly MonthlyPlanRecord[]> => {
  const rows = (await client.query(`SELECT ${planColumns} FROM olbia.month_plans plan
    LEFT JOIN olbia.planned_payments payment ON payment.month=plan.month WHERE plan.owner=$1 ORDER BY plan.month,payment.sort_order`, [owner])).rows;
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) { const month = row.month as string; groups.set(month, [...(groups.get(month) ?? []), row]); }
  return [...groups.values()].map(rows => planFromRows(rows)!);
};

export { payrollReadStatement, readSqlPayslipsForMonth, readSqlPayslipsForYear, readSqlPayslipRecord } from '../imports/payroll-sql.js';
