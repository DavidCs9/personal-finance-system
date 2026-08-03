import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  cardCyclePushMessage,
  cardRemindersForDay,
  dayInZone,
  dayKeyInZone,
  monthKeyInZone,
} from '@finance/domain';
import { listCards } from './cards.js';
import { loadVapidCredentials, sendPushToSubscriptions } from './push-notify.js';
import { listActivePushSubscriptions, type PushSubscriptionRecord } from './push-subscriptions.js';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const tableName = process.env.METADATA_TABLE_NAME ?? '';
const vapidSecretArn = process.env.VAPID_SECRET_ARN ?? '';
const webAppUrl = process.env.WEB_APP_URL ?? '';

export const handler = async (): Promise<{
  readonly users: number;
  readonly reminders: number;
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
  const dayOfMonth = dayInZone(now);
  const navigateUrl = ensureTrailingSlash(webAppUrl);
  const subscriptions = await listActivePushSubscriptions({ database, tableName });
  if (subscriptions.length === 0) {
    console.info(JSON.stringify({ message: 'Card cycle push skipped; no active subscriptions.' }));
    return { users: 0, reminders: 0, sent: 0, expired: 0, failed: 0 };
  }

  const byOwner = groupByOwner(subscriptions);
  const vapid = await loadVapidCredentials(secrets, vapidSecretArn);

  let users = 0;
  let reminders = 0;
  let sent = 0;
  let expired = 0;
  let failed = 0;

  for (const [owner, ownerSubscriptions] of byOwner) {
    users += 1;
    const cards = await listCards({ database, tableName, owner });
    const due = cardRemindersForDay(cards, month, dayOfMonth);
    if (due.length === 0) continue;

    for (const reminder of due) {
      reminders += 1;
      const result = await sendPushToSubscriptions({
        database,
        tableName,
        vapid,
        subscriptions: ownerSubscriptions,
        buildMessage: (subscription) => cardCyclePushMessage(
          reminder,
          subscription.contentMode,
          navigateUrl,
          dayKey,
        ),
      });
      sent += result.sent;
      expired += result.expired;
      failed += result.failed;
    }

    console.info(JSON.stringify({
      message: 'Card cycle push finished for owner',
      ownerHash: owner.slice(0, 8),
      month,
      dayKey,
      reminders: due.length,
      subscriptions: ownerSubscriptions.length,
    }));
  }

  console.info(JSON.stringify({
    message: 'Card cycle push run complete',
    month,
    dayKey,
    users,
    reminders,
    sent,
    expired,
    failed,
  }));

  return { users, reminders, sent, expired, failed };
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

const ensureTrailingSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);
