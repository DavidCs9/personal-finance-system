import { randomUUID } from 'node:crypto';
import type { SqlClient } from './projection.js';
import { decodeNativePushSubscription, upsertNativePushSubscription, deleteNativePushSubscription, readNativePushMetadata, readNativePushSubscriptions } from './push.js';

/** Caller rolls back completely. Exact registration primitive; no secret or transport IO. Empty registries remain valid. */
export const smokeNativePush = async (client: SqlClient, owner: string): Promise<void> => {
  if(!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=16')).rows.length)throw new Error('Native push is not active');
  const row=(await client.query('SELECT * FROM olbia.web_push_subscriptions WHERE owner=$1 ORDER BY subscription_id LIMIT 1',[owner])).rows[0];
  const original=row?decodeNativePushSubscription(row):undefined;
  const input={owner,endpoint:original?.endpoint??`https://push.example.invalid/sql-verification-${randomUUID()}`,
    keys:original?.keys??{p256dh:'verification_key',auth:'verification_auth'},contentMode:'private' as const,at:new Date().toISOString()};
  const first=await upsertNativePushSubscription(client,input),next=await upsertNativePushSubscription(client,{...input,contentMode:'amounts',keys:{p256dh:'renewed_verification_key',auth:'renewed_verification_auth'}});
  if(first.subscriptionId!==next.subscriptionId||next.createdAt!==(original?.createdAt??first.createdAt)||next.contentMode!=='amounts'||next.keys.auth!=='renewed_verification_auth')throw new Error('Native push renewal failed');
  if(!(await readNativePushMetadata(client,owner)).some(r=>r.subscriptionId===next.subscriptionId&&r.contentMode==='amounts'))throw new Error('Native push metadata failed');
  await deleteNativePushSubscription(client,owner,next.subscriptionId);
  if((await readNativePushSubscriptions(client,owner)).some(r=>r.subscriptionId===next.subscriptionId))throw new Error('Native push removal failed');
};
