import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bootstrapSchema } from '../src/dsql/schema.js';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { smokeNativeThreads } from '../src/dsql/thread-smoke.js';
import { upsertConversation, selectConversation, readConversationMetadata, deleteConversationMetadata } from '../src/dsql/thread.js';
import type { SqlClient } from '../src/dsql/projection.js';
let sql:PGlite;
const owner='owner',id='11111111-1111-1111-1111-111111111111',at='2026-10-03T12:00:00.123Z';
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  const client:SqlClient={query:async(s,v)=>{
    if(s.startsWith('AWS IAM GRANT'))return{rows:[]};if(s.startsWith('CREATE INDEX ASYNC'))return sql.query(s.replace('INDEX ASYNC','INDEX'),v);
    if(s.startsWith('ALTER TABLE ASYNC')){await sql.query(s.replace('TABLE ASYNC','TABLE'),v);return{rows:[{job_id:'local-validation'}]};}return sql.query<Record<string,unknown>>(s,v);
  }};
  const identity=['arn:aws:iam::225989371926:role/permission-test'];
  for(const version of [8,9,10,11,12,13,14,15,16,17,18,19,20]) await sql.query('INSERT INTO olbia.schema_migrations VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING',[version]);
  await bootstrapSchema(client,[],{transactionPool:{transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},applicationRoleArns:identity,
    cutoverRoleArns:identity,readerRoleArns:identity,operationalVerifierRoleArns:identity,storeReaderRoleArns:identity});
  await upsertConversation(sql,{owner,id,title:'Original title',month:'2026-10',at});await selectConversation(sql,owner,id,at);
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
const snapshot=async()=>Object.fromEntries(await Promise.all(['conversation_threads','assistant_thread_selection','assistant_threads','projection_state','application_barrier']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));
it('runs actual deployed smoke with both native writer identities and completely rolls back new metadata and original active choice',async()=>{
  const before=await snapshot(),rollback=new Error('Expected rollback');
  for(const role of ['olbia_application','olbia_cutover']){
    await sql.query(`SET ROLE ${role}`);await expect(sql.transaction(async c=>{await smokeNativeThreads(c as unknown as SqlClient,owner);throw rollback;})).rejects.toBe(rollback);
    await sql.query('RESET ROLE');expect(await snapshot()).toEqual(before);
  }
});
it('enforces every actual role and only permits bounded native lifecycle writes',async()=>{
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector']){
    await sql.query(`SET ROLE ${role}`);expect(await readConversationMetadata(sql,owner,id)).toMatchObject({title:'Original title'});
    for(const column of ['id','owner','title','first_month','created_at'])await expect(sql.query(`UPDATE olbia.conversation_threads SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
    for(const column of ['id','owner'])await expect(sql.query(`UPDATE olbia.assistant_thread_selection SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
    await expect(sql.query('DELETE FROM olbia.assistant_thread_selection')).rejects.toMatchObject({code:'42501'});
    if(!['olbia_application','olbia_cutover'].includes(role)){
      await expect(upsertConversation(sql,{owner,id,title:'Attempt',month:'2026-10',at})).rejects.toMatchObject({code:'42501'});
      await expect(selectConversation(sql,owner,undefined,at)).rejects.toMatchObject({code:'42501'});
      await expect(deleteConversationMetadata(sql,owner,id,at)).rejects.toMatchObject({code:'42501'});
    }
    await sql.query('RESET ROLE');
  }
});
it('denies all historical recovery reads and denies every frozen metadata mutation',async()=>{
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector']){
    await sql.query(`SET ROLE ${role}`);
    await expect(sql.query('SELECT * FROM olbia.assistant_threads')).rejects.toMatchObject({code:'42501'});
    for(const action of ['DELETE FROM olbia.assistant_threads','UPDATE olbia.assistant_threads SET source_item=source_item'])await expect(sql.query(action)).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');
  }
});
