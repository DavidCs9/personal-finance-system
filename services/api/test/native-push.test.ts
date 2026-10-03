import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_PUSH_SCHEMA_STATEMENT, nativePushMetadataGrant } from '../../ledger/src/dsql/push-schema.js';
import { upsertNativePushSubscription } from '@finance/ledger/native-push';
import { listPublicPushSubscriptions } from '../src/push/subscription-reads.js';
import { verifyNativePushSubscriptions } from '../src/push/read-verification.js';
import type { ReadSqlClient } from '../src/events/sql-reads.js';

let sql:PGlite;
const endpoint='https://push.example.test/subscription',at='2026-10-03T12:00:00.123Z';
const seed=()=>upsertNativePushSubscription(sql,{owner:'owner',endpoint,keys:{p256dh:'private_key',auth:'private_auth'},contentMode:'private',at});
beforeAll(async()=>{
  sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,NATIVE_PUSH_SCHEMA_STATEMENT])await sql.query(s);
  await sql.query('CREATE ROLE push_product');await sql.query('GRANT USAGE ON SCHEMA olbia TO push_product');await sql.query(nativePushMetadataGrant('push_product'));
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (16,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
},30_000);
afterAll(()=>sql.close());afterEach(async()=>{await sql.query('RESET ROLE');vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{await sql.query('RESET ROLE');await sql.query('TRUNCATE olbia.web_push_subscriptions');});

it('reads actual public metadata with the narrow SQL role across every old read-mode setting and no document fallback',async()=>{
  const saved=await seed();await sql.query('SET ROLE push_product');
  for(const mode of ['dynamodb','shadow','guarded-sql']){
    vi.stubEnv('DSQL_OPERATIONAL_READ_MODE',mode);
    expect(await withStoreClient(sql,()=>listPublicPushSubscriptions('owner'))).toEqual([{subscriptionId:saved.subscriptionId,contentMode:'private',createdAt:at,updatedAt:at}]);
    expect(await withStoreClient(sql,()=>listPublicPushSubscriptions('other'))).toEqual([]);
  }
  for(const key of ['endpoint','p256dh','auth'])await expect(sql.query(`SELECT ${key} FROM olbia.web_push_subscriptions`)).rejects.toMatchObject({code:'42501'});
});

it('verifies independent native identities/constraints/public metadata/transport facts after renewal and removal',async()=>{
  const saved=await seed();expect(await verifyNativePushSubscriptions('owner',sql)).toMatchObject({activated:true,records:1,active:1,validatedConstraints:8,requiredColumns:9,mismatches:0});
  await upsertNativePushSubscription(sql,{owner:'owner',endpoint,keys:{p256dh:'renewed_key',auth:'renewed_auth'},contentMode:'amounts',at:'2026-10-03T12:00:01.456Z'});
  expect(await verifyNativePushSubscriptions('owner',sql)).toMatchObject({records:1,mismatches:0});
  await sql.query('UPDATE olbia.web_push_subscriptions SET active=false WHERE subscription_id=$1',[saved.subscriptionId]);
  expect(await verifyNativePushSubscriptions('owner',sql)).toMatchObject({records:1,active:0,mismatches:0});
  await sql.query('DELETE FROM olbia.web_push_subscriptions');expect(await verifyNativePushSubscriptions('owner',sql)).toMatchObject({records:0,mismatches:0});
});

it('detects native digest corruption and missing database constraints independently',async()=>{
  await seed();await sql.query("UPDATE olbia.web_push_subscriptions SET subscription_id=$1",['0'.repeat(64)]);
  expect((await verifyNativePushSubscriptions('owner',sql)).mismatches).toBeGreaterThan(0);
  await sql.query('TRUNCATE olbia.web_push_subscriptions');await seed();
  const rollback=new Error('Rollback corrupted constraint');
  await expect(sql.transaction(async c=>{
    await c.query('ALTER TABLE olbia.web_push_subscriptions DROP CONSTRAINT web_push_subscriptions_endpoint_key');
    expect((await verifyNativePushSubscriptions('owner',c as unknown as ReadSqlClient)).mismatches).toBeGreaterThan(0);throw rollback;
  })).rejects.toBe(rollback);
  expect((await verifyNativePushSubscriptions('owner',sql)).mismatches).toBe(0);
});

it('sanitizes SQL failure and propagates it without returning stale metadata',async()=>{
  const query=vi.fn(async()=>{throw Object.assign(new Error('private endpoint/key'),{code:'08006'});});
  await expect(withStoreClient({query},()=>listPublicPushSubscriptions('owner'))).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
  expect(query).toHaveBeenCalledTimes(1);
});
