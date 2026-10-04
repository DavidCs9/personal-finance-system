import { PGlite } from '@electric-sql/pglite';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { maintenanceHandler, replayHandler, streamHandler, schemaHandler } from '../src/dsql/runtime.js';
let sql: PGlite;
beforeAll(async () => {
  vi.stubEnv('DSQL_ENDPOINT','example.dsql.us-east-2.on.aws'); vi.stubEnv('METADATA_TABLE_NAME','source');
  sql=new PGlite(); for(const s of SCHEMA_STATEMENTS) await sql.query(s);
  await sql.query("INSERT INTO olbia.runtime_state VALUES ('storage','sql',CURRENT_TIMESTAMP)");
  await sql.query("INSERT INTO olbia.application_barrier VALUES ('storage',0)");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (20,CURRENT_TIMESTAMP)');
  vi.spyOn(AuroraDSQLPool.prototype,'query').mockImplementation(((s:string,v?:unknown[])=>sql.query(s,v)) as never);
  vi.spyOn(AuroraDSQLPool.prototype,'transaction').mockImplementation(async fn=>sql.transaction(c=>fn(c as never)));
},30_000);
afterAll(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await sql.close();});
it('disabled stream and retired replay cannot read source data, recreate tables or overwrite native financial facts',async()=>{
  const queries=vi.mocked(AuroraDSQLPool.prototype.query).mock.calls.length;
  const source=vi.spyOn(DynamoDBClient.prototype,'send').mockRejectedValue(new Error('Source access forbidden'));
  expect(await streamHandler({Records:[{stale:'DynamoDB source'}]})).toEqual({batchItemFailures:[]});
  await expect(replayHandler({key:'aws/lambda/old-failure.json'})).rejects.toThrow('retired');
  expect(vi.mocked(AuroraDSQLPool.prototype.query).mock.calls).toHaveLength(queries);expect(source).not.toHaveBeenCalled();source.mockRestore();
});
it('verifies the current native catalog with no migration relations, source scan or evidence-report writes',async()=>{
  expect(await maintenanceHandler({runId:'deployment',phase:'source'})).toMatchObject({phase:'done',projected:0,equal:41,lag:0,mismatch:0,summary:{mode:'native-sql',tables:41}});
  expect((await sql.query("SELECT tablename FROM pg_tables WHERE schemaname='olbia'")).rows).toHaveLength(41);
  await expect(maintenanceHandler({runId:'',phase:'source'})).rejects.toThrow('runId');
});
it('does not run schema or cleanup on CloudFormation Delete and rejects unknown schema operations',async()=>{
  const queries=vi.mocked(AuroraDSQLPool.prototype.query).mock.calls.length;
  expect(await schemaHandler({RequestType:'Delete',PhysicalResourceId:'existing',ResourceProperties:{}})).toEqual({PhysicalResourceId:'existing'});
  expect(vi.mocked(AuroraDSQLPool.prototype.query).mock.calls).toHaveLength(queries);
  await expect(schemaHandler({action:'unknown'} as never)).rejects.toThrow('Unknown DSQL schema operation');
});
it('does not require DynamoDB access when a reviewed catalog retirement has already completed',async()=>{
  const source=vi.spyOn(DynamoDBClient.prototype,'send').mockRejectedValue(new Error('Source access forbidden'));
  expect(await schemaHandler({action:'retire-migration-evidence'})).toMatchObject({verified:true,removedTables:0,remainingTables:41});
  expect(source).not.toHaveBeenCalled();source.mockRestore();
});
