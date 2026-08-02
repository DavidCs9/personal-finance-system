import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  computeMonthSummary,
  dailyBalancePushMessage,
  dayKeyInZone,
  monthKeyInZone,
  type MonthSpendEvent,
  type MonthSummary,
} from '@finance/domain';
import { loadVapidCredentials, sendPushToSubscriptions } from './push-notify.js';
import { listActivePushSubscriptions, type PushSubscriptionRecord } from './push-subscriptions.js';
import { monthlyPlanKey } from './monthly-plan.js';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const tableName = process.env.METADATA_TABLE_NAME ?? '';
const vapidSecretArn = process.env.VAPID_SECRET_ARN ?? '';
const webAppUrl = process.env.WEB_APP_URL ?? '';

export const handler = async (): Promise<{
  readonly users: number;
  readonly sent: number;
  readonly expired: number;
  readonly failed: number;
}> => {
  if (!tableName || !vapidSecretArn || !webAppUrl) {
    throw new Error('METADATA_TABLE_NAME, VAPID_SECRET_ARN, and WEB_APP_URL are required.');
  }

  const now = new Date();
  const month = monthKeyInZone(now);
  const dayKey = dayKeyInZone(now);
  const navigateUrl = ensureTrailingSlash(webAppUrl);
  const subscriptions = await listActivePushSubscriptions({ database, tableName });
  if (subscriptions.length === 0) {
    console.info(JSON.stringify({ message: 'Daily balance push skipped; no active subscriptions.' }));
    return { users: 0, sent: 0, expired: 0, failed: 0 };
  }

  const byOwner = groupByOwner(subscriptions);
  const events = await listAllObservedEvents();
  const vapid = await loadVapidCredentials(secrets, vapidSecretArn);

  let users = 0;
  let sent = 0;
  let expired = 0;
  let failed = 0;

  for (const [owner, ownerSubscriptions] of byOwner) {
    users += 1;
    const summary = await summaryForOwner(owner, month, events, now);
    const result = await sendPushToSubscriptions({
      database,
      tableName,
      vapid,
      subscriptions: ownerSubscriptions,
      buildMessage: (subscription) => dailyBalancePushMessage(
        summary,
        subscription.contentMode,
        navigateUrl,
        dayKey,
      ),
    });
    sent += result.sent;
    expired += result.expired;
    failed += result.failed;
    console.info(JSON.stringify({
      message: 'Daily balance push finished for owner',
      ownerHash: owner.slice(0, 8),
      month,
      dayKey,
      subscriptions: ownerSubscriptions.length,
      sent: result.sent,
      expired: result.expired,
      failed: result.failed,
      incomeConfigured: summary.incomeConfigured,
    }));
  }

  console.info(JSON.stringify({
    message: 'Daily balance push run complete',
    month,
    dayKey,
    users,
    sent,
    expired,
    failed,
  }));

  return { users, sent, expired, failed };
};

export const summaryForOwner = async (
  owner: string,
  month: string,
  events: readonly MonthSpendEvent[],
  now: Date,
): Promise<MonthSummary> => {
  const plan = await loadMonthlyPlan(owner, month);
  return computeMonthSummary({
    events,
    month,
    incomeMinor: plan.incomeMinor,
    incomeConfigured: plan.configured,
    upcomingPaymentsMinor: plan.upcomingMinor,
    now,
  });
};

export const groupByOwner = (
  subscriptions: readonly PushSubscriptionRecord[],
): Map<string, PushSubscriptionRecord[]> => {
  const byOwner = new Map<string, PushSubscriptionRecord[]>();
  for (const subscription of subscriptions) {
    const existing = byOwner.get(subscription.owner) ?? [];
    existing.push(subscription);
    byOwner.set(subscription.owner, existing);
  }
  return byOwner;
};

const loadMonthlyPlan = async (
  owner: string,
  month: string,
): Promise<{ readonly configured: boolean; readonly incomeMinor: number; readonly upcomingMinor: number }> => {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: monthlyPlanKey(owner, month),
    ConsistentRead: true,
  }));
  const payload = result.Item?.payload as {
    readonly incomeMinor?: unknown;
    readonly upcomingPayments?: unknown;
  } | undefined;
  if (!payload || typeof payload.incomeMinor !== 'number' || payload.incomeMinor <= 0) {
    return { configured: false, incomeMinor: 0, upcomingMinor: 0 };
  }
  const upcomingPayments = Array.isArray(payload.upcomingPayments) ? payload.upcomingPayments : [];
  const upcomingMinor = upcomingPayments.reduce((sum: number, payment: unknown) => {
    if (!payment || typeof payment !== 'object') return sum;
    const amountMinor = (payment as { amountMinor?: unknown }).amountMinor;
    return typeof amountMinor === 'number' ? sum + amountMinor : sum;
  }, 0);
  return { configured: true, incomeMinor: payload.incomeMinor, upcomingMinor };
};

const listAllObservedEvents = async (): Promise<readonly MonthSpendEvent[]> => {
  const events: MonthSpendEvent[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': 'EVENTS' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) {
      const payload = item.payload as {
        readonly amount?: { readonly amountMinor?: unknown };
        readonly status?: unknown;
        readonly occurredAt?: unknown;
        readonly receivedAt?: unknown;
      } | undefined;
      if (!payload) continue;
      const amountMinor = payload.amount?.amountMinor;
      if (typeof amountMinor !== 'number' || typeof payload.receivedAt !== 'string') continue;
      events.push({
        amountMinor,
        status: typeof payload.status === 'string' ? payload.status : 'accepted',
        occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : undefined,
        receivedAt: payload.receivedAt,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return events;
};

const ensureTrailingSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);
