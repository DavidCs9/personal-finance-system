import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/test/helpers/migration-schema.js';
import { OlbiaSqlStore } from '../../ledger/src/dsql/legacy-document-store.js';
import { migrateIngestionReview } from '../../ledger/src/dsql/exception-copy.js';
import type { SqlClient,TransactionPool } from '../../ledger/src/dsql/projection.js';
process.env.METADATA_TABLE_NAME??='metadata';process.env.RAW_EMAIL_BUCKET_NAME??='evidence';
const {verifyNativeExceptions}=await import('./helpers/exception-migration.js');
let sql:PGlite,store:OlbiaSqlStore,pool:TransactionPool;
const id='00000000-0000-4000-8000-000000000001',at='2026-10-03T12:00:00.000Z',now=new Date(at);
const bytes=Buffer.from('Message-ID: <Original@Example.com>\nSubject: Original\n\nPreserved original MIME.');
const sha256=createHash('sha256').update(bytes).digest('hex'),sourceToken=createHash('sha256').update(`original@example.com:${sha256}`).digest('hex');
const source={bucket:'evidence',key:'original.eml',sha256,contentType:'message/rfc822'};
const header={PK:`EXCEPTION#${id}`,SK:'EXCEPTION',GSI1PK:'EXCEPTIONS',GSI1SK:at,entityType:'ingestion_exception',payload:{id,receivedAt:at,reason:'parser_failed',details:'Original failure',source}};
const claim={PK:`EXCEPTION_DEDUPE#${createHash('sha256').update(`${sourceToken}:parser-v1:parser_failed`).digest('hex')}`,SK:'CLAIM',entityType:'ingestion_exception_claim',sourceDedupeKey:sourceToken,extractorVersion:'parser-v1',createdAt:at};
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);pool={transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),...pool},'metadata');},30_000);
afterAll(()=>sql.close());beforeEach(async()=>{
  await sql.exec('TRUNCATE olbia.ingestion_review_exceptions,olbia.ingestion_review_claims,olbia.ingestion_retry_attempts,olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries,olbia.projection_state');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");await sql.query('DELETE FROM olbia.schema_migrations WHERE version=19');await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  for(const Item of [header,claim])await store.send(new PutCommand({TableName:'metadata',Item}));await migrateIngestionReview(pool,async()=>bytes);
});
it('verifies actual product reads, exact original facts/bytes and independently required native constraints',async()=>{
  expect(await verifyNativeExceptions(now,sql as never,async()=>bytes)).toMatchObject({activated:true,headers:1,claims:1,attempts:0,productReads:3,originalChecks:1,retainedChecks:2,validatedConstraints:25,requiredColumns:17,mismatches:0});
});
it('detects original-byte corruption even when stored columns and claims still agree',async()=>{
  expect((await verifyNativeExceptions(now,sql as never,async()=>Buffer.from('Corrupt original'))).mismatches).toBeGreaterThan(0);
});
it('detects independently corrupted canonical evidence rather than comparing the mapper to itself',async()=>{
  await sql.query('UPDATE olbia.ingestion_review_exceptions SET source_sha256=$1',['c'.repeat(64)]);
  expect((await verifyNativeExceptions(now,sql as never,async()=>bytes)).mismatches).toBeGreaterThan(0);
});
it('detects missing native originals and missing constraints instead of treating empty native tables as a successful migration',async()=>{
  await sql.query('DELETE FROM olbia.ingestion_review_claims');await sql.query('DELETE FROM olbia.ingestion_review_exceptions');
  expect((await verifyNativeExceptions(now,sql as never,async()=>bytes)).mismatches).toBeGreaterThan(0);
  await sql.query('ALTER TABLE olbia.ingestion_review_exceptions DROP CONSTRAINT ingestion_review_discard_pair');
  expect((await verifyNativeExceptions(now,sql as never,async()=>bytes)).validatedConstraints).toBe(24);
});
