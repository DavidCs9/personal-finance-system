import { PGlite } from '@electric-sql/pglite';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as connection from '../../ledger/src/dsql/connection.js';
import { SCHEMA_STATEMENTS } from '../../ledger/test/helpers/migration-schema.js';
import { NATIVE_PUSH_SCHEMA_STATEMENT } from '../../ledger/src/dsql/push-schema.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import { savePushSubscription, deletePushSubscription, listActivePushSubscriptions, listOwnerPushSubscriptions, InvalidPushSubscriptionError } from '../src/push-subscriptions.js';
import { notifyObservedPurchasePush, sendPushToSubscriptions } from '../src/push-notify.js';

let sql:PGlite,interrupt=false,retry=false;const attempts:string[]=[];
const keys={p256dh:'example_key',auth:'example_auth'},owner='owner',endpoint='https://push.example.test/subscription';
const vapid={...webpush.generateVAPIDKeys(),subject:'mailto:test@example.test'};
const purchase={id:'synthetic-purchase',merchantRaw:'Test',amount:{amountMinor:100,currency:'MXN'},institution:'santander_mx'};
const snapshot=async()=>Object.fromEntries(await Promise.all(['web_push_subscriptions','push_subscriptions','projection_state','application_barrier']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));
const register=(suffix='',contentMode:'private'|'amounts'='private')=>savePushSubscription({owner,endpoint:endpoint+suffix,keys,contentMode});
beforeAll(async()=>{sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,NATIVE_PUSH_SCHEMA_STATEMENT])await sql.query(s);},30_000);
afterAll(()=>sql.close());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});
beforeEach(async()=>{
  await sql.exec('TRUNCATE olbia.web_push_subscriptions,olbia.push_subscriptions,olbia.projection_state');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");interrupt=false;retry=false;attempts.length=0;
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  const transaction=async(fn:(c:SqlClient)=>Promise<unknown>)=>{
    const attempt=()=>sql.transaction(c=>fn({query:async(s,v)=>{
      const result=await c.query<Record<string,unknown>>(s,v);
      if(s.startsWith('INSERT INTO olbia.web_push_subscriptions')){
        attempts.push(String(v?.[6]));if(interrupt){interrupt=false;throw new Error('Interrupted registry mutation');}
      }return result;
    }}));
    if(retry){retry=false;interrupt=true;try{await attempt();}catch{vi.setSystemTime(new Date('2026-10-03T12:00:01.000Z'));}}
    return attempt();
  };
  vi.spyOn(connection,'createPool').mockReturnValue({query:(s:string,v?:unknown[])=>sql.query(s,v),transaction} as never);
  vi.spyOn(console,'info').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
});

it('registers and renews native rows, preserves creation/ownership and removes only the authorized endpoint',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  const first=await register();vi.setSystemTime(new Date('2026-10-03T12:00:01.000Z'));
  const renewed=await register('','amounts');expect(renewed).toMatchObject({subscriptionId:first.subscriptionId,createdAt:first.createdAt,updatedAt:'2026-10-03T12:00:01.000Z',contentMode:'amounts'});
  expect(await listActivePushSubscriptions()).toEqual([renewed]);expect(await listOwnerPushSubscriptions({owner})).toEqual([renewed]);
  expect(await listOwnerPushSubscriptions({owner:'other'})).toEqual([]);
  await expect(savePushSubscription({owner:'other',endpoint,keys,contentMode:'private'})).rejects.toBeInstanceOf(InvalidPushSubscriptionError);
  await deletePushSubscription({owner:'other',subscriptionId:first.subscriptionId});expect(await listActivePushSubscriptions()).toEqual([renewed]);
  await deletePushSubscription({owner,subscriptionId:first.subscriptionId});expect(await listActivePushSubscriptions()).toEqual([]);
  expect((await sql.query('SELECT * FROM olbia.push_subscriptions')).rows).toEqual([]);expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual([]);
});

it('uses actual native subscription input for observed-purchase delivery and skips secret/transport IO for an empty registry',async()=>{
  const secretSend=vi.fn(async()=>({SecretString:JSON.stringify(vapid)})),transport=vi.fn(async(_subscription:unknown,_payload:string)=>({statusCode:201}));
  const input={secrets:{send:secretSend} as never,vapidSecretArn:'synthetic-vapid',navigateUrl:'https://example.test',purchase,send:transport as never};
  expect(await notifyObservedPurchasePush(input)).toEqual({sent:0,expired:0,failed:0});expect(secretSend).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
  await register();expect(await notifyObservedPurchasePush(input)).toEqual({sent:1,expired:0,failed:0});
  expect(secretSend).toHaveBeenCalledTimes(1);expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]?.[0]).toEqual({endpoint,keys});
  expect(JSON.parse(String(transport.mock.calls[0]?.[1])).notification.body).toBe('Hay un movimiento nuevo.');
});

it('removes native 404/410 endpoints, retains failed/successful endpoints and preserves both message privacy modes',async()=>{
  for(const suffix of ['/ok','/404','/410','/fail'])await register(suffix,suffix==='/ok'?'amounts':'private');
  const transport=vi.fn(async(sub:{endpoint:string})=>{const code=sub.endpoint.endsWith('/404')?404:sub.endpoint.endsWith('/410')?410:sub.endpoint.endsWith('/fail')?503:201;
    if(code!==201)throw {statusCode:code};return {statusCode:201};});
  expect(await sendPushToSubscriptions({vapid,subscriptions:await listActivePushSubscriptions(),buildMessage:sub=>({title:'Olbia',body:sub.contentMode,tag:'test',navigate:'https://example.test'}),send:transport as never}))
    .toEqual({sent:1,expired:2,failed:1});
  expect((await listActivePushSubscriptions()).map(s=>s.endpoint).sort()).toEqual([endpoint+'/fail',endpoint+'/ok']);
  expect((await sql.query('SELECT * FROM olbia.push_subscriptions')).rows).toEqual([]);
});

it('rolls back an interrupted renewal/barrier and reuses the allocated renewal time on a rolled-back connector attempt',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  await register();const before=await snapshot();interrupt=true;
  await expect(register('','amounts')).rejects.toThrow('Interrupted registry mutation');expect(await snapshot()).toEqual(before);
  attempts.length=0;retry=true;const renewed=await register('','amounts');
  expect(attempts).toEqual(['2026-10-03T12:00:00.000Z','2026-10-03T12:00:00.000Z']);expect(renewed.updatedAt).toBe('2026-10-03T12:00:00.000Z');
});

it('validates before native mutations and fails closed without subscription fallback on SQL outages',async()=>{
  await expect(savePushSubscription({owner,endpoint:'http://invalid.example',keys,contentMode:'private'})).rejects.toBeInstanceOf(InvalidPushSubscriptionError);expect(attempts).toEqual([]);
  await register();const query=vi.spyOn(sql,'query').mockRejectedValue(Object.assign(new Error('private endpoint/key'),{code:'08006'}));
  await expect(listActivePushSubscriptions()).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
  expect(query).toHaveBeenCalledTimes(1);
});
