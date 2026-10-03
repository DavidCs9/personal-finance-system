import { withSqlTransaction } from '@finance/ledger/sql-runtime';
import type { JsonObject } from '../http/response.js';
import { incomeFieldsForMonth } from '../imports/cfdi-nomina-flow.js';
import { isValidMonth, InvalidMonthlyPlanError, parseMonthlyPlan, type MonthlyPlanInput, type MonthlyPlanRecord } from './monthly-plan.js';
import { readSqlPlanRecord } from './sql-reads.js';

export const getMonthlyPlanFromReads = async (owner: string, month: string,
  readRecord: (owner: string, month: string) => Promise<MonthlyPlanRecord | undefined>,
  readIncome: typeof incomeFieldsForMonth): Promise<JsonObject> => {
  const [plan, income] = await Promise.all([readRecord(owner, month), readIncome(owner, month)]);
  const sourceMonth = plan?.month;
  const upcomingPayments = plan?.upcomingPayments ?? [];
  return {
    month,
    configured: income.configured,
    incomeMinor: income.incomeMinor,
    depositedMinor: income.depositedMinor,
    estimatedMinor: income.estimatedMinor,
    estimateActive: income.estimateActive,
    provisionalActive: income.provisionalActive,
    provisionalMinor: income.provisionalMinor,
    currency: 'MXN',
    upcomingPayments,
    ...(sourceMonth && sourceMonth !== month ? { inheritedFromMonth: sourceMonth } : {}),
    payslips: income.payslips.map((payslip) => ({
      uuid: payslip.uuid,
      fechaPago: payslip.fechaPago,
      month: payslip.month,
      tipoNomina: payslip.tipoNomina,
      totalMinor: payslip.totalMinor,
      totalPercepcionesMinor: payslip.totalPercepcionesMinor,
      totalDeduccionesMinor: payslip.totalDeduccionesMinor,
      totalOtrosPagosMinor: payslip.totalOtrosPagosMinor,
      lines: payslip.lines,
      ...(payslip.employerName ? { employerName: payslip.employerName } : {}),
      ...(payslip.fechaInicialPago ? { fechaInicialPago: payslip.fechaInicialPago } : {}),
      ...(payslip.fechaFinalPago ? { fechaFinalPago: payslip.fechaFinalPago } : {}),
    })),
    ...(plan && typeof plan.updatedAt === 'string' ? { updatedAt: plan.updatedAt } : {}),
  };
};

export const getMonthlyPlan = (owner: string, month: string): Promise<JsonObject> =>
  getMonthlyPlanFromReads(owner, month, readSqlPlanRecord, incomeFieldsForMonth);

export const saveMonthlyPlan = async (owner: string, month: string, input: MonthlyPlanInput): Promise<JsonObject> => {
  if (!isValidMonth(month)) throw new InvalidMonthlyPlanError('month is invalid.');
  const validated = parseMonthlyPlan(JSON.stringify(input));
  return withSqlTransaction(async client => {
    const parent = (await client.query(`INSERT INTO olbia.month_plans (month,owner,updated_at) VALUES ($1,$2,$3)
      ON CONFLICT (month) DO UPDATE SET updated_at=EXCLUDED.updated_at
      WHERE olbia.month_plans.owner=EXCLUDED.owner RETURNING month`, [month, owner, new Date().toISOString()])).rows[0];
    if (!parent) throw new InvalidMonthlyPlanError('month is invalid.');
    await client.query('DELETE FROM olbia.planned_payments WHERE month=$1', [month]);
    for (const [order, payment] of validated.upcomingPayments.entries()) await client.query(`INSERT INTO olbia.planned_payments
      (month,id,name,amount_mxn_minor,due_day,sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
    [month,payment.id,payment.name,payment.amountMinor,payment.dueDay,order]);
    return getMonthlyPlan(owner, month);
  });
};
