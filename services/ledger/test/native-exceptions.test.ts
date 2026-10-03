import { PGlite } from '@electric-sql/pglite';
import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { NATIVE_EXCEPTION_SCHEMA_STATEMENTS } from '../src/dsql/exception-schema.js';
import { insertReviewException,saveClaimedReviewException,readReviewException,listReviewExceptions,requestReviewRetry,readLatestRetry,
  resolveRetryAttempt,completeRetryAttempt,failRetryAttempt,discardReviewException,pendingReviewRetries,markReviewRetryDispatched,expireReviewClaims,
  requireNativeExceptions,publicRetry,type ReviewException } from '../src/dsql/exception.js';
import type { SqlClient } from '../src/dsql/projection.js';
let sql:PGlite,client:SqlClient;
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const movement='10000000-0000-4000-8000-000000000001',secondMovement='10000000-0000-4000-8000-000000000002';
const at='2026-10-03T12:00:00.000Z',later='2026-10-03T12:01:00.000Z',latest='2026-10-03T12:02:00.000Z';
const source={bucket:'evidence',key:'original.eml',sha256:'a'.repeat(64),contentType:'message/rfc822' as const};
const original:ReviewException={id,receivedAt:at,reason:'parser_failed',details:'Preserved parser evidence',source,sourceToken:'b'.repeat(64)};
const request='20000000-0000-4000-8000-000000000001',secondRequest='20000000-0000-4000-8000-000000000002';
const transaction=<T>(fn:(client:SqlClient)=>Promise<T>)=>sql.transaction(c=>fn(c as unknown as SqlClient));
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  for(const movementId of [movement,secondMovement])await sql.query(`INSERT INTO olbia.ledger_movements
    (id,primary_observation_id,institution,event_type,status,amount_minor,currency,merchant_raw,received_at,ingested_at,reconciliation_at,account_present)
    VALUES ($1,$1,'santander_mx','card_purchase','accepted',100,'MXN','Original shop',$2,$2,$2,false)`,[movementId,at]);
  for(const s of NATIVE_EXCEPTION_SCHEMA_STATEMENTS)await sql.query(s);
  client={query:(s,v)=>sql.query<Record<string,unknown>>(s,v)};
},30_000);
afterAll(()=>sql.close());
beforeEach(async()=>{await sql.exec('TRUNCATE olbia.ingestion_retry_attempts,olbia.ingestion_review_claims,olbia.ingestion_review_exceptions');await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');});
it('requires native activation with no false authority',async()=>{
  await expect(requireNativeExceptions(client)).rejects.toMatchObject({name:'MigrationPausedException'});
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');await requireNativeExceptions(client);
});
it('persists one claimed original and deduplicates the same source/extractor/reason without an orphan',async()=>{
  expect(await transaction(c=>saveClaimedReviewException(c,original,'parser-v1',at))).toBe(true);
  expect(await transaction(c=>saveClaimedReviewException(c,{...original,id:other},'parser-v1',later))).toBe(false);
  expect(await readReviewException(client,id)).toEqual(original);expect(await readReviewException(client,other)).toBeUndefined();
  expect((await sql.query('SELECT exception_id FROM olbia.ingestion_review_claims')).rows).toEqual([{exception_id:id}]);
  expect(await transaction(c=>saveClaimedReviewException(c,{...original,id:other},'parser-v2',later))).toBe(true);
});
it('rejects claims that name the wrong source or reason and missing financial completion targets',async()=>{
  await insertReviewException(client,original);
  await expect(sql.query('INSERT INTO olbia.ingestion_review_claims VALUES ($1,$2,$3,$4,$5,NULL)',['c'.repeat(64),'parser-v1',original.reason,id,at])).rejects.toMatchObject({code:'23503'});
  await requestReviewRetry(client,id,at,'owner',request);
  await expect(completeRetryAttempt(client,{exceptionId:id,requestedAt:at},other,later)).rejects.toMatchObject({code:'23503'});
  expect((await readLatestRetry(client,id))?.completedAt).toBeUndefined();
});
it('keeps a queued attempt unique and permits a new request only after failure',async()=>{
  await insertReviewException(client,original);const first=await requestReviewRetry(client,id,at,'owner',request);
  await expect(requestReviewRetry(client,id,later,'owner',secondRequest)).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
  await failRetryAttempt(client,first,'Original failure',later);
  await expect(requestReviewRetry(client,id,at,'owner',secondRequest)).rejects.toMatchObject({code:'23505'});
  const second=await requestReviewRetry(client,id,latest,'owner',secondRequest);
  expect((await readLatestRetry(client,id))?.requestId).toBe(secondRequest);
  const job={receivedAt:at,source,retryExceptionId:id};
  await expect(resolveRetryAttempt(client,job)).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
  expect(await resolveRetryAttempt(client,{...job,retryRequestedAt:at})).toMatchObject({requestId:request,failedAt:later});
  expect(await resolveRetryAttempt(client,{...job,retryRequestedAt:latest})).toEqual(second);
  await completeRetryAttempt(client,first,movement,latest);
  expect(await readLatestRetry(client,id)).toEqual(second);
});
it('retains failure facts on a valid completion, freezes completed evidence and ignores later failed duplicates',async()=>{
  await insertReviewException(client,original);const ref=await requestReviewRetry(client,id,at,'owner',request);
  await failRetryAttempt(client,ref,'Earlier parser failure',later);await completeRetryAttempt(client,ref,movement,latest);
  const before=await readLatestRetry(client,id);expect(publicRetry(before!)).toMatchObject({status:'completed',eventId:movement,failedAt:later,details:'Earlier parser failure'});
  await completeRetryAttempt(client,ref,movement,'2026-10-03T12:03:00.000Z');await failRetryAttempt(client,ref,'Late duplicate failure','2026-10-03T12:03:00.000Z');
  expect(await readLatestRetry(client,id)).toEqual(before);
  await expect(requestReviewRetry(client,id,'2026-10-03T12:03:00.000Z','owner',secondRequest)).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
  await expect(completeRetryAttempt(client,ref,secondMovement,latest)).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
});
it('validates exact attempt/source provenance and accepts a sole old identityless delivery',async()=>{
  await insertReviewException(client,original);await requestReviewRetry(client,id,at,'owner',request);
  const job={receivedAt:at,source:{bucket:source.bucket,key:source.key},retryExceptionId:id};
  expect(await resolveRetryAttempt(client,job)).toMatchObject({exceptionId:id,requestedAt:at});
  for(const invalid of [{...job,receivedAt:later},{...job,source:{...job.source,key:'wrong.eml'}},{...job,retryRequestedAt:latest}])
    await expect(resolveRetryAttempt(client,invalid)).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
  expect(await resolveRetryAttempt(client,{receivedAt:at,source})).toBeUndefined();
});
it('derives pending dispatch, preserves the queue reference and records acceptance idempotently',async()=>{
  await insertReviewException(client,original);const ref=await requestReviewRetry(client,id,at,'owner',request);
  expect(await pendingReviewRetries(client)).toEqual([{ref:{exceptionId:id,requestedAt:at},job:{receivedAt:at,source,retryExceptionId:id,retryRequestedAt:at}}]);
  await markReviewRetryDispatched(client,ref,later);await markReviewRetryDispatched(client,ref,latest);
  expect(await pendingReviewRetries(client)).toEqual([]);expect((await readLatestRetry(client,id))?.dispatchedAt).toBe(later);
});
it('rolls back preparation and outcome together rather than leaving a partial workflow',async()=>{
  const interruption=new Error('injected outcome failure');
  await expect(transaction(async c=>{await saveClaimedReviewException(c,original,'parser-v1',at);await requestReviewRetry(c,id,at,'owner',request);throw interruption;})).rejects.toBe(interruption);
  for(const table of ['ingestion_review_exceptions','ingestion_review_claims','ingestion_retry_attempts'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);
});
it('preserves the first discard and logical expiry boundary, leaving original evidence reachable until expiry',async()=>{
  await insertReviewException(client,{...original,expiresAt:latest});await discardReviewException(client,id,at,'owner');await discardReviewException(client,id,later,'different-actor');
  expect((await readReviewException(client,id))?.discarded).toEqual({at,by:'owner'});expect(await listReviewExceptions(client,new Date(later))).toEqual([]);
  expect(await readReviewException(client,id,new Date(later))).toBeDefined();expect(await readReviewException(client,id,new Date(latest))).toBeUndefined();
});
it('limits before hiding discarded/completed records and omits failed retry details from product review',async()=>{
  const oldest='00000000-0000-4000-8000-000000000000';await insertReviewException(client,{...original,id:oldest});
  for(let n=1;n<=100;n++)await insertReviewException(client,{...original,id:`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`,discarded:{at,by:'owner'}});
  expect(await listReviewExceptions(client,new Date(latest))).toEqual([]);
  await sql.query('DELETE FROM olbia.ingestion_review_exceptions');await insertReviewException(client,original);const ref=await requestReviewRetry(client,id,at,'owner',request);
  expect((await listReviewExceptions(client,new Date(latest)))[0].retry).toMatchObject({status:'queued',requestId:request});
  await failRetryAttempt(client,ref,'Private extraction detail',later);
  expect(await listReviewExceptions(client,new Date(latest))).toEqual([{id,receivedAt:at,reason:original.reason,details:original.details}]);
  await completeRetryAttempt(client,ref,movement,latest);expect(await listReviewExceptions(client,new Date(latest))).toEqual([]);
});
it('expires only bounded suppression claims while retaining review, retry and financial references',async()=>{
  await saveClaimedReviewException(client,original,'parser-v1',at);await sql.query('UPDATE olbia.ingestion_review_claims SET expires_at=$1',[later]);
  await expireReviewClaims(client,new Date(at));expect((await sql.query('SELECT * FROM olbia.ingestion_review_claims')).rows).toHaveLength(1);
  await expireReviewClaims(client,new Date(later));expect((await sql.query('SELECT * FROM olbia.ingestion_review_claims')).rows).toEqual([]);expect(await readReviewException(client,id)).toEqual(original);
});
