import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import type { ReadSqlClient } from '../events/sql-reads.js';
import { samePublicResult } from '../events/read-selection.js';
import { readBankImport, type BankImportRecord, type BankImportKind } from './import-sql.js';

const iso=(value:unknown)=>new Date(value as string|Date).toISOString();
const headerColumns=(r:BankImportRecord)=>({kind:r.kind,content_sha256:r.importId,owner:r.owner,status:r.status,created_at:r.createdAt,
  previewed_at:r.previewedAt??null,applied_at:r.appliedAt??null,account_last_four:r.accountLastFour??null,product:r.product??null,
  period_start:r.period?.from??null,period_end:r.period?.to??null,evidence_bucket:r.source.bucket,evidence_key:r.source.key,
  evidence_content_type:r.source.contentType,textract_job_id:r.textractJobId??null,extraction_key:r.extractionKey??null,
  textract_answers:r.textractAnswers??null,error_message:r.errorMessage??null,result_created:r.result?.created??null,
  result_linked:r.result?.linked??null,result_skipped:r.result?.skipped??null,result_msi_confirmed:r.result?.msiConfirmed??null,
  result_created_unplanned:r.result?.createdUnplanned??null});
const rowColumns=(r:BankImportRecord)=>r.rows.map((l,position)=>({kind:r.kind,content_sha256:r.importId,position,identity:l.identity,
  occurred_on:l.occurredOn,merchant_raw:l.merchantRaw,amount_mxn_minor:String(l.amountMinor),status:l.status,row_kind:l.kind??null,
  is_credit:l.credit??null,installment_index:l.installmentIndex??null,installment_months:l.installmentMonths??null,
  original_amount_mxn_minor:l.originalAmountMinor==null?null:String(l.originalAmountMinor),row_number:l.rowNumber??null,
  occurrence:l.occurrence??null,bank_transaction_id:l.transactionId??null,selected_movement_id:l.eventId??null}));
const candidateColumns=(r:BankImportRecord)=>r.rows.flatMap((l,row_position)=>l.candidateEventIds.map((id,position)=>{
  const label=l.candidates.find(c=>c.id===id);
  return {kind:r.kind,content_sha256:r.importId,row_position,position,movement_id:id,merchant_raw:label?.merchantRaw??null,
    occurred_at:label?.occurredAt??null};
}));
const kindFromFrozen=(item:JsonObject):BankImportKind=>String(item.SK).startsWith('IMPORT#AMEX#')?'amex_statement':
  String(item.SK).startsWith('IMPORT#SANTANDER_STATEMENT#')?'santander_statement':'santander_csv';

/** Independent raw-column, immutable capture and original-file checks; never polls or mutates imports. */
export const verifyNativeImports=async(owner:string,frozen:readonly JsonObject[],client:ReadSqlClient)=>{
  const started=Date.now();let mismatches=0,evidenceFiles=0,extractionFiles=0,frozenApplied=0;
  const check=(a:unknown,b:unknown)=>{mismatches+=Number(!samePublicResult(a,b));};
  const headers=(await client.query(`SELECT *,period_start::text AS period_start,period_end::text AS period_end
    FROM olbia.bank_imports WHERE owner=$1 ORDER BY kind,content_sha256`,[owner])).rows;
  const records:BankImportRecord[]=[];
  for(const h of headers){
    const r=await readBankImport(h.kind as BankImportKind,String(h.content_sha256),owner,client);
    if(!r){mismatches++;continue;}records.push(r);
    const normalized={...h,created_at:iso(h.created_at),previewed_at:h.previewed_at==null?null:iso(h.previewed_at),applied_at:h.applied_at==null?null:iso(h.applied_at)};
    check(normalized,headerColumns(r));
    const rows=(await client.query(`SELECT *,occurred_on::text AS occurred_on FROM olbia.bank_import_rows
      WHERE kind=$1 AND content_sha256=$2 ORDER BY position`,[r.kind,r.importId])).rows;
    check(rows.map(l=>({...l,amount_mxn_minor:String(l.amount_mxn_minor),original_amount_mxn_minor:l.original_amount_mxn_minor==null?null:String(l.original_amount_mxn_minor)})),rowColumns(r));
    const candidates=(await client.query(`SELECT * FROM olbia.bank_import_candidates WHERE kind=$1 AND content_sha256=$2 ORDER BY row_position,position`,[r.kind,r.importId])).rows;
    check(candidates.map(c=>({...c,occurred_at:c.occurred_at==null?null:iso(c.occurred_at)})),candidateColumns(r));
    const file=await s3.send(new GetObjectCommand({Bucket:r.source.bucket,Key:r.source.key}));
    if(!file.Body)throw new Error('Missing bank import evidence body');
    check(createHash('sha256').update(await file.Body.transformToByteArray()).digest('hex'),r.importId);evidenceFiles++;
    if(r.extractionKey){
      const object=await s3.send(new GetObjectCommand({Bucket:r.source.bucket,Key:r.extractionKey}));
      if(!object.Body)throw new Error('Missing retained extraction body');
      const extraction=JSON.parse(await object.Body.transformToString()) as JsonObject;
      check(Boolean(extraction.answers && typeof extraction.answers==='object' && !Array.isArray(extraction.answers) && Array.isArray(extraction.tables)),true);
      extractionFiles++;
    }
  }
  for(const item of frozen){
    const kind=kindFromFrozen(item),importId=String(item.SK).split('#')[2]!;
    const r=records.find(r=>r.kind===kind && r.importId===importId);
    // Pending captures may legitimately refresh/apply. Their source identity and first creation remain immutable.
    check(r?.source,item.source);check(r?.createdAt,iso(item.createdAt??item.previewedAt));
    if(item.status!=='applied')continue;
    frozenApplied++;
    if(!r){mismatches++;continue;}
    const expected={kind,importId,owner,status:'applied',createdAt:iso(item.createdAt??item.previewedAt),source:item.source,
      rows:item.rows,...Object.fromEntries(['previewedAt','appliedAt','accountLastFour','product','period','textractJobId','extractionKey','textractAnswers','errorMessage','result']
        .filter(k=>item[k]!==undefined).map(k=>[k,item[k]]))};
    check(r,expected);
  }
  const invalidReferences=Number((await client.query(`SELECT count(*) AS count FROM (
    SELECT line.kind FROM olbia.bank_import_rows line LEFT JOIN olbia.bank_imports parent
      ON parent.kind=line.kind AND parent.content_sha256=line.content_sha256 WHERE parent.kind IS NULL
    UNION ALL SELECT candidate.kind FROM olbia.bank_import_candidates candidate LEFT JOIN olbia.bank_import_rows line
      ON line.kind=candidate.kind AND line.content_sha256=candidate.content_sha256 AND line.position=candidate.row_position WHERE line.kind IS NULL
  ) invalid`)).rows[0]?.count);check(invalidReferences,0);
  const constraints=(await client.query(`SELECT conname,contype,convalidated FROM pg_constraint
    WHERE conrelid IN ('olbia.bank_imports'::regclass,'olbia.bank_import_rows'::regclass,'olbia.bank_import_candidates'::regclass)
    AND contype IN ('p','f','u','c') ORDER BY conname`)).rows;
  const keys=['bank_imports_pkey','bank_import_rows_pkey','bank_import_rows_identity_key','bank_import_rows_import_fk',
    'bank_import_candidates_pkey','bank_import_candidates_movement_key','bank_import_candidates_row_fk'].sort();
  check(constraints.filter(c=>c.contype!=='c').map(c=>({conname:c.conname,convalidated:c.convalidated})),keys.map(conname=>({conname,convalidated:true})));
  const checks=constraints.filter(c=>c.contype==='c');check(checks.length,37);check(checks.every(c=>c.convalidated===true),true);
  check((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows,[{version:13}]);
  check(await readBankImport('santander_csv','0'.repeat(64),owner,client),undefined);
  return {authority:'native-sql',imports:records.length,rows:records.reduce((n,r)=>n+r.rows.length,0),
    candidates:records.reduce((n,r)=>n+r.rows.reduce((n,l)=>n+l.candidateEventIds.length,0),0),
    candidateLabels:records.reduce((n,r)=>n+r.rows.reduce((n,l)=>n+l.candidates.length,0),0),
    frozenApplied,invalidReferences,validatedConstraints:constraints.filter(c=>c.convalidated).length,evidenceFiles,extractionFiles,
    missingLookups:1,mismatches,elapsedMs:Date.now()-started};
};
