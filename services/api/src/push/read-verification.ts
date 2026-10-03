import { createHash } from 'node:crypto';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { listActivePushSubscriptions, listOwnerPushSubscriptions } from '@finance/notify';
import { listPublicPushSubscriptions } from './subscription-reads.js';
import { readerPool, withLedgerVerificationSnapshot, type ReadSqlClient } from '../events/sql-reads.js';
import { samePublicResult } from '../events/read-selection.js';

/** Independent typed registry oracle, never a comparison to frozen current-looking documents. */
const verifyPushSnapshot = async (owner: string, client: ReadSqlClient) => {
  const started=Date.now();let mismatches=0;
  const activated=(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=16')).rows.length===1; mismatches+=Number(!activated);
  const rows=(await client.query('SELECT * FROM olbia.web_push_subscriptions ORDER BY subscription_id COLLATE "C"')).rows;
  const requiredConstraints=['web_push_subscriptions_pkey','web_push_subscriptions_endpoint_key','web_push_subscriptions_subscription_id_check',
    'web_push_subscriptions_owner_check','web_push_subscriptions_endpoint_check','web_push_subscriptions_p256dh_check','web_push_subscriptions_auth_check','web_push_subscriptions_content_mode_check'];
  const constraints=(await client.query("SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace AND conname=ANY($1::text[]) ORDER BY conname",[requiredConstraints])).rows;
  mismatches+=Number(!samePublicResult(constraints,requiredConstraints.sort().map(conname=>({conname,convalidated:true}))));
  const requiredColumns=['subscription_id','owner','endpoint','p256dh','auth','content_mode','active','created_at','updated_at'];
  const columns=(await client.query("SELECT attname,attnotnull FROM pg_attribute WHERE attrelid='olbia.web_push_subscriptions'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attname")).rows;
  mismatches+=Number(!samePublicResult(columns,requiredColumns.sort().map(attname=>({attname,attnotnull:true}))));
  const endpoints=new Set(),identities=new Set();
  for(const r of rows){
    const endpoint=String(r.endpoint),identity=String(r.subscription_id);let https=false;
    try{https=new URL(endpoint).protocol==='https:';}catch{/* Invalid integration value counts as a mismatch. */}
    mismatches+=Number(!https||endpoint.length>2048||identity!==createHash('sha256').update(endpoint).digest('hex')||endpoints.has(endpoint)||identities.has(identity)
      ||![r.created_at,r.updated_at].every(at=>Number.isFinite(new Date(at as string|Date).getTime()))
      ||typeof r.owner!=='string'||!r.owner||typeof r.active!=='boolean'||!['amounts','private'].includes(String(r.content_mode))
      ||!['p256dh','auth'].every(k=>typeof r[k]==='string'&&String(r[k]).length>0&&String(r[k]).length<=256&&/^[A-Za-z0-9_-]+$/.test(String(r[k]))));
    endpoints.add(endpoint);identities.add(identity);
  }
  const facts=rows.filter(r=>r.active===true).map(r=>({subscriptionId:String(r.subscription_id),owner:String(r.owner),endpoint:String(r.endpoint),
    keys:{p256dh:String(r.p256dh),auth:String(r.auth)},contentMode:r.content_mode,active:true,
    createdAt:new Date(r.created_at as string|Date).toISOString(),updatedAt:new Date(r.updated_at as string|Date).toISOString()}));
  const own=facts.filter(r=>r.owner===owner),metadata=own.map(({subscriptionId,contentMode,createdAt,updatedAt})=>({subscriptionId,contentMode,createdAt,updatedAt}));
  mismatches+=Number(!samePublicResult(facts,await listActivePushSubscriptions()));
  mismatches+=Number(!samePublicResult(own,await listOwnerPushSubscriptions({owner})));
  mismatches+=Number(!samePublicResult(metadata,await listPublicPushSubscriptions(owner)));
  return {mode:'native-sql',activated,records:rows.length,active:facts.length,ownerSubscriptions:own.length,validatedConstraints:constraints.filter(r=>r.convalidated===true).length,requiredColumns:columns.filter(r=>r.attnotnull===true).length,
    publicComparisons:1,transportComparisons:2,mismatches,elapsedMs:Date.now()-started};
};
/** Explicit clients belong to the caller's snapshot; ordinary deployment verification owns its bounded snapshot. */
export const verifyNativePushSubscriptions = (owner: string, client?: ReadSqlClient) => client
  ? withStoreClient(client,()=>verifyPushSnapshot(owner,client))
  : withLedgerVerificationSnapshot(()=>verifyPushSnapshot(owner,readerPool()));
