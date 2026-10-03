import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { withSqlClient } from '@finance/ledger/sql-runtime';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
process.env.METADATA_TABLE_NAME ??= 'metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'evidence';
const { listExceptions, requestRetry, discardException, readExceptionRawEmail } = await import('../src/exceptions/service.js');
let sql:PGlite;
const activate=()=>sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');
const context=<T>(fn:()=>Promise<T>)=>withSqlClient({query:(s,v)=>sql.query(s,v)},fn);
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);},30_000);
afterAll(()=>sql.close());beforeEach(async()=>{vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');await sql.exec('TRUNCATE olbia.ingestion_review_claims,olbia.ingestion_retry_attempts,olbia.ingestion_review_exceptions');});afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('blocks product list/detail/retry/discard before document or original-source IO',async()=>{
  const database=vi.spyOn(DynamoDBDocumentClient.prototype,'send'),s3=vi.spyOn(S3Client.prototype,'send');
  const operations:(()=>Promise<unknown>)[]=[()=>listExceptions(),()=>requestRetry('exception','owner'),()=>discardException('exception','owner'),()=>readExceptionRawEmail('exception')];
  for(const op of operations)await expect(context(op)).rejects.toMatchObject({name:'MigrationPausedException'});
  expect(database).not.toHaveBeenCalled();expect(s3).not.toHaveBeenCalled();
});
it('creates a native retry without document IO or fallback and preserves the public response',async()=>{
  await activate();const id='00000000-0000-4000-8000-000000000001';
  await sql.query(`INSERT INTO olbia.ingestion_review_exceptions (id,received_at,reason,details,source_bucket,source_key,source_sha256,source_content_type,source_token)
    VALUES ($1,'2026-10-03T12:00:00Z','parser_failed','Original','evidence','original.eml',$2,'message/rfc822',$3)`,[id,'a'.repeat(64),'b'.repeat(64)]);
  const send=vi.spyOn(DynamoDBDocumentClient.prototype,'send');const result=await context(()=>requestRetry(id,'owner'));
  expect(result).toMatchObject({id,retry:{status:'queued',requestedBy:'owner'}});expect(send).not.toHaveBeenCalled();
  await expect(context(()=>requestRetry(id,'owner'))).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
  expect((await sql.query('SELECT * FROM olbia.ingestion_retry_attempts')).rows).toHaveLength(1);
});
it('sanitizes SQL driver failure with no fallback or domain mutation',async()=>{
  const send=vi.spyOn(DynamoDBDocumentClient.prototype,'send');
  await expect(withSqlClient({query:async()=>{throw Object.assign(new Error('private driver error'),{code:'08006'});}},()=>discardException('exception','owner')))
    .rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});expect(send).not.toHaveBeenCalled();
});
it('uses current native SQL across all obsolete read modes without a document fallback',async()=>{
  await activate();const send=vi.spyOn(DynamoDBDocumentClient.prototype,'send');
  for(const mode of ['dynamodb','shadow','guarded-sql']){vi.stubEnv('DSQL_OPERATIONAL_READ_MODE',mode);expect(await context(()=>listExceptions())).toEqual([]);}
  expect(send).not.toHaveBeenCalled();
});
