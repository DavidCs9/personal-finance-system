import { PGlite } from '@electric-sql/pglite';
import { SQSClient,SendMessageCommand } from '@aws-sdk/client-sqs';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { upsertConversation,selectConversation,readConversationMetadata,readConversationSelection } from '@finance/ledger/native-threads';
import { insertReviewException,requestReviewRetry,readLatestRetry } from '@finance/ledger/native-exceptions';
import type { SqlClient,TransactionPool } from '../../services/ledger/src/dsql/projection.js';
import { afterAll,afterEach,beforeAll,expect,it,vi } from 'vitest';
const harness=vi.hoisted(()=>({pool:undefined as unknown as SqlClient&TransactionPool,inTransaction:false,statements:[] as string[]}));
vi.mock('../../services/ledger/src/dsql/connection.js',()=>({createPool:()=>harness.pool}));
let sql:PGlite;
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);await sql.query("INSERT INTO olbia.runtime_state(id,mode,changed_at) VALUES ('storage','sql',CURRENT_TIMESTAMP)");await sql.query("INSERT INTO olbia.application_barrier VALUES ('storage',0)");await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP),(19,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  harness.pool={query:async(s,v)=>{harness.statements.push(s);return sql.query<Record<string,unknown>>(s,v);},transaction:fn=>sql.transaction(async c=>{harness.inTransaction=true;try{return await fn({query:async(s,v)=>{harness.statements.push(s);return c.query<Record<string,unknown>>(s,v);}});}finally{harness.inTransaction=false;}})};
},30_000);
afterAll(()=>sql.close());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('runs native expiry and dispatch outside SQL callbacks without any frozen workflow reads',async()=>{
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');vi.stubEnv('INGESTION_QUEUE_URL','https://sqs.example.test/queue');
  const id='11111111-1111-4111-8111-111111111111',owner='owner',at='2020-01-01T12:00:00.123Z';
  await upsertConversation(sql,{id,owner,title:'Expired metadata',month:'2020-01',at});await selectConversation(sql,owner,id,at);
  await insertReviewException(sql,{id,receivedAt:at,reason:'parser_failed',details:'Original failure',source:{bucket:'evidence',key:'original.eml',sha256:'a'.repeat(64),contentType:'message/rfc822'},sourceToken:'b'.repeat(64)});
  await requestReviewRetry(sql,id,at,owner,'22222222-2222-4222-8222-222222222222');
  const send=vi.spyOn(SQSClient.prototype,'send').mockImplementation(async()=>{expect(harness.inTransaction).toBe(false);return{};});
  const {handler}=await import('../lambda/retry-dispatcher.js');await handler({});
  expect(await readConversationMetadata(sql,owner,id)).toBeUndefined();expect(await readConversationSelection(sql,owner)).toEqual({configured:true});
  expect(harness.statements.some(s=>/olbia\.(?:assistant_threads|ingestion_retries|exception_claims|dedupe_claims|bulk_edit_operations)\b/.test(s))).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);expect(JSON.parse((send.mock.calls[0][0] as SendMessageCommand).input.MessageBody!)).toMatchObject({retryExceptionId:id,retryRequestedAt:at,source:{bucket:'evidence',key:'original.eml'}});
  expect((await readLatestRetry(sql,id))?.dispatchedAt).toBeDefined();
});
