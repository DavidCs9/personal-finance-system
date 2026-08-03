import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { monthlyPlanKey, type MonthlyPlanInput } from './monthly-plan.js';

export const getMonthlyPlan = async (owner: string, month: string): Promise<JsonObject> => {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: monthlyPlanKey(owner, month),
    ConsistentRead: true,
  }));
  const plan = result.Item?.payload as JsonObject | undefined;
  return plan ? toPublicMonthlyPlan(month, plan, true) : toPublicMonthlyPlan(month, {}, false);
};

export const saveMonthlyPlan = async (owner: string, month: string, input: MonthlyPlanInput): Promise<JsonObject> => {
  const updatedAt = new Date().toISOString();
  const payload = { ...input, updatedAt };
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
  return toPublicMonthlyPlan(month, payload, true);
};

const toPublicMonthlyPlan = (month: string, payload: JsonObject, configured: boolean): JsonObject => ({
  month,
  configured,
  incomeMinor: configured ? payload.incomeMinor : 0,
  currency: 'MXN',
  upcomingPayments: configured && Array.isArray(payload.upcomingPayments) ? payload.upcomingPayments : [],
  ...(configured && typeof payload.updatedAt === 'string' ? { updatedAt: payload.updatedAt } : {}),
});
