import { canonicalJson, projectRows, TABLE_COLUMNS, type SourceItem } from './model.js';
import type { SqlClient, TransactionPool } from './projection.js';
import { monthlyEmailContentHash, validateMonthlyDeliveryPreparation, insertMonthlyDeliveryPreparation, insertMonthlyDeliveryReceipt,
  type MonthlyDeliveryPreparation, type MonthlyCloseEvidence } from './delivery.js';

type Row=Record<string,unknown>;
const invalid=():never=>{throw new Error('Retained monthly delivery mapping is inconsistent');};
const object=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:invalid();
const text=(v:unknown):string=>typeof v==='string'?v:invalid();
const iso=(v:unknown):string=>{const at=new Date(text(v));return Number.isFinite(at.getTime())?at.toISOString():invalid();};
const known=(r:Row,keys:readonly string[])=>{if(Object.keys(r).some(k=>!keys.includes(k)))invalid();};
export const prepareDeliveryCopy=(retained:readonly Row[])=>{
  const identities=new Set<string>(),owners=new Set<string>();
  const preparations:MonthlyDeliveryPreparation[]=[],receipts:{owner:string;kind:MonthlyDeliveryPreparation['kind'];month:string;messageId:string;sentAt:string}[]=[];
  for(const r of retained){
    const p=object(r.source_item),email=object(p.email);known(email,['subject','html','text']);
    const kind=p.entityType==='monthly_close_report'?'monthly_close':p.entityType==='month_end_balance_reminder'?'month_end_reminder':invalid();
    known(p,['PK','SK','entityType','owner','month','status','preparedAt','contentSha256','email','sentAt','sesMessageId',
      ...(kind==='monthly_close'?['facts','analysis','analysisVersion','analysisSource','analysisErrorName']:['asOfDay'])]);
    const owner=text(p.owner),month=text(p.month),identity=`${kind}/${month}`;
    if(p.PK!==`USER#${owner}`||p.SK!==`${kind==='monthly_close'?'MONTHLY_CLOSE':'MONTH_END_BALANCE_REMINDER'}#${month}`||identities.has(identity))invalid();
    identities.add(identity);owners.add(owner);
    const base={owner,month,preparedAt:iso(p.preparedAt),email:{subject:text(email.subject),html:text(email.html),text:text(email.text)}};
    const input:MonthlyDeliveryPreparation=kind==='monthly_close'?{...base,kind,report:{facts:object(p.facts),analysis:object(p.analysis),analysisVersion:text(p.analysisVersion),
      analysisSource:p.analysisSource as MonthlyCloseEvidence['analysisSource'],...(p.analysisErrorName===undefined?{}:{analysisErrorName:text(p.analysisErrorName)})}}
      :{...base,kind,asOfDay:text(p.asOfDay)};
    validateMonthlyDeliveryPreparation(input);if(p.contentSha256!==monthlyEmailContentHash(input.email))invalid();
    const projected=projectRows({PK:text(p.PK),SK:text(p.SK)},p as SourceItem);
    const normalize=(v:Row)=>Object.fromEntries(Object.entries(v).map(([k,value])=>[k,value==null?value:
      (TABLE_COLUMNS.delivery_records as Record<string,string>)[k]==='timestamptz'?new Date(value as string|Date).toISOString():
      (TABLE_COLUMNS.delivery_records as Record<string,string>)[k]==='bigint'?String(value):value]));
    if(projected.length!==1||projected[0].table!=='delivery_records'||canonicalJson(normalize(projected[0].values))!==canonicalJson(normalize(r)))invalid();
    preparations.push(input);
    if(p.status==='sent'){
      const sentAt=iso(p.sentAt),messageId=text(p.sesMessageId);if(!messageId||sentAt<input.preparedAt)invalid();
      receipts.push({owner,kind,month,messageId,sentAt});
    }else if(p.status!=='prepared'||p.sentAt!==undefined||p.sesMessageId!==undefined)invalid();
  }
  if(owners.size>1||preparations.length+receipts.length+2>3000||Buffer.byteLength(JSON.stringify({preparations,receipts}))>8*1024*1024)invalid();
  return{preparations,receipts};
};
export const migrateMonthlyDeliveries=async(pool:TransactionPool):Promise<void>=>{
  await pool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=17')).rows.length)return;
    if((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode!=='sql'
      ||(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=16')).rows.length!==1)invalid();
    for(const table of ['monthly_email_preparations','monthly_email_receipts'])if((await client.query(`SELECT 1 FROM olbia.${table} LIMIT 1`)).rows.length)invalid();
    const copy=prepareDeliveryCopy((await client.query('SELECT * FROM olbia.delivery_records')).rows);
    for(const input of copy.preparations)await insertMonthlyDeliveryPreparation(client,input);
    for(const input of copy.receipts)await insertMonthlyDeliveryReceipt(client,input);
    await client.query('INSERT INTO olbia.schema_migrations VALUES (17,CURRENT_TIMESTAMP)');
  });
};
