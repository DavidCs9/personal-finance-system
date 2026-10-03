import { createHash } from 'node:crypto';
import type { SqlClient } from './projection.js';

export type PushContentMode = 'amounts' | 'private';
export interface PushSubscriptionKeys { readonly p256dh: string; readonly auth: string }
export interface NativePushSubscription {
  readonly subscriptionId: string; readonly owner: string; readonly endpoint: string;
  readonly keys: PushSubscriptionKeys; readonly contentMode: PushContentMode; readonly active: boolean;
  readonly createdAt: string; readonly updatedAt: string;
}
export type PushSubscriptionMetadata = Pick<NativePushSubscription,'subscriptionId'|'contentMode'|'createdAt'|'updatedAt'>;
export class InvalidPushSubscriptionError extends Error {}
export const pushSubscriptionId = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex');

/** Existing native URL/hash checks also protect internal registration calls before SQL. */
export const validatePushSubscription = (input: Pick<NativePushSubscription,'owner'|'endpoint'|'keys'|'contentMode'>): void => {
  let url: URL;
  try { url = new URL(input.endpoint); } catch { throw new InvalidPushSubscriptionError('endpoint must be an HTTPS URL.'); }
  if (typeof input.endpoint !== 'string' || input.endpoint.length < 1 || input.endpoint.length > 2048 || url.protocol !== 'https:')
    throw new InvalidPushSubscriptionError('endpoint must be an HTTPS URL.');
  if (typeof input.owner !== 'string' || !input.owner) throw new InvalidPushSubscriptionError('Subscription not found.');
  for (const key of ['p256dh','auth'] as const) {
    const value = input.keys?.[key];
    if (typeof value !== 'string' || !value.length || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new InvalidPushSubscriptionError(`keys.${key} must be base64url.`);
  }
  if (!['amounts','private'].includes(input.contentMode)) throw new InvalidPushSubscriptionError('contentMode must be amounts or private.');
};
const iso = (value: unknown): string => new Date(value as string|Date).toISOString();
const metadata = (r: Record<string,unknown>): PushSubscriptionMetadata => ({subscriptionId:String(r.subscription_id),
  contentMode:r.content_mode as PushContentMode,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)});
export const decodeNativePushSubscription = (r: Record<string,unknown>): NativePushSubscription => ({...metadata(r),owner:String(r.owner),
  endpoint:String(r.endpoint),keys:{p256dh:String(r.p256dh),auth:String(r.auth)},active:r.active===true});

/** One statement preserves original creation/identity and atomically renews preferences and keys. */
export const upsertNativePushSubscription = async (client: SqlClient, input: {
  readonly owner: string; readonly endpoint: string; readonly keys: PushSubscriptionKeys; readonly contentMode: PushContentMode; readonly at: string;
}): Promise<NativePushSubscription> => {
  validatePushSubscription(input);
  const rows=(await client.query(`INSERT INTO olbia.web_push_subscriptions
    (subscription_id,owner,endpoint,p256dh,auth,content_mode,active,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7) ON CONFLICT (subscription_id) DO UPDATE SET
    p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,content_mode=EXCLUDED.content_mode,active=true,updated_at=EXCLUDED.updated_at
    WHERE olbia.web_push_subscriptions.owner=EXCLUDED.owner AND olbia.web_push_subscriptions.endpoint=EXCLUDED.endpoint RETURNING *`,[pushSubscriptionId(input.endpoint),input.owner,input.endpoint,
    input.keys.p256dh,input.keys.auth,input.contentMode,input.at])).rows;
  if (!rows[0]) throw new InvalidPushSubscriptionError('Subscription not found.');
  return decodeNativePushSubscription(rows[0]);
};
export const deleteNativePushSubscription = async (client: SqlClient, owner: string, subscriptionId: string): Promise<void> => {
  await client.query('DELETE FROM olbia.web_push_subscriptions WHERE subscription_id=$1 AND owner=$2',[subscriptionId,owner]);
};
export const readNativePushSubscriptions = async (client: SqlClient, owner?: string): Promise<readonly NativePushSubscription[]> =>
  (await client.query(`SELECT * FROM olbia.web_push_subscriptions WHERE active=true${owner===undefined?'':' AND owner=$1'}
    ORDER BY subscription_id COLLATE "C"`,owner===undefined?[]:[owner])).rows.map(decodeNativePushSubscription);
export const readNativePushMetadata = async (client: SqlClient, owner: string): Promise<readonly PushSubscriptionMetadata[]> =>
  (await client.query(`SELECT subscription_id,content_mode,created_at,updated_at FROM olbia.web_push_subscriptions
    WHERE owner=$1 AND active=true ORDER BY subscription_id COLLATE "C"`,[owner])).rows.map(metadata);
