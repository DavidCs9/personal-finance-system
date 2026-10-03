import { PGlite } from '@electric-sql/pglite';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { upsertConversation, selectConversation, readConversationMetadata, readConversationSelection } from '@finance/ledger/native-threads';
import { projectRows } from '../../services/ledger/src/dsql/model.js';
import { insertRow } from '../../services/ledger/src/dsql/projection.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
let sql:PGlite;
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');},30_000);
afterAll(()=>sql.close());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('runs actual scheduled expiry through native metadata and still dispatches pending retries without reading frozen thread envelopes',async()=>{
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');vi.stubEnv('DSQL_ENDPOINT','example.dsql.us-east-2.on.aws');vi.stubEnv('METADATA_TABLE_NAME','metadata');vi.stubEnv('INGESTION_QUEUE_URL','https://sqs.example.test/queue');
  const id='11111111-1111-1111-1111-111111111111',owner='owner',at='2020-01-01T12:00:00.123Z';
  await upsertConversation(sql,{id,owner,title:'Expired metadata',month:'2020-01',at});await selectConversation(sql,owner,id,at);
  const retry={PK:'RETRY#native-expiry-test',SK:'DISPATCH',entityType:'ingestion_retry',status:'pending',job:{existing:'provider job'}};
  for(const row of projectRows({PK:retry.PK,SK:retry.SK},retry))await insertRow(sql,row);
  await sql.query(`INSERT INTO olbia.projection_state (source_pk,source_sk,generation,source_hash,source_item,deleted,transformer_version,reconciled_at)
    VALUES ($1,$2,1,NULL,$3,false,1,CURRENT_TIMESTAMP)`,[retry.PK,retry.SK,JSON.stringify(retry)]);
  const send=vi.spyOn(SQSClient.prototype,'send').mockResolvedValue({} as never);
  const {handler}=await import('../lambda/retry-dispatcher.js');const statements:string[]=[];
  await sql.transaction(c=>withStoreClient({query:async(s:string,v?:unknown[])=>{statements.push(s);return c.query<Record<string,unknown>>(s,v);}},()=>handler({})));
  expect(await readConversationMetadata(sql,owner,id)).toBeUndefined();expect(await readConversationSelection(sql,owner)).toEqual({configured:true});
  expect(statements.some(s=>s.includes('FROM olbia.assistant_threads'))).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);expect((send.mock.calls[0][0] as SendMessageCommand).input).toEqual({QueueUrl:'https://sqs.example.test/queue',MessageBody:JSON.stringify(retry.job)});
  expect((await sql.query('SELECT status FROM olbia.ingestion_retries')).rows).toEqual([{status:'dispatched'}]);
});
