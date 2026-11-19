import type { BudgetPushThreshold } from '@finance/domain';
import type { SqlClient } from './projection.js';
import type { NativePushSubscription } from './push.js';

type Subscription = Pick<NativePushSubscription, 'owner' | 'subscriptionId' | 'updatedAt'>;
type Alert = { readonly scope: string; readonly threshold: BudgetPushThreshold };

/** All available scopes for one notification share a lease and can be acknowledged atomically. */
export const claimBudgetPushAlerts = async (
  client: SqlClient, subscription: Subscription, month: string, claimId: string, now: Date, candidates: readonly Alert[],
): Promise<ReadonlySet<string>> => {
  if (!candidates.length) return new Set();
  const claimUntil = new Date(now.getTime() + 3 * 60_000).toISOString();
  const bindings = candidates.map((_, index) => `($${8 + index * 2}::text,$${9 + index * 2}::smallint)`).join(',');
  const rows = (await client.query(`INSERT INTO olbia.budget_push_alerts AS alerts
    (owner,subscription_id,month,scope,delivered_threshold,claim_threshold,claim_id,claim_until)
    SELECT $1,$2,$3,candidate.scope,0,candidate.threshold,$4,$5
      FROM (VALUES ${bindings}) AS candidate(scope,threshold)
      WHERE EXISTS (SELECT 1 FROM olbia.web_push_subscriptions
        WHERE owner=$1 AND subscription_id=$2 AND updated_at=$7 AND active)
    ON CONFLICT (owner,subscription_id,month,scope) DO UPDATE SET
      claim_threshold=EXCLUDED.claim_threshold,claim_id=EXCLUDED.claim_id,claim_until=EXCLUDED.claim_until
    WHERE alerts.delivered_threshold<EXCLUDED.claim_threshold
      AND (alerts.claim_until IS NULL OR alerts.claim_until<=$6)
    RETURNING scope`,
  [subscription.owner, subscription.subscriptionId, month, claimId, claimUntil, now.toISOString(), subscription.updatedAt,
    ...candidates.flatMap(alert => [alert.scope, alert.threshold])])).rows;
  return new Set(rows.map(row => String(row.scope)));
};

export const finishBudgetPushAlerts = async (
  client: SqlClient, subscription: Subscription, month: string, claimId: string, delivered: boolean,
): Promise<void> => {
  await client.query(`UPDATE olbia.budget_push_alerts
    SET delivered_threshold=CASE WHEN $5 THEN claim_threshold ELSE delivered_threshold END,
      claim_threshold=NULL,claim_id=NULL,claim_until=NULL
    WHERE owner=$1 AND subscription_id=$2 AND month=$3 AND claim_id=$4`,
  [subscription.owner, subscription.subscriptionId, month, claimId, delivered]);
};
