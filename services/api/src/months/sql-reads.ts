import { isValidMonth, InvalidMonthlyPlanError, type MonthlyPlanRecord } from './monthly-plan.js';
import type { PayslipSummary } from '@finance/domain';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead, type LedgerReadMode } from '../events/read-selection.js';
import type { JsonObject } from '../http/response.js';

export const planningReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_PLANNING_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};

export const readConfiguredPlanning = <T>(query: 'payroll-month' | 'payroll-income' | 'payroll-year' | 'payroll-detail',
  sql: () => Promise<T>, source: () => Promise<T>): Promise<T> => {
  const mode = planningReadMode();
  return selectLedgerRead({ mode, sql, source, report: (outcome, selected) => observe(query, mode, outcome, selected) });
};

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

// Same source-key intervals as DynamoDB, using the existing primary-key index.
// Payloads (not driver bigint/date columns) preserve the existing domain contract exactly.
export const payrollReadStatement = `SELECT source_item FROM olbia.payroll
  WHERE source_pk=$1 AND source_sk >= $2 AND source_sk < $3 ORDER BY source_sk`;
export const readSqlPayrollRecords = async (owner: string, prefix: string, client: ReadSqlClient = readerPool()): Promise<JsonObject[]> => {
  // Payroll prefixes end in '#' (month) or '-' (year); increment the final ASCII character.
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const result = await client.query(payrollReadStatement, [`USER#${owner}`, prefix, end]);
  return result.rows.map(row => row.source_item as JsonObject);
};

export const payslipsFromRecords = (records: readonly JsonObject[]): PayslipSummary[] => records
  .map(record => record.payload as PayslipSummary | undefined)
  .filter((payload): payload is PayslipSummary => !!payload?.uuid && typeof payload.totalMinor === 'number')
  .sort((a, b) => a.fechaPago.localeCompare(b.fechaPago) || a.uuid.localeCompare(b.uuid));

export const readSqlPayslipsForMonth = async (owner: string, month: string, client?: ReadSqlClient): Promise<readonly PayslipSummary[]> =>
  payslipsFromRecords(await readSqlPayrollRecords(owner, `PAYROLL#${month}#`, client));
export const readSqlPayslipsForYear = async (owner: string, year: string, client?: ReadSqlClient): Promise<readonly PayslipSummary[]> =>
  /^\d{4}$/.test(year) ? payslipsFromRecords(await readSqlPayrollRecords(owner, `PAYROLL#${year}-`, client)) : [];
export const readSqlPayslipRecord = async (owner: string, month: string, uuid: string, client: ReadSqlClient = readerPool()): Promise<JsonObject | undefined> =>
  (await client.query('SELECT source_item FROM olbia.payroll WHERE source_pk=$1 AND source_sk=$2',
    [`USER#${owner}`, `PAYROLL#${month}#${uuid.toUpperCase()}`])).rows[0]?.source_item as JsonObject | undefined;
