import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bootstrapSchema } from '../src/dsql/schema.js';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { smokeNativePush } from '../src/dsql/push-smoke.js';
import { upsertNativePushSubscription, readNativePushMetadata, deleteNativePushSubscription } from '../src/dsql/push.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql:PGlite;const owner='owner',endpoint='https://push.example.test/registered';
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  const client:SqlClient={query:async(s,v)=>{
    if(s.startsWith('AWS IAM GRANT'))return{rows:[]};
    if(s.startsWith('CREATE INDEX ASYNC'))return sql.query(s.replace('INDEX ASYNC','INDEX'),v);
    if(s.startsWith('ALTER TABLE ASYNC')){await sql.query(s.replace('TABLE ASYNC','TABLE'),v);return{rows:[{job_id:'local-validation'}]};}
    return sql.query<Record<string,unknown>>(s,v);
  }};
  const identity=['arn:aws:iam::225989371926:role/permission-test'];
  for(const version of [8,9,10,11,12,13,14,15,16,17,18,19,20]) await sql.query('INSERT INTO olbia.schema_migrations VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING',[version]);
  await bootstrapSchema(client,[],{transactionPool:{transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},applicationRoleArns:identity,
    cutoverRoleArns:identity,readerRoleArns:identity,operationalVerifierRoleArns:identity,storeReaderRoleArns:identity});
  await upsertNativePushSubscription(sql,{owner,endpoint,keys:{p256dh:'original_key',auth:'original_auth'},contentMode:'private',at:'2026-10-03T12:00:00.123Z'});
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
const snapshot=async()=>Object.fromEntries(await Promise.all(['web_push_subscriptions','push_subscriptions','projection_state','application_barrier']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));

it('runs the actual deployed registration/renewal/removal smoke under both writer roles and rolls back existing or empty registries',async()=>{
  const before=await snapshot(),rollback=new Error('Expected full rollback');
  for(const role of ['olbia_application','olbia_cutover']){
    await sql.query(`SET ROLE ${role}`);
    await expect(sql.transaction(async c=>{await smokeNativePush(c as unknown as SqlClient,owner);throw rollback;})).rejects.toBe(rollback);
    await sql.query('RESET ROLE');expect(await snapshot()).toEqual(before);
    await sql.query(`SET ROLE ${role}`);
    await expect(sql.transaction(async c=>{await c.query('DELETE FROM olbia.web_push_subscriptions');await smokeNativePush(c as unknown as SqlClient,owner);throw rollback;})).rejects.toBe(rollback);
    await sql.query('RESET ROLE');expect(await snapshot()).toEqual(before);
  }
});

it('isolates product metadata from endpoint/key fields and keeps all reader roles unable to mutate native or frozen registries',async()=>{
  for(const role of ['olbia_reader','olbia_store_reader','olbia_operational_verifier']){
    await sql.query(`SET ROLE ${role}`);expect(await readNativePushMetadata(sql,owner)).toHaveLength(1);
    if(role==='olbia_reader')for(const column of ['endpoint','auth','p256dh'])await expect(sql.query(`SELECT ${column} FROM olbia.web_push_subscriptions`)).rejects.toMatchObject({code:'42501'});
    await expect(sql.query('DELETE FROM olbia.web_push_subscriptions')).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');
  }
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_projector','olbia_operational_verifier']){
    await sql.query(`SET ROLE ${role}`);
    await expect(sql.query('SELECT * FROM olbia.push_subscriptions')).rejects.toMatchObject({code:'42501'});
    await expect(sql.query('DELETE FROM olbia.push_subscriptions')).rejects.toMatchObject({code:'42501'});
    await expect(sql.query('UPDATE olbia.push_subscriptions SET source_item=source_item')).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');
  }
});

it('permits native renewal while denying changes to registry identity, endpoint, provenance or creation',async()=>{
  const before=await snapshot(),rollback=new Error('Rollback renewals');
  for(const role of ['olbia_application','olbia_cutover']){
    await sql.query(`SET ROLE ${role}`);
    for(const column of ['subscription_id','endpoint','owner','created_at'])await expect(sql.query(`UPDATE olbia.web_push_subscriptions SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
    await expect(sql.transaction(async c=>{
      const row=await upsertNativePushSubscription(c as unknown as SqlClient,{owner,endpoint,keys:{p256dh:'renewed_key',auth:'renewed_auth'},contentMode:'amounts',at:'2026-10-03T12:00:01.456Z'});
      expect(row).toMatchObject({owner,endpoint,createdAt:'2026-10-03T12:00:00.123Z',contentMode:'amounts'});
      await deleteNativePushSubscription(c as unknown as SqlClient,owner,row.subscriptionId);throw rollback;
    })).rejects.toBe(rollback);
    await sql.query('RESET ROLE');expect(await snapshot()).toEqual(before);
  }
});
