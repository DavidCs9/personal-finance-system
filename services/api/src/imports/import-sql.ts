import { applicationStoreClient,withNativeTransaction } from '@finance/ledger/dsql-store';
import { reserveLedgerMutations } from '@finance/ledger/native-ledger';
import { readerPool,type ReadSqlClient } from '../events/sql-reads.js';
import type { StatementCandidate,StatementPreviewRow,StatementRowStatus,StatementProvider } from './statement-reconciliation.js';

export type BankImportKind='amex_statement'|'santander_statement'|'santander_csv';
export const statementImportKind=(provider:StatementProvider):BankImportKind=>provider==='amex'?'amex_statement':'santander_statement';
export type BankImportRow=Omit<StatementPreviewRow,'kind'> & {
  readonly kind?:'purchase'|'msi';readonly rowNumber?:number;readonly occurrence?:number;readonly transactionId?:string;
};
export type BankImportResult={readonly created:number;readonly linked:number;readonly skipped:number;
  readonly msiConfirmed?:number;readonly createdUnplanned?:number};
export type BankImportRecord={
  readonly kind:BankImportKind;readonly importId:string;readonly owner:string;
  readonly status:'processing'|'previewed'|'applied'|'failed';readonly createdAt:string;
  readonly previewedAt?:string;readonly appliedAt?:string;readonly accountLastFour?:string;readonly product?:string;
  readonly period?:{readonly from:string;readonly to:string};
  readonly source:{readonly bucket:string;readonly key:string;readonly sha256:string;readonly contentType:string};
  readonly textractJobId?:string;readonly extractionKey?:string;readonly textractAnswers?:Readonly<Record<string,string>>;
  readonly errorMessage?:string;readonly result?:BankImportResult;readonly rows:readonly BankImportRow[];
};
export class BankImportError extends Error {}
const changed=()=>new BankImportError('La importación cambió. Vuelve a consultar el archivo.');
const iso=(value:unknown):string=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();

/** One SQL snapshot includes the parent, ordered assertions and historical labels. */
export const readBankImport=async(kind:BankImportKind,importId:string,owner:string,client:ReadSqlClient=readerPool()):Promise<BankImportRecord|undefined>=>{
  const result=await client.query(`SELECT parent.*,parent.period_start::text AS period_start,parent.period_end::text AS period_end,
    line.position AS row_position,line.identity,line.occurred_on::text AS occurred_on,line.merchant_raw,line.amount_mxn_minor,
    line.status AS row_status,line.row_kind,line.is_credit,line.installment_index,line.installment_months,line.original_amount_mxn_minor,
    line.row_number,line.occurrence,line.bank_transaction_id,line.selected_movement_id,
    candidate.position AS candidate_position,candidate.movement_id AS candidate_id,candidate.merchant_raw AS candidate_merchant,
    candidate.occurred_at AS candidate_occurred_at
    FROM olbia.bank_imports parent LEFT JOIN olbia.bank_import_rows line ON line.kind=parent.kind AND line.content_sha256=parent.content_sha256
    LEFT JOIN olbia.bank_import_candidates candidate ON candidate.kind=line.kind AND candidate.content_sha256=line.content_sha256 AND candidate.row_position=line.position
    WHERE parent.kind=$1 AND parent.content_sha256=$2 AND parent.owner=$3 ORDER BY line.position,candidate.position`,[kind,importId,owner]);
  const first=result.rows[0];if(!first)return undefined;
  const rows=new Map<number,BankImportRow & {candidateEventIds:string[];candidates:StatementCandidate[]}>();
  for(const raw of result.rows){
    if(raw.row_position==null)continue;
    const position=Number(raw.row_position);
    let line=rows.get(position);
    if(!line){
      line={identity:String(raw.identity),occurredOn:String(raw.occurred_on),merchantRaw:String(raw.merchant_raw),amountMinor:Number(raw.amount_mxn_minor),
        status:raw.row_status as StatementRowStatus,candidateEventIds:[],candidates:[],
        ...(raw.row_kind!=null?{kind:raw.row_kind as 'purchase'|'msi',msi:raw.row_kind==='msi'}:{}),
        ...(raw.is_credit!=null?{credit:Boolean(raw.is_credit)}:{}),
        ...(raw.installment_index!=null?{installmentIndex:Number(raw.installment_index)}:{}),
        ...(raw.installment_months!=null?{installmentMonths:Number(raw.installment_months)}:{}),
        ...(raw.original_amount_mxn_minor!=null?{originalAmountMinor:Number(raw.original_amount_mxn_minor)}:{}),
        ...(raw.row_number!=null?{rowNumber:Number(raw.row_number)}:{}),...(raw.occurrence!=null?{occurrence:Number(raw.occurrence)}:{}),
        ...(raw.bank_transaction_id!=null?{transactionId:String(raw.bank_transaction_id)}:{}),
        ...(raw.selected_movement_id!=null?{eventId:String(raw.selected_movement_id)}:{})};
      rows.set(position,line);
    }
    if(raw.candidate_position!=null){
      line.candidateEventIds.push(String(raw.candidate_id));
      if(raw.candidate_merchant!=null)line.candidates.push({id:String(raw.candidate_id),merchantRaw:String(raw.candidate_merchant),
        ...(raw.candidate_occurred_at!=null?{occurredAt:iso(raw.candidate_occurred_at)}:{})});
    }
  }
  return {kind,importId,owner,status:first.status as BankImportRecord['status'],createdAt:iso(first.created_at),rows:[...rows.values()],
    source:{bucket:String(first.evidence_bucket),key:String(first.evidence_key),sha256:importId,contentType:String(first.evidence_content_type)},
    ...(first.previewed_at!=null?{previewedAt:iso(first.previewed_at)}:{}),...(first.applied_at!=null?{appliedAt:iso(first.applied_at)}:{}),
    ...(first.account_last_four!=null?{accountLastFour:String(first.account_last_four)}:{}),...(first.product!=null?{product:String(first.product)}:{}),
    ...(first.period_start!=null?{period:{from:String(first.period_start),to:String(first.period_end)}}:{}),
    ...(first.textract_job_id!=null?{textractJobId:String(first.textract_job_id)}:{}),...(first.extraction_key!=null?{extractionKey:String(first.extraction_key)}:{}),
    ...(first.textract_answers!=null?{textractAnswers:first.textract_answers as Readonly<Record<string,string>>}:{}),
    ...(first.error_message!=null?{errorMessage:String(first.error_message)}:{}),
    ...(first.result_created!=null?{result:{created:Number(first.result_created),linked:Number(first.result_linked),skipped:Number(first.result_skipped),
      ...(first.result_msi_confirmed!=null?{msiConfirmed:Number(first.result_msi_confirmed)}:{}),
      ...(first.result_created_unplanned!=null?{createdUnplanned:Number(first.result_created_unplanned)}:{})}}:{})};
};

const putHeader=async(client:ReadSqlClient,record:BankImportRecord):Promise<void>=>{
  if(record.source.sha256!==record.importId)throw new BankImportError('La evidencia no coincide con la importación.');
  reserveLedgerMutations(1);
  const saved=await client.query(`INSERT INTO olbia.bank_imports (kind,content_sha256,owner,status,created_at,previewed_at,applied_at,account_last_four,product,
    period_start,period_end,evidence_bucket,evidence_key,evidence_content_type,textract_job_id,extraction_key,textract_answers,error_message,
    result_created,result_linked,result_skipped,result_msi_confirmed,result_created_unplanned)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    ON CONFLICT (kind,content_sha256) DO UPDATE SET status=EXCLUDED.status,previewed_at=EXCLUDED.previewed_at,applied_at=EXCLUDED.applied_at,
      account_last_four=EXCLUDED.account_last_four,product=EXCLUDED.product,period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,
      evidence_bucket=EXCLUDED.evidence_bucket,evidence_key=EXCLUDED.evidence_key,evidence_content_type=EXCLUDED.evidence_content_type,
      textract_job_id=EXCLUDED.textract_job_id,extraction_key=EXCLUDED.extraction_key,textract_answers=EXCLUDED.textract_answers,error_message=EXCLUDED.error_message,
      result_created=EXCLUDED.result_created,result_linked=EXCLUDED.result_linked,result_skipped=EXCLUDED.result_skipped,
      result_msi_confirmed=EXCLUDED.result_msi_confirmed,result_created_unplanned=EXCLUDED.result_created_unplanned
    WHERE olbia.bank_imports.owner=EXCLUDED.owner AND olbia.bank_imports.status<>'applied' RETURNING content_sha256`,[
    record.kind,record.importId,record.owner,record.status,record.createdAt,record.previewedAt??null,record.appliedAt??null,record.accountLastFour??null,
    record.product??null,record.period?.from??null,record.period?.to??null,record.source.bucket,record.source.key,record.source.contentType,
    record.textractJobId??null,record.extractionKey??null,record.textractAnswers?JSON.stringify(record.textractAnswers):null,record.errorMessage??null,
    record.result?.created??null,record.result?.linked??null,record.result?.skipped??null,record.result?.msiConfirmed??null,record.result?.createdUnplanned??null]);
  if(!saved.rows.length)throw changed();
};
type CandidateInsert={rowPosition:number;position:number;id:string;merchantRaw?:string;occurredAt?:string};
const prepareRows=async(client:ReadSqlClient,record:BankImportRecord):Promise<CandidateInsert[]>=>{
  const candidates=record.rows.flatMap((row,rowPosition)=>row.candidateEventIds.map((id,position)=>{
    const label=row.candidates.find(c=>c.id===id);
    return {rowPosition,position,id,merchantRaw:label?.merchantRaw,occurredAt:label?.occurredAt};
  }));
  const old=Number((await client.query(`SELECT (SELECT count(*) FROM olbia.bank_import_rows WHERE kind=$1 AND content_sha256=$2)+
    (SELECT count(*) FROM olbia.bank_import_candidates WHERE kind=$1 AND content_sha256=$2) AS count`,[record.kind,record.importId])).rows[0]?.count);
  if(old+record.rows.length+candidates.length+2>3000)throw new BankImportError('El archivo tiene demasiadas filas para guardarlo en una sola operación.');
  for(const row of record.rows){
    if(new Set(row.candidateEventIds).size!==row.candidateEventIds.length)throw changed();
    let prior=-1;
    for(const label of row.candidates){const position=row.candidateEventIds.indexOf(label.id);if(position<=prior)throw changed();prior=position;}
    if(row.msi!==undefined && (row.kind===undefined || row.msi!==(row.kind==='msi')))throw changed();
  }
  return candidates;
};
const replaceRows=async(client:ReadSqlClient,record:BankImportRecord,candidates:readonly CandidateInsert[]):Promise<void>=>{
  await client.query('DELETE FROM olbia.bank_import_candidates WHERE kind=$1 AND content_sha256=$2',[record.kind,record.importId]);
  await client.query('DELETE FROM olbia.bank_import_rows WHERE kind=$1 AND content_sha256=$2',[record.kind,record.importId]);
  // JSON is transient parameter transport for one native INSERT, never persisted.
  await client.query(`INSERT INTO olbia.bank_import_rows (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,
    row_kind,is_credit,installment_index,installment_months,original_amount_mxn_minor,row_number,occurrence,bank_transaction_id,selected_movement_id)
    SELECT $1,$2,(row.position-1)::integer,row.item->>'identity',(row.item->>'occurredOn')::date,row.item->>'merchantRaw',
      (row.item->>'amountMinor')::bigint,row.item->>'status',row.item->>'kind',(row.item->>'credit')::boolean,
      (row.item->>'installmentIndex')::integer,(row.item->>'installmentMonths')::integer,(row.item->>'originalAmountMinor')::bigint,
      (row.item->>'rowNumber')::integer,(row.item->>'occurrence')::integer,row.item->>'transactionId',row.item->>'eventId'
    FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS row(item,position)`,[record.kind,record.importId,JSON.stringify(record.rows)]);
  await client.query(`INSERT INTO olbia.bank_import_candidates (kind,content_sha256,row_position,position,movement_id,merchant_raw,occurred_at)
    SELECT $1,$2,(candidate.item->>'rowPosition')::integer,(candidate.item->>'position')::integer,candidate.item->>'id',
      candidate.item->>'merchantRaw',(candidate.item->>'occurredAt')::timestamptz FROM jsonb_array_elements($3::jsonb) AS candidate(item)`,
    [record.kind,record.importId,JSON.stringify(candidates)]);
};

export const startBankImport=(record:BankImportRecord):Promise<BankImportRecord>=>withNativeTransaction(async()=>{
  const client=applicationStoreClient();const existing=await readBankImport(record.kind,record.importId,record.owner,client);
  if(existing?.status==='applied' || existing?.status==='processing' && record.status==='processing')return existing;
  const candidates=await prepareRows(client,record);
  await putHeader(client,{...record,createdAt:existing?.createdAt??record.createdAt});await replaceRows(client,record,candidates);
  return (await readBankImport(record.kind,record.importId,record.owner,client))!;
});
export const saveStatementPreview=(kind:BankImportKind,importId:string,owner:string,jobId:string,preview:Pick<BankImportRecord,
  'accountLastFour'|'product'|'period'|'rows'|'extractionKey'|'textractAnswers'>):Promise<BankImportRecord>=>withNativeTransaction(async()=>{
  const client=applicationStoreClient();const existing=await readBankImport(kind,importId,owner,client);if(!existing)throw changed();
  if(existing.status!=='processing' || existing.textractJobId!==jobId)return existing;
  const record={...existing,...preview,status:'previewed' as const,previewedAt:new Date().toISOString(),errorMessage:undefined};
  const candidates=await prepareRows(client,record);
  await putHeader(client,record);await replaceRows(client,record,candidates);return record;
});
export const failBankImport=(kind:BankImportKind,importId:string,owner:string,jobId:string,errorMessage:string,
  evidence:Pick<BankImportRecord,'extractionKey'|'textractAnswers'>={}):Promise<BankImportRecord>=>withNativeTransaction(async()=>{
  const client=applicationStoreClient();const existing=await readBankImport(kind,importId,owner,client);if(!existing)throw changed();
  if(existing.status!=='processing' || existing.textractJobId!==jobId)return existing;
  const record={...existing,...evidence,status:'failed' as const,errorMessage};await putHeader(client,record);return record;
});
export const completeBankImport=(kind:BankImportKind,importId:string,owner:string,appliedAt:string,result:BankImportResult):Promise<BankImportRecord>=>
  withNativeTransaction(async()=>{
    const client=applicationStoreClient();const existing=await readBankImport(kind,importId,owner,client);if(!existing)throw changed();
    if(existing.status==='applied')return existing;if(existing.status!=='previewed')throw changed();
    const record={...existing,status:'applied' as const,appliedAt,result};await putHeader(client,record);return record;
  });
