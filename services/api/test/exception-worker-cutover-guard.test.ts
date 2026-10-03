import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SESClient } from '@aws-sdk/client-ses';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { OlbiaSqlStore, withStoreClient } from '@finance/ledger/dsql-store';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
const harness=vi.hoisted(()=>({pool:undefined as unknown as SqlClient&TransactionPool,model:vi.fn()}));
vi.mock('../../ledger/src/dsql/connection.js',()=>({createPool:()=>harness.pool}));
vi.mock('../../ingestion/src/bedrock-extractor.js',()=>({BEDROCK_EMAIL_EXTRACTOR_VERSION:'test-extractor',extractEmailWithBedrock:harness.model}));
let sql:PGlite,email:typeof import('../../ingestion/src/process-email.js'),fallback:typeof import('../../ingestion/src/bedrock-fallback.js'),dispatcher:typeof import('../../../infrastructure/lambda/retry-dispatcher.js');
const at='2026-10-03T12:00:00Z',job={receivedAt:at,source:{bucket:'evidence',key:'original.eml'}};
const delivery=(body:unknown)=>({Records:[{messageId:'original-delivery',body:JSON.stringify(body),attributes:{ApproximateReceiveCount:'1'}}]});
const activate=()=>sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');
const context=<T>(fn:()=>T|Promise<T>)=>withStoreClient(harness.pool,async()=>fn());
const failed={batchItemFailures:[{itemIdentifier:'original-delivery'}]};
const ordinaryMime='From: person@example.com\nMessage-ID: <original@example.com>\nSubject: Unknown\n\nUnrecognized original source.';
let s3:MockInstance<S3Client['send']>,sqs:MockInstance<SQSClient['send']>,ses:MockInstance<SESClient['send']>;
beforeAll(async()=>{
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');vi.stubEnv('METADATA_TABLE_NAME','metadata');vi.stubEnv('INGESTION_QUEUE_URL','https://sqs.example.test/queue');
  vi.stubEnv('ALERT_SENDER_EMAIL','sender@example.com');vi.stubEnv('ALERT_RECIPIENT_EMAIL','recipient@example.com');
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  harness.pool={query:(s,v)=>sql.query<Record<string,unknown>>(s,v),transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};
  email=await import('../../ingestion/src/process-email.js');fallback=await import('../../ingestion/src/bedrock-fallback.js');dispatcher=await import('../../../infrastructure/lambda/retry-dispatcher.js');
},30_000);
afterAll(async()=>{await sql.close();vi.unstubAllEnvs();});
beforeEach(async()=>{
  await sql.exec('TRUNCATE olbia.projection_state,olbia.command_receipts,olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  s3=vi.spyOn(S3Client.prototype,'send').mockResolvedValue({Body:{transformToString:async()=>ordinaryMime}} as never);
  sqs=vi.spyOn(SQSClient.prototype,'send').mockResolvedValue({} as never);ses=vi.spyOn(SESClient.prototype,'send').mockResolvedValue({MessageId:'injected-receipt'} as never);
  harness.model.mockReset();harness.model.mockResolvedValue({recognized:false});
  for(const level of ['info','warn','error']as const)vi.spyOn(console,level).mockImplementation(()=>{});
});
afterEach(()=>vi.restoreAllMocks());
const ingest=()=>email.ingestionHandler(delivery(job) as never,{} as never,()=>{});
const extract=()=>fallback.bedrockFallbackHandler(delivery({...job,institutionHint:'santander_mx',primaryFailure:'Original parser failure'})as never,{}as never,()=>{});
it('preserves ordinary pre-marker exception claims/header and one native SES alert',async()=>{
  expect(await context(ingest)).toEqual({batchItemFailures:[]});expect((await sql.query('SELECT * FROM olbia.ingestion_exceptions')).rows).toHaveLength(1);
  expect((await sql.query('SELECT * FROM olbia.exception_claims')).rows).toHaveLength(1);expect(ses).toHaveBeenCalledTimes(1);expect(sqs).not.toHaveBeenCalled();
});
it('returns native partial batch failures and rejects scheduled dispatch before all provider IO after activation',async()=>{
  await activate();expect(await context(ingest)).toEqual(failed);expect(await context(extract)).toEqual(failed);
  await expect(context(()=>dispatcher.handler({}))).rejects.toMatchObject({name:'MigrationPausedException'});
  expect(s3).not.toHaveBeenCalled();expect(sqs).not.toHaveBeenCalled();expect(ses).not.toHaveBeenCalled();expect(harness.model).not.toHaveBeenCalled();
});
it('rechecks before saving/alerting an exception after activation during source read',async()=>{
  s3.mockImplementation(async()=>{await activate();return{Body:{transformToString:async()=>ordinaryMime}};});
  expect(await context(ingest)).toEqual(failed);expect((await sql.query('SELECT * FROM olbia.ingestion_exceptions')).rows).toHaveLength(0);
  expect(ses).not.toHaveBeenCalled();expect(sqs).not.toHaveBeenCalled();
});
it('rechecks immediately before SES when metadata was saved just before activation',async()=>{
  let activated=false;
  const client:SqlClient={query:async(s,v)=>{
    if(s.includes('WHERE version=19')&&!activated&&Number((await sql.query<{count:number}>('SELECT count(*) AS count FROM olbia.ingestion_exceptions')).rows[0].count)===1){activated=true;await activate();}
    return sql.query<Record<string,unknown>>(s,v);
  }};
  // Alert failures retain the already-saved review record, just as existing provider failures do.
  expect(await withStoreClient(client,async()=>ingest())).toEqual({batchItemFailures:[]});expect(activated).toBe(true);expect(ses).not.toHaveBeenCalled();
  expect((await sql.query('SELECT * FROM olbia.ingestion_exceptions')).rows).toHaveLength(1);
});
it('rechecks before returning extracted jobs to SQS after activation during model IO',async()=>{
  harness.model.mockImplementation(async()=>{await activate();return{recognized:false};});
  expect(await context(extract)).toEqual(failed);expect(harness.model).toHaveBeenCalledTimes(1);expect(sqs).not.toHaveBeenCalled();expect(ses).not.toHaveBeenCalled();
});
it('rechecks before scheduled SQS send after activation during pending-record read',async()=>{
  const store=new OlbiaSqlStore(harness.pool,'metadata');await store.send(new PutCommand({TableName:'metadata',Item:{PK:'RETRY#exception',SK:'DISPATCH',entityType:'ingestion_retry',status:'pending',createdAt:at,job:{...job,retryExceptionId:'exception'}}}));
  const client:SqlClient={query:async(s,v)=>{const result=await sql.query<Record<string,unknown>>(s,v);if(s.includes("FROM olbia.ingestion_retries WHERE status='pending'"))await activate();return result;}};
  await expect(withStoreClient(client,()=>dispatcher.handler({}))).rejects.toMatchObject({name:'MigrationPausedException'});expect(sqs).not.toHaveBeenCalled();
  expect((await sql.query('SELECT status FROM olbia.ingestion_retries')).rows).toEqual([{status:'pending'}]);
});
it('fails closed on native driver errors with native partial retries and no provider work',async()=>{
  const client:SqlClient={query:async()=>{throw Object.assign(new Error('private driver failure'),{code:'08006'});}};
  expect(await withStoreClient(client,async()=>ingest())).toEqual(failed);expect(await withStoreClient(client,async()=>extract())).toEqual(failed);
  await expect(withStoreClient(client,()=>dispatcher.handler({}))).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
  expect(s3).not.toHaveBeenCalled();expect(sqs).not.toHaveBeenCalled();expect(ses).not.toHaveBeenCalled();expect(harness.model).not.toHaveBeenCalled();
});
