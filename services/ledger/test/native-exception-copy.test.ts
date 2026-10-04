import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { PutCommand,UpdateCommand,DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll,beforeEach,afterAll,expect,it,vi } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { NATIVE_EXCEPTION_SCHEMA_STATEMENTS } from '../src/dsql/exception-schema.js';
import { migrateIngestionReview,prepareExceptionCopy,originalEmailSourceToken,type RetainedExceptionSnapshot } from '../src/dsql/exception-copy.js';
import { readReviewException,readLatestRetry } from '../src/dsql/exception.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient,TransactionPool } from '../src/dsql/projection.js';
let sql:PGlite,store:OlbiaSqlStore,pool:TransactionPool;
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',movement='10000000-0000-4000-8000-000000000001';
const at='2026-10-03T12:00:00.000Z',later='2026-10-03T12:01:00.000Z',latest='2026-10-03T12:02:00.000Z';
const bytes=Buffer.from('From: source@example.com\nMessage-ID: <ORIGINAL@Example.com>\nSubject: Original\n\nPreserved original bytes.');
const source={bucket:'evidence',key:'original.eml',sha256:createHash('sha256').update(bytes).digest('hex'),contentType:'message/rfc822'};
const token=createHash('sha256').update(`original@example.com:${source.sha256}`).digest('hex');
const claimKey=createHash('sha256').update(`${token}:parser-v1:parser_failed`).digest('hex');
const header={PK:`EXCEPTION#${id}`,SK:'EXCEPTION',entityType:'ingestion_exception',GSI1PK:'EXCEPTIONS',GSI1SK:at,payload:{id,receivedAt:at,reason:'parser_failed',details:'Original failure',source,
  retry:{status:'completed',requestedAt:at,requestedBy:'owner',completedAt:latest,eventId:movement}}};
const claim={PK:`EXCEPTION_DEDUPE#${claimKey}`,SK:'CLAIM',entityType:'ingestion_exception_claim',sourceDedupeKey:token,extractorVersion:'parser-v1',createdAt:at};
const task={PK:`RETRY#${id}`,SK:'DISPATCH',entityType:'ingestion_retry',status:'dispatched',createdAt:at,dispatchedAt:later,job:{receivedAt:at,source:{bucket:source.bucket,key:source.key},retryExceptionId:id}};
const inventory=async():Promise<RetainedExceptionSnapshot>=>({exceptions:(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.ingestion_exceptions')).rows,
  claims:(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.exception_claims')).rows,retries:(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.ingestion_retries')).rows});
const emptyTargets=async()=>{for(const table of ['ingestion_review_exceptions','ingestion_review_claims','ingestion_retry_attempts'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows).toEqual([]);};
const seed=async()=>{for(const Item of [header,claim,task])await store.send(new PutCommand({TableName:'metadata',Item}));};
beforeAll(async()=>{sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,...NATIVE_EXCEPTION_SCHEMA_STATEMENTS])await sql.query(s);
  await sql.query(`INSERT INTO olbia.ledger_movements (id,primary_observation_id,institution,event_type,status,amount_minor,currency,merchant_raw,received_at,ingested_at,reconciliation_at,account_present)
    VALUES ($1,$1,'santander_mx','card_purchase','accepted',100,'MXN','Original shop',$2,$2,$2,false)`,[movement,at]);
  pool={transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),...pool},'metadata');
},30_000);
afterAll(()=>sql.close());beforeEach(async()=>{await sql.exec('TRUNCATE olbia.ingestion_review_claims,olbia.ingestion_retry_attempts,olbia.ingestion_review_exceptions,olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version IN (18,19)');await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP)');await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");});
it('copies exact originals and typed relationships while preserving missing historical UUID/job metadata',async()=>{
  await seed();const before=await inventory(),read=vi.fn(async()=>bytes);await migrateIngestionReview(pool,read);
  expect(read).toHaveBeenCalledTimes(1);expect(await inventory()).toEqual(before);
  expect(await readReviewException(sql as unknown as SqlClient,id)).toMatchObject({id,source,sourceToken:token});
  expect(await readLatestRetry(sql as unknown as SqlClient,id)).toEqual({exceptionId:id,requestedAt:at,requestedBy:'owner',dispatchedAt:later,completedAt:latest,eventId:movement});
  expect((await sql.query('SELECT exception_id FROM olbia.ingestion_review_claims')).rows).toEqual([{exception_id:id}]);
  await migrateIngestionReview(pool,read);expect(read).toHaveBeenCalledTimes(1);
});
it('reproduces RFC message ID normalization and handles genuinely absent message IDs',async()=>{
  expect(await originalEmailSourceToken(bytes)).toEqual({sha256:source.sha256,sourceToken:token});
  const noId=Buffer.from('Subject: Original\n\nNo identifier');const sha=createHash('sha256').update(noId).digest('hex');
  expect(await originalEmailSourceToken(noId)).toEqual({sha256:sha,sourceToken:createHash('sha256').update(`no-message-id:${sha}`).digest('hex')});
});
it('fails closed on original hash mismatch, unknown shape or inconsistent promoted projection',async()=>{
  await seed();const baseline=await inventory();await expect(prepareExceptionCopy(baseline,async()=>Buffer.from('Different bytes'))).rejects.toThrow('mapping is inconsistent');
  for(const mutate of [(s:RetainedExceptionSnapshot)=>{(s.exceptions[0].source_item as any).payload.unknown='Unmapped fact';},(s:RetainedExceptionSnapshot)=>{s.exceptions[0].received_at=later;}]){
    const changed=structuredClone(baseline);mutate(changed);await expect(prepareExceptionCopy(changed,async()=>bytes)).rejects.toThrow();
  }await emptyTargets();
});
it('rejects unresolved and ambiguous claim parents instead of fabricating relationships',async()=>{
  await seed();await sql.query("UPDATE olbia.exception_claims SET source_item=jsonb_set(source_item,'{sourceDedupeKey}',to_jsonb($1::text)),source_dedupe_key=$1",['c'.repeat(64)]);
  await expect(migrateIngestionReview(pool,async()=>bytes)).rejects.toThrow();await emptyTargets();
  await store.send(new DeleteCommand({TableName:'metadata',Key:{PK:claim.PK,SK:claim.SK}}));await store.send(new PutCommand({TableName:'metadata',Item:claim}));
  await store.send(new PutCommand({TableName:'metadata',Item:{...header,PK:`EXCEPTION#${other}`,payload:{...header.payload,id:other,retry:undefined}}}));
  await expect(migrateIngestionReview(pool,async()=>bytes)).rejects.toThrow();await emptyTargets();
});
it('rejects a changed snapshot after source proof before any native activation',async()=>{
  await seed();const read=vi.fn(async()=>{await store.send(new UpdateCommand({TableName:'metadata',Key:{PK:header.PK,SK:header.SK},UpdateExpression:'SET #payload.#details=:detail',ExpressionAttributeNames:{'#payload':'payload','#details':'details'},ExpressionAttributeValues:{':detail':'Concurrent known update'}}));return bytes;});
  await expect(migrateIngestionReview(pool,read)).rejects.toThrow('mapping is inconsistent');await emptyTargets();
});
it('rejects partial targets and missing prerequisite, preserving the full original snapshot',async()=>{
  await seed();const before=await inventory();await sql.query('DELETE FROM olbia.schema_migrations WHERE version=18');
  await expect(migrateIngestionReview(pool,async()=>bytes)).rejects.toThrow();await emptyTargets();
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP)');
  await sql.query(`INSERT INTO olbia.ingestion_review_exceptions (id,received_at,reason,details,source_bucket,source_key,source_sha256,source_content_type,source_token) VALUES ($1,$2,'parser_failed','Partial','evidence','partial.eml',$3,'message/rfc822',$4)`,[other,at,source.sha256,token]);
  await expect(migrateIngestionReview(pool,async()=>bytes)).rejects.toThrow();expect(await inventory()).toEqual(before);expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows).toEqual([]);
});
it('rolls back all native rows on a missing financial FK rather than accepting a partial copy',async()=>{
  await seed();await store.send(new UpdateCommand({TableName:'metadata',Key:{PK:header.PK,SK:header.SK},UpdateExpression:'SET #payload.#retry.#eventId=:id',ExpressionAttributeNames:{'#payload':'payload','#retry':'retry','#eventId':'eventId'},ExpressionAttributeValues:{':id':other}}));
  await expect(migrateIngestionReview(pool,async()=>bytes)).rejects.toMatchObject({code:'23503'});await emptyTargets();
});
it('reuses prepared original bytes across connector callback retries and activates atomically',async()=>{
  await seed();const read=vi.fn(async()=>bytes),interrupted=new Error('OCC retry');let calls=0;
  const retrying:TransactionPool={transaction:async fn=>{calls++;if(calls===2){await expect(sql.transaction(async c=>{await fn(c as unknown as SqlClient);expect((await c.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows).toHaveLength(1);throw interrupted;})).rejects.toBe(interrupted);}return pool.transaction(fn);}};
  await migrateIngestionReview(retrying,read);expect(read).toHaveBeenCalledTimes(1);expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows).toHaveLength(1);
});
