import { createHash } from 'node:crypto';
import { withSqlClient } from '@finance/ledger/sql-runtime';
import { samePublicResult } from '../events/read-selection.js';
import { readerPool, withLedgerVerificationSnapshot, type ReadSqlClient } from '../events/sql-reads.js';
import { getMonthlyEmailDelivery } from './delivery-store.js';

/** Independent current facts; frozen delivery recovery is verified separately. Never sends or renders. */
const verifyDeliverySnapshot=async(owner:string,client:ReadSqlClient)=>{
  const started=Date.now();let mismatches=0,workerReads=0;
  const activated=(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=17')).rows.length===1;mismatches+=Number(!activated);
  const preparations=(await client.query('SELECT * FROM olbia.monthly_email_preparations ORDER BY delivery_kind,month')).rows;
  const receipts=(await client.query('SELECT * FROM olbia.monthly_email_receipts ORDER BY delivery_kind,month')).rows;
  const requiredConstraints=['monthly_email_preparations_pkey','monthly_email_preparations_delivery_kind_check','monthly_email_preparations_month_check',
    'monthly_email_preparations_owner_check','monthly_email_preparations_content_sha256_check','monthly_email_preparations_report_facts_check',
    'monthly_email_preparations_report_analysis_check','monthly_email_preparations_analysis_version_check','monthly_email_preparations_analysis_source_check',
    'monthly_email_preparation_variant_check','monthly_email_receipts_pkey','monthly_email_receipts_provider_message_id_check','monthly_email_receipt_preparation_fk'];
  const constraints=(await client.query("SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace AND conname=ANY($1::text[]) ORDER BY conname",[requiredConstraints])).rows;
  mismatches+=Number(!samePublicResult(constraints,requiredConstraints.sort().map(conname=>({conname,convalidated:true}))));
  const requiredColumns={monthly_email_preparations:['delivery_kind','month','owner','prepared_at','content_sha256','email_subject','email_html','email_text'],
    monthly_email_receipts:['delivery_kind','month','sent_at','provider_message_id']};let requiredNotNull=0;
  for(const [table,names] of Object.entries(requiredColumns)){
    const columns=(await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attnotnull ORDER BY attname',[`olbia.${table}`])).rows;
    mismatches+=Number(!samePublicResult(columns,names.sort().map(attname=>({attname}))));requiredNotNull+=columns.length;
  }
  const identity=(r:Record<string,unknown>)=>JSON.stringify([r.delivery_kind,r.month]),byKey=new Map(receipts.map(r=>[identity(r),r]));
  const time=(v:unknown)=>new Date(v as string|Date).toISOString(),date=(v:unknown)=>v instanceof Date?v.toISOString().slice(0,10):String(v);
  for(const p of preparations){
    const receipt=byKey.get(identity(p));byKey.delete(identity(p));
    const email={subject:String(p.email_subject),html:String(p.email_html),text:String(p.email_text)};
    const hash=createHash('sha256').update(email.subject).update('\0').update(email.html).update('\0').update(email.text).digest('hex');
    const close=p.delivery_kind==='monthly_close',reminder=p.delivery_kind==='month_end_reminder';
    const object=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
    mismatches+=Number(!close&&!reminder||p.owner!==owner||typeof p.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)||p.content_sha256!==hash
      ||!['email_subject','email_html','email_text'].every(k=>typeof p[k]==='string')
      ||(close&&(!object(p.report_facts)||!object(p.report_analysis)||typeof p.analysis_version!=='string'||!p.analysis_version||!['bedrock','fallback'].includes(String(p.analysis_source))||p.as_of_day!==null))
      ||(reminder&&(['report_facts','report_analysis','analysis_version','analysis_source','analysis_error_name'].some(k=>p[k]!==null)||date(p.as_of_day).slice(0,7)!==p.month))
      ||(receipt!==undefined&&(typeof receipt.provider_message_id!=='string'||!receipt.provider_message_id||time(receipt.sent_at)<time(p.prepared_at))));
    const expected={owner:String(p.owner),kind:p.delivery_kind,month:String(p.month),preparedAt:time(p.prepared_at),contentSha256:hash,email,
      status:receipt?'sent':'prepared',...(receipt?{sentAt:time(receipt.sent_at),messageId:receipt.provider_message_id}:{}),
      ...(close?{report:{facts:p.report_facts,analysis:p.report_analysis,analysisVersion:p.analysis_version,analysisSource:p.analysis_source,
        ...(p.analysis_error_name===null?{}:{analysisErrorName:p.analysis_error_name})}}:{asOfDay:date(p.as_of_day)})};
    mismatches+=Number(!samePublicResult(expected,await getMonthlyEmailDelivery(String(p.owner),close?'monthly_close':'month_end_reminder',String(p.month))));workerReads++;
  }
  mismatches+=byKey.size;
  const first=preparations[0];
  mismatches+=Number(await getMonthlyEmailDelivery(`${owner}/sql-verification-nonowner`,first?.delivery_kind==='month_end_reminder'?'month_end_reminder':'monthly_close',String(first?.month??'9999-12'))!==undefined);workerReads++;
  mismatches+=Number(await getMonthlyEmailDelivery(owner,'monthly_close','9999-12')!==undefined);workerReads++;
  return {mode:'native-sql',activated,preparations:preparations.length,receipts:receipts.length,prepared:preparations.length-receipts.length,
    sent:receipts.length,contentHashes:preparations.length,workerReads,validatedConstraints:constraints.filter(r=>r.convalidated===true).length,requiredColumns:requiredNotNull,mismatches,elapsedMs:Date.now()-started};
};
export const verifyNativeMonthlyDeliveries=(owner:string,client?:ReadSqlClient)=>client
  ?withSqlClient(client,()=>verifyDeliverySnapshot(owner,client))
  :withLedgerVerificationSnapshot(()=>verifyDeliverySnapshot(owner,readerPool()));
