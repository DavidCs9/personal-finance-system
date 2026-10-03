import { createHash } from 'node:crypto';
import type { SqlClient } from './projection.js';

export type MonthlyDeliveryKind = 'monthly_close' | 'month_end_reminder';
export interface PreparedEmail { readonly subject:string; readonly html:string; readonly text:string }
export interface MonthlyCloseEvidence {
  readonly facts:Record<string,unknown>; readonly analysis:Record<string,unknown>;
  readonly analysisVersion:string; readonly analysisSource:'bedrock'|'fallback'; readonly analysisErrorName?:string;
}
interface Preparation {
  readonly owner:string; readonly month:string; readonly preparedAt:string; readonly email:PreparedEmail;
}
export type MonthlyDeliveryPreparation = Preparation & (
  {readonly kind:'monthly_close'; readonly report:MonthlyCloseEvidence}
  | {readonly kind:'month_end_reminder'; readonly asOfDay:string});
export type NativeMonthlyDelivery = MonthlyDeliveryPreparation & {
  readonly contentSha256:string; readonly status:'prepared'|'sent'; readonly sentAt?:string; readonly messageId?:string;
};
const invalid = () => {throw new Error('Invalid monthly delivery preparation');};
const conditional = () => {throw Object.assign(new Error('Monthly delivery precondition failed.'),{name:'ConditionalCheckFailedException'});};
export const monthlyEmailContentHash = (email:PreparedEmail):string =>
  createHash('sha256').update(email.subject).update('\0').update(email.html).update('\0').update(email.text).digest('hex');
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const validDay = (day:string):boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10)===day;
export const validateMonthlyDeliveryPreparation = (input:MonthlyDeliveryPreparation):void => {
  if(!input.owner || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) || !Number.isFinite(Date.parse(input.preparedAt))
    || !input.email || !['subject','html','text'].every(k=>typeof input.email[k as keyof PreparedEmail]==='string'))invalid();
  if(input.kind==='monthly_close'){
    if(!input.report || !record(input.report.facts) || !record(input.report.analysis) || !input.report.analysisVersion
      || !['bedrock','fallback'].includes(input.report.analysisSource)
      || (input.report.analysisErrorName!==undefined && typeof input.report.analysisErrorName!=='string'))invalid();
  }else if(input.kind!=='month_end_reminder' || !validDay(input.asOfDay) || input.asOfDay.slice(0,7)!==input.month)invalid();
};
const iso=(v:unknown):string=>new Date(v as string|Date).toISOString();
export const decodeMonthlyDelivery=(r:Record<string,unknown>):NativeMonthlyDelivery=>{
  const base={owner:String(r.owner),month:String(r.month),preparedAt:iso(r.prepared_at),contentSha256:String(r.content_sha256),
    email:{subject:String(r.email_subject),html:String(r.email_html),text:String(r.email_text)},
    status:r.sent_at==null?'prepared' as const:'sent' as const,
    ...(r.sent_at==null?{}:{sentAt:iso(r.sent_at),messageId:String(r.provider_message_id)})};
  return r.delivery_kind==='monthly_close'?{...base,kind:'monthly_close',report:{facts:r.report_facts as Record<string,unknown>,analysis:r.report_analysis as Record<string,unknown>,
    analysisVersion:String(r.analysis_version),analysisSource:r.analysis_source as 'bedrock'|'fallback',...(r.analysis_error_name==null?{}:{analysisErrorName:String(r.analysis_error_name)})}}
    :{...base,kind:'month_end_reminder',asOfDay:r.as_of_day instanceof Date?r.as_of_day.toISOString().slice(0,10):String(r.as_of_day)};
};
/** Status is derived from immutable provider receipt existence, not a mutable document field. */
export const readMonthlyDelivery=async(client:SqlClient,owner:string,kind:MonthlyDeliveryKind,month:string):Promise<NativeMonthlyDelivery|undefined>=>{
  const row=(await client.query(`SELECT p.*,r.sent_at,r.provider_message_id FROM olbia.monthly_email_preparations p
    LEFT JOIN olbia.monthly_email_receipts r USING (delivery_kind,month)
    WHERE p.owner=$1 AND p.delivery_kind=$2 AND p.month=$3`,[owner,kind,month])).rows[0];
  return row?decodeMonthlyDelivery(row):undefined;
};
export const insertMonthlyDeliveryPreparation=async(client:SqlClient,input:MonthlyDeliveryPreparation):Promise<void>=>{
  validateMonthlyDeliveryPreparation(input);
  const report=input.kind==='monthly_close'?input.report:undefined;
  const result=await client.query(`INSERT INTO olbia.monthly_email_preparations
    (delivery_kind,month,owner,prepared_at,content_sha256,email_subject,email_html,email_text,report_facts,report_analysis,
      analysis_version,analysis_source,analysis_error_name,as_of_day)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (delivery_kind,month) DO NOTHING RETURNING month`,[input.kind,input.month,input.owner,input.preparedAt,monthlyEmailContentHash(input.email),
    input.email.subject,input.email.html,input.email.text,report?JSON.stringify(report.facts):null,report?JSON.stringify(report.analysis):null,
    report?.analysisVersion??null,report?.analysisSource??null,report?.analysisErrorName??null,input.kind==='month_end_reminder'?input.asOfDay:null]);
  if(!result.rows.length)conditional();
};
export const insertMonthlyDeliveryReceipt=async(client:SqlClient,input:{readonly owner:string;readonly kind:MonthlyDeliveryKind;readonly month:string;readonly messageId:string;readonly sentAt:string}):Promise<void>=>{
  if(!input.messageId || !Number.isFinite(Date.parse(input.sentAt)))invalid();
  const result=await client.query(`INSERT INTO olbia.monthly_email_receipts (delivery_kind,month,sent_at,provider_message_id)
    SELECT delivery_kind,month,$4,$5 FROM olbia.monthly_email_preparations
    WHERE owner=$1 AND delivery_kind=$2 AND month=$3 AND prepared_at<=$4::timestamptz
    ON CONFLICT (delivery_kind,month) DO NOTHING RETURNING month`,[input.owner,input.kind,input.month,input.sentAt,input.messageId]);
  if(!result.rows.length)conditional();
};
