import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bootstrapSchema } from '../src/dsql/schema.js';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { smokeNativeDeliveries } from '../src/dsql/delivery-smoke.js';
import { insertMonthlyDeliveryPreparation, insertMonthlyDeliveryReceipt, readMonthlyDelivery } from '../src/dsql/delivery.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql:PGlite;
const owner='owner',month='2026-09',at='2026-10-03T12:00:00.123Z';
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  const client:SqlClient={query:async(s,v)=>{
    if(s.startsWith('AWS IAM GRANT'))return{rows:[]};
    if(s.startsWith('CREATE INDEX ASYNC'))return sql.query(s.replace('INDEX ASYNC','INDEX'),v);
    if(s.startsWith('ALTER TABLE ASYNC')){await sql.query(s.replace('TABLE ASYNC','TABLE'),v);return{rows:[{job_id:'local-validation'}]};}
    return sql.query<Record<string,unknown>>(s,v);
  }};
  const identity=['arn:aws:iam::225989371926:role/permission-test'];
  for(const version of [8,9,10,11,12,13,14,15,16,17,18,19,20]) await sql.query('INSERT INTO olbia.schema_migrations VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING',[version]);
  await bootstrapSchema(client,[],{transactionPool:{transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},applicationRoleArns:identity,
    cutoverRoleArns:identity,readerRoleArns:identity,operationalVerifierRoleArns:identity,storeReaderRoleArns:identity});
  await insertMonthlyDeliveryPreparation(sql,{kind:'monthly_close',owner,month,preparedAt:at,email:{subject:'Original subject',html:'Original html',text:'Original text'},
    report:{facts:{original:true},analysis:{original:true},analysisVersion:'original-version',analysisSource:'fallback'}});
  await insertMonthlyDeliveryReceipt(sql,{owner,kind:'monthly_close',month,messageId:'original-receipt',sentAt:at});
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
const snapshot=async()=>Object.fromEntries(await Promise.all(['monthly_email_preparations','monthly_email_receipts','delivery_records','projection_state','application_barrier']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1,2`)).rows])));

it('runs the actual deployed preparation/receipt smoke with both native writer roles and fully rolls back originals/new receipts',async()=>{
  const before=await snapshot(),rollback=new Error('Expected rollback');
  for(const role of ['olbia_application','olbia_cutover']){
    await sql.query(`SET ROLE ${role}`);await expect(sql.transaction(async c=>{await smokeNativeDeliveries(c as unknown as SqlClient,owner);throw rollback;})).rejects.toBe(rollback);
    await sql.query('RESET ROLE');expect(await snapshot()).toEqual(before);
  }
});

it('enforces actual append-only writer permissions and no private delivery access for unused product roles',async()=>{
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector']){
    await sql.query(`SET ROLE ${role}`);
    for(const table of ['monthly_email_preparations','monthly_email_receipts']){
      await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
      await expect(sql.query(`UPDATE olbia.${table} SET month=month`)).rejects.toMatchObject({code:'42501'});
    }
    if(role==='olbia_reader')await expect(readMonthlyDelivery(sql,owner,'monthly_close',month)).rejects.toMatchObject({code:'42501'});
    else expect(await readMonthlyDelivery(sql,owner,'monthly_close',month)).toMatchObject({status:'sent',messageId:'original-receipt'});
    if(!['olbia_application','olbia_cutover'].includes(role))await expect(insertMonthlyDeliveryPreparation(sql,{kind:'month_end_reminder',owner,month,asOfDay:'2026-09-30',preparedAt:at,email:{subject:'Denied',html:'Denied',text:'Denied'}})).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');
  }
});

it('denies all historical recovery reads and forbids every role from mutating frozen delivery documents',async()=>{
  for(const role of ['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector']){
    await sql.query(`SET ROLE ${role}`);
    await expect(sql.query('SELECT * FROM olbia.delivery_records')).rejects.toMatchObject({code:'42501'});
    for(const action of ['DELETE FROM olbia.delivery_records','UPDATE olbia.delivery_records SET source_item=source_item'])await expect(sql.query(action)).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');
  }
});
