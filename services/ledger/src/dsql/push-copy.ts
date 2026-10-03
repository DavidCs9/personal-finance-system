import { canonicalJson, projectRows, TABLE_COLUMNS, type SourceItem } from './model.js';
import type { SqlClient, TransactionPool } from './projection.js';
import { pushSubscriptionId, validatePushSubscription, type NativePushSubscription } from './push.js';

type Row=Record<string,unknown>;
const invalid=():never=>{throw new Error('Retained push registry mapping is inconsistent');};
const object=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:invalid();
const text=(v:unknown):string=>typeof v==='string'?v:invalid();
const known=(r:Row,keys:readonly string[])=>{if(Object.keys(r).some(k=>!keys.includes(k)))invalid();};
const iso=(v:unknown):string=>{const at=new Date(text(v));return Number.isFinite(at.getTime())?at.toISOString():invalid();};

/** Old keys/projection parsing exists only in this exact one-time conversion. */
export const preparePushCopy=(retained:readonly Row[]):Row[]=>{
  const endpoints=new Set<string>(),ids=new Set<string>(),owners=new Set<string>();
  const rows=retained.map(r=>{
    const p=object(r.source_item);known(p,['PK','SK','GSI1PK','GSI1SK','entityType','subscriptionId','owner','endpoint','keys','contentMode','active','createdAt','updatedAt']);
    const keys=object(p.keys);known(keys,['p256dh','auth']);
    const input={owner:text(p.owner),endpoint:text(p.endpoint),keys:{p256dh:text(keys.p256dh),auth:text(keys.auth)},contentMode:p.contentMode as NativePushSubscription['contentMode']};
    validatePushSubscription(input);owners.add(input.owner);
    const id=pushSubscriptionId(input.endpoint);
    if(p.subscriptionId!==id||p.PK!==`USER#${input.owner}`||p.SK!==`PUSH#${id}`||p.entityType!=='push_subscription'
      ||p.GSI1PK!=='PUSH_SUBSCRIPTIONS'||p.GSI1SK!==`${input.owner}#${id}`||typeof p.active!=='boolean'
      ||endpoints.has(input.endpoint)||ids.has(id))invalid();
    endpoints.add(input.endpoint);ids.add(id);
    const projected=projectRows({PK:text(p.PK),SK:text(p.SK)},p as SourceItem);
    const normalize=(v:Row)=>Object.fromEntries(Object.entries(v).map(([k,value])=>[k,value==null?value:
      (TABLE_COLUMNS.push_subscriptions as Record<string,string>)[k]==='timestamptz'?new Date(value as string|Date).toISOString():
      (TABLE_COLUMNS.push_subscriptions as Record<string,string>)[k]==='bigint'?String(value):value]));
    if(projected.length!==1||projected[0].table!=='push_subscriptions'||canonicalJson(normalize(projected[0].values))!==canonicalJson(normalize(r)))invalid();
    return {subscription_id:id,owner:input.owner,endpoint:input.endpoint,p256dh:input.keys.p256dh,auth:input.keys.auth,
      content_mode:input.contentMode,active:p.active,created_at:iso(p.createdAt),updated_at:iso(p.updatedAt)};
  });
  if(owners.size>1||rows.length+2>3000||Buffer.byteLength(JSON.stringify(rows))>8*1024*1024)invalid();
  return rows;
};
export const readRetainedPush=(client:SqlClient)=>client.query('SELECT * FROM olbia.push_subscriptions');
export const migratePushSubscriptions=async(pool:TransactionPool):Promise<void>=>{
  await pool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=16')).rows.length)return;
    if((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode!=='sql'
      ||(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows.length!==1)invalid();
    if((await client.query('SELECT 1 FROM olbia.web_push_subscriptions LIMIT 1')).rows.length)invalid();
    const rows=preparePushCopy((await readRetainedPush(client)).rows);
    for(let start=0;start<rows.length;start+=50){
      const batch=rows.slice(start,start+50),columns=Object.keys(batch[0]),values:unknown[]=[];
      const tuples=batch.map(row=>`(${columns.map(column=>{values.push(row[column]);return `$${values.length}`;}).join(',')})`);
      await client.query(`INSERT INTO olbia.web_push_subscriptions (${columns.join(',')}) VALUES ${tuples.join(',')}`,values);
    }
    await client.query('INSERT INTO olbia.schema_migrations VALUES (16,CURRENT_TIMESTAMP)');
  });
};
