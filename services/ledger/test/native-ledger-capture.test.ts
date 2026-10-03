import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { buildMsiSchedule } from '@finance/domain';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS,NATIVE_LEDGER_TABLES,LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { runNativeTransaction } from '../src/dsql/store.js';
import { captureObservedEvent,saveNativeCapture,SourceClaimUnavailableError,type NativeCaptureInput } from '../src/dsql/ledger-capture.js';
import { readLedgerDetail } from '../src/dsql/ledger-reads.js';
import { claimIgnoredEmail,setMovementPersonalAmount,setMovementCategory,replaceMovementTags,insertLedgerRevision } from '../src/dsql/ledger-writes.js';
import type { SqlClient,TransactionPool } from '../src/dsql/projection.js';
import type { CaptureSource } from '../src/observed-events.js';

let sql:PGlite,pool:SqlClient & TransactionPool;
const at='2026-10-02T12:00:00.123Z';
const input=(source:CaptureSource='apple_pay_shortcut',token:string=randomUUID()):NativeCaptureInput=>({
  token,captureSource:source,reconciliationAt:at,event:{id:randomUUID(),institution:'santander_mx',eventType:'card_purchase',
    status:'accepted',amount:{amountMinor:10000,currency:'MXN'},merchantRaw:'Original shop',occurredAt:at,receivedAt:at,
    ingestedAt:at,source:source==='apple_pay_shortcut'?{kind:'apple_pay_shortcut',cardRaw:'Original raw card',requestId:token}:
      {bucket:'evidence',key:`original/${token}`,sha256:'a'.repeat(64),contentType:'message/rfc822'},
    parserVersion:`original-${source}`,parseWarnings:[],account:{institution:'santander_mx',accountId:'card',displayName:'Original card',lastFour:'1234'}}});
const save=(value:NativeCaptureInput)=>runNativeTransaction(pool,()=>captureObservedEvent(value));
const snapshot=async()=>Object.fromEntries(await Promise.all([...NATIVE_LEDGER_TABLES,'projection_state','command_receipts'].map(async table=>
  [table,(await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1`)).rows])));
beforeAll(async()=>{
  sql=new PGlite();for(const statement of [...SCHEMA_STATEMENTS,...NATIVE_LEDGER_SCHEMA_STATEMENTS])await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  pool={query:(s,v)=>sql.query<Record<string,unknown>>(s,v),transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
},30_000);
afterAll(()=>sql.close());
beforeEach(async()=>{
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts','projection_state','command_receipts'].map(t=>`olbia.${t}`).join(',')}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

describe('native observed capture and reconciliation',()=>{
  it.each(['email','apple_pay_shortcut','manual','santander_csv','amex_statement','santander_statement'] as const)(
    'creates %s financial facts, primary evidence and source claim without adapter records',async source=>{
      const value=input(source),saved=await save(value);
      expect(saved).toMatchObject({eventId:value.event.id,created:true,reconciled:false,duplicate:false});
      expect(await readLedgerDetail(pool,saved.eventId)).toMatchObject({id:saved.eventId,source:value.event.source,
        amount:value.event.amount,primaryObservationId:saved.observationId,captureSources:[source],observationCount:1,
        observations:[{id:saved.observationId,eventId:saved.eventId,source:value.event.source,amount:value.event.amount}]});
      expect((await sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
      expect((await sql.query('SELECT token FROM olbia.command_receipts')).rows).toEqual([]);
    });
  it('returns the same idempotent result and attaches a defensive retry token without duplicating evidence',async()=>{
    const value=input(),first=await save(value),before=await snapshot();
    expect(await save({...value,event:{...value.event,id:randomUUID(),amount:{amountMinor:20000,currency:'MXN'}}}))
      .toEqual({...first,duplicate:true,created:false});
    expect(await snapshot()).toEqual(before);
    expect(await save({...value,token:'second-token'})).toEqual({...first,duplicate:true,created:false});
    expect((await sql.query('SELECT id FROM olbia.ledger_observations')).rows).toHaveLength(1);
    expect((await sql.query('SELECT token FROM olbia.source_claims')).rows).toHaveLength(2);
  });
  it('reconciles a unique cross-source capture and preserves the primary source and annotations',async()=>{
    const firstInput=input('email'),first=await save(firstInput);
    await runNativeTransaction(pool,async client=>{
      await setMovementCategory(client,first.eventId,'shopping');await replaceMovementTags(client,first.eventId,['retained']);
      await setMovementPersonalAmount(client,first.eventId,0);
      await insertLedgerRevision(client,{id:randomUUID(),movementId:first.eventId,createdAt:at,changedBy:'owner',
        changes:{personalAmountMinor:{previous:null,next:0}},reason:'Explicit personal amount'});
    });
    const second=await save(input());expect(second).toMatchObject({eventId:first.eventId,reconciled:true,created:false});
    const detail=await readLedgerDetail(pool,first.eventId);
    expect(detail).toMatchObject({source:firstInput.event.source,primaryObservationId:first.observationId,
      captureSources:['email','apple_pay_shortcut'],observationCount:2,hasRawEmail:true,categoryId:'shopping',tags:['retained'],personalAmountMinor:0});
    expect(detail!.revisions).toHaveLength(1);expect(detail!.observations).toHaveLength(2);
  });
  it('does not guess between multiple cross-source candidates or collapse a later genuine same-source purchase',async()=>{
    await save(input('email'));
    const later='2026-10-02T12:03:00.123Z';
    await save({...input('email'),reconciliationAt:later,event:{...input('email').event,receivedAt:later,occurredAt:later}});
    const ambiguous=await save(input());expect(ambiguous).toMatchObject({created:true,reconciled:false});
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(3);
  });
  it('uses the same-day and original account checks for delayed email/manual matching',async()=>{
    const manual=input('manual'),first=await save(manual);
    const delayed='2026-10-03T01:00:00.123Z';
    const email={...input('email'),reconciliationAt:delayed,event:{...input('email').event,receivedAt:delayed,occurredAt:at}};
    expect(await save(email)).toMatchObject({eventId:first.eventId,created:false,reconciled:true});
    const differentAccount={...input('santander_csv'),event:{...input('santander_csv').event,
      account:{lastFour:'9999'}}};
    expect(await save(differentAccount)).toMatchObject({created:true,reconciled:false});
    const tomorrow='2026-10-03T12:00:00.123Z';
    expect(await save({...input('manual'),reconciliationAt:tomorrow,event:{...input('manual').event,occurredAt:tomorrow,receivedAt:tomorrow}}))
      .toMatchObject({created:true,reconciled:false});
  });
  it('promotes posted MXN on the same foreign authorization while original USD, tags and first receipt remain intact',async()=>{
    const apple=input();const usd={...apple,event:{...apple.event,status:'pending_foreign',merchantRaw:'Bass Pro Shops',
      amount:{amountMinor:5000,currency:'USD'}}};
    const first=await save(usd);
    await runNativeTransaction(pool,client=>replaceMovementTags(client,first.eventId,['retained']));
    const later='2026-10-02T12:05:00.123Z',email=input('email');
    const posted={...email,reconciliationAt:later,event:{...email.event,receivedAt:later,ingestedAt:later,
      merchantRaw:'BASS PRO STORE LAS VEG',amount:{amountMinor:100000,currency:'MXN'}}};
    expect(await save(posted)).toMatchObject({eventId:first.eventId,created:false,reconciled:true});
    const detail=await readLedgerDetail(pool,first.eventId);
    expect(detail).toMatchObject({amount:{amountMinor:100000,currency:'MXN'},status:'accepted',tags:['retained'],
      receivedAt:at,parserVersion:usd.event.parserVersion,primaryObservationId:first.observationId,source:usd.event.source,hasRawEmail:true});
    expect((detail!.observations as Record<string,unknown>[]).find(o=>o.id===first.observationId))
      .toMatchObject({amount:{amountMinor:5000,currency:'USD'},merchantRaw:'Bass Pro Shops',source:usd.event.source});
  });
  it('links a late foreign authorization to a posted email without replacing canonical MXN',async()=>{
    const email=input('email');const first=await save({...email,event:{...email.event,amount:{amountMinor:100000,currency:'MXN'}}});
    const apple=input();expect(await save({...apple,event:{...apple.event,status:'pending_foreign',amount:{amountMinor:5000,currency:'USD'}}}))
      .toMatchObject({eventId:first.eventId,created:false,reconciled:true});
    expect(await readLedgerDetail(pool,first.eventId)).toMatchObject({status:'accepted',amount:{amountMinor:100000,currency:'MXN'},
      primaryObservationId:first.observationId,source:email.event.source});
  });
  it('does not promote an implausible FX pair or rejected posted charge',async()=>{
    const email=input('email');await save({...email,event:{...email.event,status:'rejected',amount:{amountMinor:100000,currency:'MXN'}}});
    const apple=input();expect(await save({...apple,event:{...apple.event,status:'pending_foreign',amount:{amountMinor:5000,currency:'USD'}}}))
      .toMatchObject({created:true,reconciled:false});
    const unrelated=input('email');expect(await save({...unrelated,event:{...unrelated.event,amount:{amountMinor:1000000,currency:'MXN'}}}))
      .toMatchObject({created:true,reconciled:false});
  });
  it('keeps intentional/unresolved suppression and missing-history claims without inventing a parent',async()=>{
    const email=input('email','unknown-history');
    await sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome)
      VALUES ('email',$1,$2,'unresolved_suppression')`,[email.token,at]);
    await runNativeTransaction(pool,client=>claimIgnoredEmail(client,'intentional',at));
    const missing=input('amex_statement','missing');
    await sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome,historical_target_id)
      VALUES ('amex_statement',$1,$2,'historical_missing',$3)`,[missing.token,at,randomUUID()]);
    const before=await snapshot();
    for(const value of [email,{...email,token:'intentional'},missing])await expect(save(value)).rejects.toBeInstanceOf(SourceClaimUnavailableError);
    expect(await snapshot()).toEqual(before);
    expect(await runNativeTransaction(pool,client=>claimIgnoredEmail(client,'intentional',at))).toBe(false);
  });
  it('rolls back actual movement/evidence rows and the barrier when final claim insertion fails, then retries cleanly',async()=>{
    const value=input(),generation=(await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    let sawRows=false;
    await expect(runNativeTransaction(pool,client=>saveNativeCapture({query:async(s,v)=>{
      if(s.startsWith('INSERT INTO olbia.source_claims')){
        sawRows=(await client.query('SELECT id FROM olbia.ledger_movements')).rows.length===1 &&
          (await client.query('SELECT id FROM olbia.ledger_observations')).rows.length===1;
        throw new Error('Interrupted claim');
      }
      return client.query(s,v);
    }},value))).rejects.toThrow('Interrupted claim');expect(sawRows).toBe(true);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(generation);
    for(const rows of Object.values(await snapshot()))expect(rows).toHaveLength(0);
    expect(await save(value)).toMatchObject({created:true});
  });
  it('creates an automatic MSI plan with the movement and freezes writes while storage is paused',async()=>{
    const value=input('email'),msi=buildMsiSchedule({principalMinor:300000,months:3,startMonth:'2026-10',origin:'amex_auto'});
    const saved=await save({...value,event:{...value.event,institution:'american_express_mx',amount:{amountMinor:300000,currency:'MXN'},msi}});
    expect(await readLedgerDetail(pool,saved.eventId)).toMatchObject({msi});
    await sql.query("UPDATE olbia.runtime_state SET mode='paused' WHERE id='storage'");const before=await snapshot();
    await expect(save(input())).rejects.toMatchObject({name:'MigrationPausedException'});expect(await snapshot()).toEqual(before);
  });
});
