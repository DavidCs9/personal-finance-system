import { PGlite } from '@electric-sql/pglite';
import { beforeAll,afterAll,afterEach,expect,it } from 'vitest';
import { SCHEMA_STATEMENTS,bootstrapSchema } from '../src/dsql/schema.js';
import { LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { smokeNativeExceptions } from '../src/dsql/exception-smoke.js';
import type { SqlClient } from '../src/dsql/projection.js';
let sql:PGlite;
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  const client:SqlClient={query:async(s,v)=>{if(s.startsWith('AWS IAM GRANT'))return{rows:[]};if(s.startsWith('CREATE INDEX ASYNC'))return sql.query(s.replace('INDEX ASYNC','INDEX'),v);
    if(s.startsWith('ALTER TABLE ASYNC')){await sql.query(s.replace('TABLE ASYNC','TABLE'),v);return{rows:[{job_id:'local-validation'}]};}return sql.query<Record<string,unknown>>(s,v);}};
  const arns=['arn:aws:iam::225989371926:role/native-review-role-test'];
  await bootstrapSchema(client,[],{transactionPool:{transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},applicationRoleArns:arns,cutoverRoleArns:arns,readerRoleArns:arns,operationalVerifierRoleArns:arns,storeReaderRoleArns:arns});
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
const tables=['ingestion_review_exceptions','ingestion_review_claims','ingestion_retry_attempts'];
const snapshot=async()=>Object.fromEntries(await Promise.all([...tables,'ingestion_exceptions','exception_claims','ingestion_retries','projection_state','application_barrier','command_receipts'].map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));
it('runs the actual deployed workflow smoke with each writer and rolls back all native and original facts',async()=>{
  const before=await snapshot(),rollback=new Error('Expected complete rollback');
  for(const role of ['olbia_application','olbia_cutover']){await sql.query(`SET ROLE ${role}`);await expect(sql.transaction(async c=>{await smokeNativeExceptions(c as unknown as SqlClient,'owner');throw rollback;})).rejects.toBe(rollback);await sql.query('RESET ROLE');expect(await snapshot()).toEqual(before);}
});
it('permits only native lifecycle columns and denies all immutable evidence/identity changes for every actual role',async()=>{
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector']){
    await sql.query(`SET ROLE ${role}`);for(const table of tables)await sql.query(`SELECT * FROM olbia.${table}`);
    for(const [table,columns] of Object.entries({ingestion_review_exceptions:['id','received_at','institution','reason','details','source_bucket','source_key','source_sha256','source_content_type','source_token','expires_at'],ingestion_retry_attempts:['exception_id','requested_at','requested_by','request_id','job_source_sha256','job_source_content_type','job_source_message_id','expires_at'],ingestion_review_claims:['source_token','extractor_version','reason','exception_id','created_at','expires_at']}))
      for(const column of columns)await expect(sql.query(`UPDATE olbia.${table} SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
    for(const table of ['ingestion_review_exceptions','ingestion_retry_attempts'])await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
    if(!['olbia_application','olbia_cutover'].includes(role)){
      await expect(sql.query('UPDATE olbia.ingestion_review_exceptions SET discarded_at=discarded_at')).rejects.toMatchObject({code:'42501'});
      await expect(sql.query('UPDATE olbia.ingestion_retry_attempts SET completed_at=completed_at')).rejects.toMatchObject({code:'42501'});
      await expect(sql.query('DELETE FROM olbia.ingestion_review_claims')).rejects.toMatchObject({code:'42501'});
    }await sql.query('RESET ROLE');
  }
});
it('retains isolated historical reads while denying every frozen workflow mutation and product recovery access',async()=>{
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector']){
    await sql.query(`SET ROLE ${role}`);
    for(const table of ['ingestion_exceptions','exception_claims','ingestion_retries']){
      if(['olbia_projector','olbia_operational_verifier'].includes(role))await sql.query(`SELECT * FROM olbia.${table}`);else await expect(sql.query(`SELECT * FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
      await expect(sql.query(`UPDATE olbia.${table} SET source_item=source_item`)).rejects.toMatchObject({code:'42501'});await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
    }await sql.query('RESET ROLE');
  }
});
