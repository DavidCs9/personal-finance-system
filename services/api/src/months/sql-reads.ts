import type { PayslipSummary } from '@finance/domain';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead, type LedgerReadMode } from '../events/read-selection.js';
import type { JsonObject } from '../http/response.js';

export const planningReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_PLANNING_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};

export const readConfiguredPlanning = <T>(query: 'plan' | 'payroll-month' | 'payroll-income' | 'payroll-year' | 'payroll-detail',
  sql: () => Promise<T>, source: () => Promise<T>): Promise<T> => {
  const mode = planningReadMode();
  return selectLedgerRead({ mode, sql, source, report: (outcome, selected) => observe(query, mode, outcome, selected) });
};

export const planReadStatement = `SELECT source_item FROM olbia.monthly_plans
  WHERE source_pk=$1 AND source_sk BETWEEN 'MONTH#' AND $2 ORDER BY source_sk DESC LIMIT 1`;
export const readSqlPlanRecord = async (owner: string, month: string, client: ReadSqlClient = readerPool()): Promise<JsonObject | undefined> =>
  (await client.query(planReadStatement, [`USER#${owner}`, `MONTH#${month}`])).rows[0]?.source_item as JsonObject | undefined;

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
