import { PGlite } from '@electric-sql/pglite';
import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/store.js';
import { NATIVE_PUSH_SCHEMA_STATEMENT, nativePushMetadataGrant, nativePushReadGrant, nativePushWriteGrants } from '../src/dsql/push-schema.js';
import { migratePushSubscriptions, preparePushCopy } from '../src/dsql/push-copy.js';
import { pushSubscriptionId, readNativePushMetadata, readNativePushSubscriptions, upsertNativePushSubscription, deleteNativePushSubscription } from '../src/dsql/push.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';

let sql:PGlite,store:OlbiaSqlStore,pool:TransactionPool;
const at='2026-09-01T12:00:00.123Z',endpoint='https://push.example.test/subscription',id=pushSubscriptionId(endpoint);
const original={PK:'USER#owner',SK:`PUSH#${id}`,GSI1PK:'PUSH_SUBSCRIPTIONS',GSI1SK:`owner#${id}`,entityType:'push_subscription',
  subscriptionId:id,owner:'owner',endpoint,keys:{p256dh:'original_key',auth:'original_auth'},contentMode:'private' as const,active:true,createdAt:at,updatedAt:at};
const snapshot=async()=>Object.fromEntries(await Promise.all(['projection_state','push_subscriptions','web_push_subscriptions','application_barrier','schema_migrations']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));
beforeAll(async()=>{
  sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,NATIVE_PUSH_SCHEMA_STATEMENT])await sql.query(s);
  pool={transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};
  store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),...pool},'metadata');
  for(const role of ['push_product','push_application']){
    await sql.query(`CREATE ROLE ${role}`);await sql.query(`GRANT USAGE ON SCHEMA olbia TO ${role}`);
  }
  await sql.query(nativePushMetadataGrant('push_product'));await sql.query(nativePushReadGrant('push_application'));
  for(const s of nativePushWriteGrants('push_application'))await sql.query(s);
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
beforeEach(async()=>{
  await sql.query('RESET ROLE');await sql.exec('TRUNCATE olbia.web_push_subscriptions,olbia.push_subscriptions,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=16');await sql.query('INSERT INTO olbia.schema_migrations VALUES (15,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});
const seed=()=>store.send(new PutCommand({TableName:'metadata',Item:original}));
const register=(owner='owner',contentMode:'amounts'|'private'='amounts')=>upsertNativePushSubscription(sql,{owner,endpoint,keys:{p256dh:'renewed_key',auth:'renewed_auth'},contentMode,at:'2026-10-03T12:00:00.456Z'});

it('copies exact keys/preferences/identity/creation, retains recovery and resumes activated copies',async()=>{
  await seed();const old=(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.push_subscriptions')).rows;
  await migratePushSubscriptions(pool);expect((await sql.query<Record<string,unknown>>('SELECT * FROM olbia.push_subscriptions')).rows).toEqual(old);
  expect(await readNativePushSubscriptions(sql)).toEqual([{subscriptionId:id,owner:'owner',endpoint,keys:original.keys,contentMode:'private',active:true,createdAt:at,updatedAt:at}]);
  expect(await readNativePushMetadata(sql,'owner')).toEqual([{subscriptionId:id,contentMode:'private',createdAt:at,updatedAt:at}]);
  expect(await readNativePushMetadata(sql,'other')).toEqual([]);
  await register();await migratePushSubscriptions(pool);expect((await readNativePushSubscriptions(sql))[0]?.keys.p256dh).toBe('renewed_key');
  expect((await sql.query<Record<string,unknown>>('SELECT * FROM olbia.push_subscriptions')).rows).toEqual(old);
  await expect(store.send(new DeleteCommand({TableName:'metadata',Key:{PK:original.PK,SK:original.SK}}))).rejects.toMatchObject({name:'MigrationPausedException'});
});

it('renews atomically without changing identity/creation, rejects foreign ownership and supports native removal',async()=>{
  await seed();await migratePushSubscriptions(pool);
  const saved=await register();expect(saved).toMatchObject({subscriptionId:id,endpoint,owner:'owner',createdAt:at,contentMode:'amounts',keys:{p256dh:'renewed_key',auth:'renewed_auth'}});
  const before=(await sql.query('SELECT * FROM olbia.web_push_subscriptions')).rows;
  await expect(register('other')).rejects.toThrow('Subscription not found.');expect((await sql.query('SELECT * FROM olbia.web_push_subscriptions')).rows).toEqual(before);
  await deleteNativePushSubscription(sql,'other',id);expect(await readNativePushSubscriptions(sql)).toHaveLength(1);
  await deleteNativePushSubscription(sql,'owner',id);expect(await readNativePushSubscriptions(sql)).toEqual([]);
  await migratePushSubscriptions(pool);expect(await readNativePushSubscriptions(sql)).toEqual([]);
});

it('permits metadata-only product reads and constrained actual application registration/renewal/deletion',async()=>{
  await seed();await migratePushSubscriptions(pool);
  await sql.query('SET ROLE push_product');expect(await readNativePushMetadata(sql,'owner')).toHaveLength(1);
  for(const column of ['endpoint','p256dh','auth'])await expect(sql.query(`SELECT ${column} FROM olbia.web_push_subscriptions`)).rejects.toMatchObject({code:'42501'});
  await expect(register()).rejects.toMatchObject({code:'42501'});await expect(deleteNativePushSubscription(sql,'owner',id)).rejects.toMatchObject({code:'42501'});
  await sql.query('SET ROLE push_application');expect(await register()).toMatchObject({createdAt:at});
  for(const column of ['subscription_id','endpoint','owner','created_at'])await expect(sql.query(`UPDATE olbia.web_push_subscriptions SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
  await deleteNativePushSubscription(sql,'owner',id);expect(await readNativePushSubscriptions(sql)).toEqual([]);
});

it('rejects malformed/unknown/projected originals and partial native state without activating',async()=>{
  await seed();const old=(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.push_subscriptions')).rows;
  for(const row of [{...old[0],active:false},{...old[0],source_item:{...original,extra:'unrepresentable'}},
    {...old[0],source_item:{...original,keys:{...original.keys,extra:'unrepresentable'}}},{...old[0],source_item:{...original,subscriptionId:'0'.repeat(64)}}])
    expect(()=>preparePushCopy([row])).toThrow();
  await register();const before=await snapshot();await expect(migratePushSubscriptions(pool)).rejects.toThrow('inconsistent');expect(await snapshot()).toEqual(before);
});

it('rolls back every inserted row, marker and barrier if atomic conversion is interrupted',async()=>{
  await seed();const before=await snapshot();
  const failing:TransactionPool={transaction:fn=>sql.transaction(c=>fn({query:async(s,v)=>{
    const result=await c.query<Record<string,unknown>>(s,v);if(s.startsWith('INSERT INTO olbia.web_push_subscriptions'))throw new Error('Interrupted atomic copy');return result;
  }}))};
  await expect(migratePushSubscriptions(failing)).rejects.toThrow('Interrupted atomic copy');expect(await snapshot()).toEqual(before);
  await migratePushSubscriptions(pool);expect(await readNativePushSubscriptions(sql)).toHaveLength(1);
});

it('supports an empty registry and validates HTTPS/key formats before attempting SQL',async()=>{
  await migratePushSubscriptions(pool);expect(await readNativePushSubscriptions(sql)).toEqual([]);
  for(const fields of [{endpoint:'http://push.example.test'},{keys:{p256dh:'invalid=',auth:'original_auth'}},{contentMode:'unsupported'}])
    await expect(upsertNativePushSubscription(sql,{owner:'owner',endpoint,keys:original.keys,contentMode:'private',at,...fields} as never)).rejects.toThrow();
  expect(await readNativePushSubscriptions(sql)).toEqual([]);
  const mixed=' HTTPS://push.example.test/mixed ';
  expect(await upsertNativePushSubscription(sql,{owner:'owner',endpoint:mixed,keys:original.keys,contentMode:'private',at})).toMatchObject({endpoint:mixed,subscriptionId:pushSubscriptionId(mixed)});
});
