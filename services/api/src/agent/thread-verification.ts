import { withSqlClient } from '@finance/ledger/sql-runtime';
import { samePublicResult } from '../events/read-selection.js';
import { readerPool, withLedgerVerificationSnapshot, type ReadSqlClient } from '../events/sql-reads.js';
import { readStoredConversation, readStoredConversationIndex, readStoredConversationSelection } from './threads.js';

/** Current metadata oracle only. Frozen inventory and native provider membership are audited separately. */
const verifyThreadSnapshot=async(owner:string,now:Date,client:ReadSqlClient)=>{
  const started=Date.now();let mismatches=0,productReads=0,expiryChecks=0;
  const activated=(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=18')).rows.length===1;mismatches+=Number(!activated);
  const headers=(await client.query('SELECT * FROM olbia.conversation_threads ORDER BY id')).rows;
  const selections=(await client.query('SELECT * FROM olbia.assistant_thread_selection ORDER BY id')).rows;
  const required=['conversation_threads_pkey','conversation_threads_id_check','conversation_threads_owner_check','conversation_threads_title_check',
    'conversation_threads_first_month_check','conversation_threads_id_owner_key','assistant_thread_selection_pkey','assistant_thread_selection_id_check',
    'assistant_thread_selection_owner_check','assistant_thread_selection_owner_fk'];
  const constraints=(await client.query("SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace AND conname=ANY($1::text[]) ORDER BY conname",[required])).rows;
  mismatches+=Number(!samePublicResult(constraints,required.sort().map(conname=>({conname,convalidated:true}))));
  let requiredColumns=0;
  for(const [table,names] of Object.entries({conversation_threads:['id','owner','title','first_month','created_at','updated_at','expires_at'],assistant_thread_selection:['id','owner','updated_at']})){
    const actual=(await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attnotnull ORDER BY attname',[`olbia.${table}`])).rows;
    mismatches+=Number(!samePublicResult(actual,names.sort().map(attname=>({attname}))));requiredColumns+=actual.length;
  }
  const time=(v:unknown)=>new Date(v as string|Date).toISOString();
  const presentation=(r:Record<string,unknown>)=>({id:r.id,title:r.title,firstMonth:r.first_month,createdAt:time(r.created_at),updatedAt:time(r.updated_at)});
  const ids=new Map(headers.map(r=>[r.id,r]));
  for(const r of headers){
    mismatches+=Number(r.owner!==owner||typeof r.id!=='string'||r.id.length<33||r.id.length>100||!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(r.id)
      ||typeof r.title!=='string'||!r.title||r.title.length>72||typeof r.first_month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.first_month)
      ||Date.parse(time(r.expires_at))%1000!==0);
    const expected={...presentation(r),owner:r.owner,expiresAt:time(r.expires_at)};
    mismatches+=Number(!samePublicResult(expected,await readStoredConversation(String(r.owner),String(r.id))));productReads++;
  }
  mismatches+=Number(selections.length>1);
  for(const r of selections){const parent=r.thread_id==null?undefined:ids.get(r.thread_id);
    mismatches+=Number(r.id!==1||r.owner!==owner||(r.thread_id!==null&&(!parent||parent.owner!==r.owner)));
  }
  const choice=selections.find(r=>r.owner===owner);
  mismatches+=Number(!samePublicResult(choice?{configured:true,...(choice.thread_id==null?{}:{id:choice.thread_id})}:{configured:false},await readStoredConversationSelection(owner)));productReads++;
  const clocks=new Set([now.getTime(),...headers.flatMap(r=>[Date.parse(time(r.expires_at))-1,Date.parse(time(r.expires_at)),Date.parse(time(r.expires_at))+1,
    Date.parse(time(r.updated_at))+365*24*60*60*1000,Date.parse(time(r.updated_at))+365*24*60*60*1000+1])]);
  for(const clock of clocks){const expected=headers.filter(r=>r.owner===owner&&Date.parse(time(r.expires_at))>clock&&Date.parse(time(r.updated_at))>=clock-365*24*60*60*1000)
    .sort((a,b)=>time(b.updated_at).localeCompare(time(a.updated_at))||Buffer.compare(Buffer.from(String(a.id)),Buffer.from(String(b.id)))).map(presentation);
    mismatches+=Number(!samePublicResult(expected,await readStoredConversationIndex(owner,new Date(clock))));productReads++;expiryChecks++;
  }
  const foreign=`${owner}/sql-verification-nonowner`,first=headers[0];
  if(first){mismatches+=Number(await readStoredConversation(foreign,String(first.id))!==undefined);productReads++;}
  mismatches+=Number(!samePublicResult({configured:false},await readStoredConversationSelection(foreign)));productReads++;
  mismatches+=Number(!samePublicResult([],await readStoredConversationIndex(foreign,now)));productReads++;
  mismatches+=Number(await readStoredConversation(owner,'sql_verification_missing_conversation_000000001')!==undefined);productReads++;
  return {mode:'native-sql',activated,headers:headers.length,selectionRows:selections.length,productReads,expiryChecks,validatedConstraints:constraints.filter(r=>r.convalidated===true).length,requiredColumns,mismatches,elapsedMs:Date.now()-started};
};
export const verifyNativeConversationMetadata=(owner:string,now:Date,client?:ReadSqlClient)=>client
  ?withSqlClient(client,()=>verifyThreadSnapshot(owner,now,client))
  :withLedgerVerificationSnapshot(()=>verifyThreadSnapshot(owner,now,readerPool()));
