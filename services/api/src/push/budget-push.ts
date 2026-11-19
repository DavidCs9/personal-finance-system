import { randomUUID } from 'node:crypto';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { budgetPushAlerts, budgetPushMessage, monthKeyInZone } from '@finance/domain';
import { claimBudgetPushAlerts, finishBudgetPushAlerts, readNativePushSubscriptions } from '@finance/ledger/native-push';
import { applicationSqlClient, assertSqlMutationsAvailable, withSqlTransaction } from '@finance/ledger/sql-runtime';
import { loadVapidCredentials, sendPushToSubscriptions, type VapidCredentials } from '@finance/notify';
import { getBudgetStatus } from '../financial-plans/budgets.js';

const secrets = new SecretsManagerClient({});

export const runBudgetPush = async (owner: string, now: Date, navigate: string, loadVapid: () => Promise<VapidCredentials>) => {
  await assertSqlMutationsAvailable();
  const subscriptions = await readNativePushSubscriptions(applicationSqlClient(), owner);
  const counts = { subscriptions: subscriptions.length, sent: 0, expired: 0, failed: 0 };
  if (!subscriptions.length) return counts;
  const month = monthKeyInZone(now);
  const candidates = budgetPushAlerts(await getBudgetStatus(owner, { month }, now));
  if (!candidates.length) return counts;
  let vapid: VapidCredentials | undefined;

  for (const subscription of subscriptions) {
    const claimedAt = new Date();
    if (monthKeyInZone(claimedAt) !== month) break;
    const claim = randomUUID();
    const scopes = await withSqlTransaction(client => claimBudgetPushAlerts(client, subscription, month, claim, claimedAt, candidates));
    if (!scopes.size) continue;
    const alerts = candidates.filter(alert => scopes.has(alert.scope));
    let delivered = false;
    try {
      vapid ??= await loadVapid();
      const result = await sendPushToSubscriptions({
        vapid, subscriptions: [subscription],
        buildMessage: current => budgetPushMessage(month, alerts, current.contentMode, navigate),
      });
      delivered = result.sent === 1;
      counts.sent += result.sent;
      counts.expired += result.expired;
      counts.failed += result.failed;
    } finally {
      await withSqlTransaction(client => finishBudgetPushAlerts(client, subscription, month, claim, delivered));
    }
  }
  return counts;
};

export const handler = async () => {
  const { AGENT_OWNER: owner, VAPID_SECRET_ARN: secretArn, WEB_APP_URL: webAppUrl } = process.env;
  if (!owner || !secretArn || !webAppUrl) throw new Error('Budget push configuration is missing.');
  const navigate = new URL('/', webAppUrl).href;
  const result = await runBudgetPush(owner, new Date(), navigate, () => loadVapidCredentials(secrets, secretArn));
  console.info(JSON.stringify({ message: 'Budget push evaluation finished', ...result }));
  if (result.failed) throw new Error('Some budget push deliveries failed.');
  return result;
};
