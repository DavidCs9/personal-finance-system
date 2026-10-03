import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SESClient } from '@aws-sdk/client-ses';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { insertReviewException,requestReviewRetry,readLatestRetry,readReviewException } from '@finance/ledger/native-exceptions';
import { NATIVE_LEDGER_TABLES,LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../../ledger/src/dsql/ledger-schema.js';
import type { SqlClient,TransactionPool } from '../../ledger/src/dsql/projection.js';
import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi,type MockInstance } from 'vitest';
const harness=vi.hoisted(()=>({pool:undefined as unknown as SqlClient&TransactionPool,model:vi.fn(),inTransaction:false,failOutcome:false,legacyReads:[] as string[]}));
vi.mock('../../ledger/src/dsql/connection.js',()=>({createPool:()=>harness.pool}));
vi.mock('../../ingestion/src/bedrock-extractor.js',async original=>({...await original<typeof import('../../ingestion/src/bedrock-extractor.js')>(),extractEmailWithBedrock:harness.model}));
let sql:PGlite,email:typeof import('../../ingestion/src/process-email.js'),fallback:typeof import('../../ingestion/src/bedrock-fallback.js'),dispatcher:typeof import('../../../infrastructure/lambda/retry-dispatcher.js');
const at='2026-10-03T12:00:00.000Z',requestedAt='2026-10-03T12:01:00.000Z',id='00000000-0000-4000-8000-000000000001',request='20000000-0000-4000-8000-000000000001';
const job={receivedAt:at,source:{bucket:'evidence',key:'original.eml'}};
const delivery=(body:unknown,attempt='1')=>({Records:[{messageId:'original-delivery',body:JSON.stringify(body),attributes:{ApproximateReceiveCount:attempt}}]});
const failed={batchItemFailures:[{itemIdentifier:'original-delivery'}]};
const ordinaryMime='From: person@example.com\nMessage-ID: <original@example.com>\nSubject: Unknown\n\nUnrecognized original source.';
const purchaseMime='From: alertas@santander.com.mx\nMessage-ID: <original@example.com>\nSubject: Compra\n\nSantander\nCompra por $1,000.00 MXN\nEn: Original shop\nTarjeta **** 1234\nFecha: 2026-10-03T12:00:00Z';
let s3:MockInstance<S3Client['send']>,sqs:MockInstance<SQSClient['send']>,ses:MockInstance<SESClient['send']>,document:MockInstance<DynamoDBDocumentClient['send']>;
const guardedQuery:SqlClient['query']=async(s,v)=>{
  if(/olbia\.(?:ingestion_exceptions|ingestion_retries|exception_claims|dedupe_claims|bulk_edit_operations)\b/.test(s)){harness.legacyReads.push(s);throw new Error('Legacy workflow IO is forbidden');}
  if(harness.failOutcome&&s.startsWith('UPDATE olbia.ingestion_retry_attempts SET completed_at'))throw Object.assign(new Error('private injected outcome failure'),{code:'08006'});
  return sql.query<Record<string,unknown>>(s,v);
};
beforeAll(async()=>{
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');vi.stubEnv('METADATA_TABLE_NAME','metadata');vi.stubEnv('INGESTION_QUEUE_URL','https://sqs.example.test/queue');vi.stubEnv('BEDROCK_FALLBACK_QUEUE_URL','https://sqs.example.test/fallback');
  vi.stubEnv('ALERT_SENDER_EMAIL','sender@example.com');vi.stubEnv('ALERT_RECIPIENT_EMAIL','recipient@example.com');
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP),(18,CURRENT_TIMESTAMP),(19,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  harness.pool={query:guardedQuery,transaction:fn=>sql.transaction(async c=>{harness.inTransaction=true;
    try{return await fn({query:async(s,v)=>{if(harness.failOutcome&&s.startsWith('UPDATE olbia.ingestion_retry_attempts SET completed_at'))throw Object.assign(new Error('private injected outcome failure'),{code:'08006'});return c.query<Record<string,unknown>>(s,v);}});}
    finally{harness.inTransaction=false;}})};
  email=await import('../../ingestion/src/process-email.js');fallback=await import('../../ingestion/src/bedrock-fallback.js');dispatcher=await import('../../../infrastructure/lambda/retry-dispatcher.js');
},30_000);
afterAll(async()=>{await sql.close();vi.unstubAllEnvs();});
beforeEach(async()=>{
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_review_claims','ingestion_retry_attempts','ingestion_review_exceptions','projection_state','command_receipts','assistant_thread_selection','conversation_threads'].map(t=>`olbia.${t}`).join(',')}`);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  harness.legacyReads=[];harness.failOutcome=false;harness.inTransaction=false;
  s3=vi.spyOn(S3Client.prototype,'send').mockImplementation(async()=>{expect(harness.inTransaction).toBe(false);return{Body:{transformToString:async()=>ordinaryMime}};});
  sqs=vi.spyOn(SQSClient.prototype,'send').mockImplementation(async()=>{expect(harness.inTransaction).toBe(false);return{};});ses=vi.spyOn(SESClient.prototype,'send').mockImplementation(async()=>{expect(harness.inTransaction).toBe(false);return{MessageId:'injected-receipt'};});
  document=vi.spyOn(DynamoDBDocumentClient.prototype,'send').mockImplementation(async()=>{throw new Error('Document IO is forbidden');});
  harness.model.mockReset();harness.model.mockResolvedValue({recognized:false});for(const level of ['info','warn','error']as const)vi.spyOn(console,level).mockImplementation(()=>{});
});
afterEach(()=>{expect(harness.legacyReads).toEqual([]);expect(document).not.toHaveBeenCalled();vi.restoreAllMocks();});
const ingest=(input=job)=>email.ingestionHandler(delivery(input) as never,{} as never,()=>{});
const extract=(input={...job,institutionHint:'santander_mx',primaryFailure:'Original parser failure'})=>fallback.bedrockFallbackHandler(delivery(input)as never,{}as never,()=>{});
const parent=async(raw=ordinaryMime)=>{
  const sha256=createHash('sha256').update(raw).digest('hex'),source={...job.source,sha256,contentType:'message/rfc822' as const},sourceToken=createHash('sha256').update(`original@example.com:${sha256}`).digest('hex');
  await insertReviewException(sql,{id,receivedAt:at,source,sourceToken,reason:'parser_failed',details:'Original failure'});await requestReviewRetry(sql,id,requestedAt,'owner',request);
  return {...job,retryExceptionId:id,retryRequestedAt:requestedAt};
};
it('uses native claim/header once and sends one SES alert after commit across duplicate source delivery',async()=>{
  expect(await ingest()).toEqual({batchItemFailures:[]});expect(await ingest()).toEqual({batchItemFailures:[]});
  expect((await sql.query('SELECT * FROM olbia.ingestion_review_exceptions')).rows).toHaveLength(1);expect((await sql.query('SELECT * FROM olbia.ingestion_review_claims')).rows).toHaveLength(1);
  expect(ses).toHaveBeenCalledTimes(1);expect(sqs).not.toHaveBeenCalled();expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual([]);
});
it('preserves native partial batch failures before activation and does no provider work',async()=>{
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');expect(await ingest()).toEqual(failed);expect(await extract()).toEqual(failed);
  await expect(dispatcher.handler({})).rejects.toMatchObject({name:'MigrationPausedException'});expect(s3).not.toHaveBeenCalled();expect(sqs).not.toHaveBeenCalled();expect(ses).not.toHaveBeenCalled();expect(harness.model).not.toHaveBeenCalled();
});
it('completes the exact retry with the financial capture and deduplicates repeated original delivery',async()=>{
  const retryJob=await parent(purchaseMime);s3.mockImplementation(async()=>({Body:{transformToString:async()=>purchaseMime}}));
  expect(await ingest(retryJob)).toEqual({batchItemFailures:[]});const completed=await readLatestRetry(sql,id);expect(completed).toMatchObject({requestId:request,requestedAt,completedAt:expect.any(String),eventId:expect.any(String)});
  expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([{id:completed!.eventId}]);
  expect(await ingest(retryJob)).toEqual({batchItemFailures:[]});expect(await readLatestRetry(sql,id)).toEqual(completed);expect((await sql.query('SELECT * FROM olbia.ledger_observations')).rows).toHaveLength(1);expect(ses).not.toHaveBeenCalled();
});
it('rolls back financial movement/observation/source claim when exact retry completion fails, then recovers on the same source',async()=>{
  const retryJob=await parent(purchaseMime);s3.mockImplementation(async()=>({Body:{transformToString:async()=>purchaseMime}}));harness.failOutcome=true;
  expect(await ingest(retryJob)).toEqual(failed);for(const table of ['ledger_movements','ledger_observations','source_claims'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);
  expect((await readLatestRetry(sql,id))?.completedAt).toBeUndefined();harness.failOutcome=false;expect(await ingest(retryJob)).toEqual({batchItemFailures:[]});expect((await readLatestRetry(sql,id))?.eventId).toBeDefined();
});
it('fails a corrupt retry original before all financial writes instead of trusting bucket/key alone',async()=>{
  const retryJob=await parent();s3.mockImplementation(async()=>({Body:{transformToString:async()=>purchaseMime}}));expect(await ingest(retryJob)).toEqual(failed);
  expect((await sql.query('SELECT * FROM olbia.ledger_movements')).rows).toEqual([]);expect((await readLatestRetry(sql,id))?.completedAt).toBeUndefined();
});
it('saves claim/review and failed attempt together with one alert, preserving the original parent',async()=>{
  const retryJob=await parent();expect(await ingest(retryJob)).toEqual({batchItemFailures:[]});expect((await readLatestRetry(sql,id))?.failedAt).toBeDefined();
  expect((await readReviewException(sql,id))?.details).toBe('Original failure');expect((await sql.query('SELECT * FROM olbia.ingestion_review_exceptions')).rows).toHaveLength(2);expect(ses).toHaveBeenCalledTimes(1);
});
it('uses the existing scheduled SQS path and preserves pending work after provider failure',async()=>{
  await parent();sqs.mockRejectedValueOnce(new Error('Injected provider failure'));await expect(dispatcher.handler({})).rejects.toThrow('Injected provider failure');expect((await readLatestRetry(sql,id))?.dispatchedAt).toBeUndefined();
  await dispatcher.handler({});expect((await readLatestRetry(sql,id))?.dispatchedAt).toBeDefined();expect(sqs).toHaveBeenCalledTimes(2);
  expect(JSON.parse((sqs.mock.calls[1][0] as any).input.MessageBody)).toMatchObject({retryExceptionId:id,retryRequestedAt:requestedAt,source:job.source});await dispatcher.handler({});expect(sqs).toHaveBeenCalledTimes(2);
});
it('carries exact attempt identity through fallback extraction to the existing ingestion queue',async()=>{
  const retryJob=await parent();expect(await extract({...retryJob,institutionHint:'santander_mx',primaryFailure:'Original failure'})).toEqual({batchItemFailures:[]});
  expect(JSON.parse((sqs.mock.calls[0][0] as any).input.MessageBody)).toMatchObject({retryExceptionId:id,retryRequestedAt:requestedAt,bedrockExtraction:{result:{recognized:false}}});expect(harness.model).toHaveBeenCalledTimes(1);
});
it('fails closed on sanitized driver errors with partial retries and no provider work',async()=>{
  const client:SqlClient={query:async()=>{throw Object.assign(new Error('private driver failure'),{code:'08006'});}};
  expect(await withStoreClient(client,async()=>ingest())).toEqual(failed);expect(await withStoreClient(client,async()=>extract())).toEqual(failed);
  await expect(withStoreClient(client,()=>dispatcher.handler({}))).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});expect(s3).not.toHaveBeenCalled();expect(sqs).not.toHaveBeenCalled();expect(ses).not.toHaveBeenCalled();
});
