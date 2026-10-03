import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
process.env.METADATA_TABLE_NAME ??= 'metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'evidence';
const { listExceptions, requestRetry, discardException, readExceptionRawEmail } = await import('../src/exceptions/service.js');
import { readOperationalItem, selectOperationalRecords, sqlOperationalPartition } from '../src/operational/reads.js';
let sql:PGlite;
const activate=()=>sql.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');
const context=<T>(fn:()=>Promise<T>)=>withStoreClient({query:(s,v)=>sql.query(s,v)},fn);
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);},30_000);
afterAll(()=>sql.close());beforeEach(async()=>{vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');});afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('blocks product list/detail/retry/discard before document or original-source IO',async()=>{
  await activate();const database=vi.spyOn(DynamoDBDocumentClient.prototype,'send'),s3=vi.spyOn(S3Client.prototype,'send');
  const operations:(()=>Promise<unknown>)[]=[()=>listExceptions(),()=>requestRetry('exception','owner'),()=>discardException('exception','owner'),()=>readExceptionRawEmail('exception')];
  for(const op of operations)await expect(context(op)).rejects.toMatchObject({name:'MigrationPausedException'});
  expect(database).not.toHaveBeenCalled();expect(s3).not.toHaveBeenCalled();
});
it('rechecks before queueing a retry when activation occurs during old header lookup',async()=>{
  const send=vi.spyOn(DynamoDBDocumentClient.prototype,'send').mockImplementation(async()=>{await activate();return{Item:{payload:{receivedAt:'2026-10-03T12:00:00Z',source:{bucket:'evidence',key:'original.eml'}}}};});
  await expect(context(()=>requestRetry('exception','owner'))).rejects.toMatchObject({name:'MigrationPausedException'});expect(send).toHaveBeenCalledTimes(1);
});
it('sanitizes SQL driver failure with no fallback or domain mutation',async()=>{
  const send=vi.spyOn(DynamoDBDocumentClient.prototype,'send');
  await expect(withStoreClient({query:async()=>{throw Object.assign(new Error('private driver error'),{code:'08006'});}},()=>discardException('exception','owner')))
    .rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});expect(send).not.toHaveBeenCalled();
});
it('blocks every configured old envelope read mode and direct product SQL partition read',async()=>{
  await activate();const source=vi.fn(),sqlRead=vi.fn(),send=vi.spyOn(DynamoDBDocumentClient.prototype,'send');
  for(const mode of ['dynamodb','shadow','guarded-sql']){
    vi.stubEnv('DSQL_OPERATIONAL_READ_MODE',mode);
    await expect(context(()=>selectOperationalRecords('ingestion_exceptions',source,sqlRead))).rejects.toMatchObject({name:'MigrationPausedException'});
    await expect(context(()=>readOperationalItem('ingestion_exceptions',{database:DynamoDBDocumentClient.prototype,tableName:'metadata'},'EXCEPTION#exception','EXCEPTION'))).rejects.toMatchObject({name:'MigrationPausedException'});
  }
  await expect(sqlOperationalPartition('ingestion_exceptions','EXCEPTION#exception','EXCEPTION',{query:(s,v)=>sql.query(s,v)})).rejects.toMatchObject({name:'MigrationPausedException'});
  expect(send).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();expect(sqlRead).not.toHaveBeenCalled();
});
