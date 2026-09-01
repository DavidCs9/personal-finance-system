import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { incomeFieldsForMonth } from '../imports/cfdi-nomina-flow.js';
import { monthlyPlanKey, type MonthlyPlanInput } from './monthly-plan.js';

export const getMonthlyPlan = async (owner: string, month: string): Promise<JsonObject> => {
  const monthKey = monthlyPlanKey(owner, month);
  const [result, income] = await Promise.all([
    database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :monthPrefix AND :month',
      ExpressionAttributeNames: {
        '#pk': 'PK',
        '#sk': 'SK',
      },
      ExpressionAttributeValues: {
        ':pk': monthKey.PK,
        ':monthPrefix': 'MONTH#',
        ':month': monthKey.SK,
      },
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: 1,
    })),
    incomeFieldsForMonth(owner, month),
  ]);
  const sourceItem = result.Items?.[0];
  const plan = sourceItem?.payload as JsonObject | undefined;
  const sourceMonth = typeof sourceItem?.month === 'string'
    ? sourceItem.month
    : typeof sourceItem?.SK === 'string' && sourceItem.SK.startsWith('MONTH#')
      ? sourceItem.SK.slice('MONTH#'.length)
      : undefined;
  const upcomingPayments =
    plan && Array.isArray(plan.upcomingPayments) ? plan.upcomingPayments : [];
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

export const saveMonthlyPlan = async (owner: string, month: string, input: MonthlyPlanInput): Promise<JsonObject> => {
  const updatedAt = new Date().toISOString();
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: monthlyPlanKey(owner, month),
    ConsistentRead: true,
  }));
  const previous = existing.Item?.payload as JsonObject | undefined;
  const payload = {
    incomeMinor: typeof previous?.incomeMinor === 'number' ? previous.incomeMinor : 0,
    currency: 'MXN' as const,
    upcomingPayments: input.upcomingPayments,
    updatedAt,
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...monthlyPlanKey(owner, month),
      entityType: 'monthly_plan',
      month,
      owner,
      updatedAt,
      payload,
    },
  }));
  return getMonthlyPlan(owner, month);
};
