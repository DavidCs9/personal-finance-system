import type { SqlClient } from './projection.js';
export const CONVERSATION_RETENTION_MS=365*24*60*60*1000;
export interface ConversationThread {
  readonly id:string; readonly title:string; readonly firstMonth:string;
  readonly createdAt:string; readonly updatedAt:string;
}
export interface ConversationMetadata extends ConversationThread { readonly owner:string; readonly expiresAt:string }
export interface ConversationSelection {readonly configured:boolean; readonly id?:string}
export const isConversationId=(value:string):boolean=>value.length>=33&&value.length<=100&&/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
const unavailable=():never=>{throw Object.assign(new Error('Conversation is unavailable.'),{name:'ConversationUnavailableException'});};
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
export const decodeConversationMetadata=(r:Record<string,unknown>):ConversationMetadata=>({id:String(r.id),owner:String(r.owner),title:String(r.title),firstMonth:String(r.first_month),
  createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),expiresAt:iso(r.expires_at)});
export const conversationPresentation=(r:ConversationMetadata):ConversationThread=>({id:r.id,title:r.title,firstMonth:r.firstMonth,createdAt:r.createdAt,updatedAt:r.updatedAt});
export const readConversationMetadata=async(client:SqlClient,owner:string,id:string):Promise<ConversationMetadata|undefined>=>{
  const row=(await client.query('SELECT * FROM olbia.conversation_threads WHERE owner=$1 AND id=$2',[owner,id])).rows[0];return row?decodeConversationMetadata(row):undefined;
};
export const readConversationIndex=async(client:SqlClient,owner:string,at:Date):Promise<ConversationThread[]>=>
  (await client.query(`SELECT * FROM olbia.conversation_threads WHERE owner=$1 AND expires_at>$2::timestamptz
    AND updated_at>=$3::timestamptz ORDER BY updated_at DESC,id COLLATE "C"`,[owner,at.toISOString(),new Date(at.getTime()-CONVERSATION_RETENTION_MS).toISOString()])).rows
    .map(r=>conversationPresentation(decodeConversationMetadata(r)));
export const readConversationSelection=async(client:SqlClient,owner:string):Promise<ConversationSelection>=>{
  const row=(await client.query('SELECT thread_id FROM olbia.assistant_thread_selection WHERE id=1 AND owner=$1',[owner])).rows[0];
  return row?{configured:true,...(row.thread_id==null?{}:{id:String(row.thread_id)})}:{configured:false};
};
/** Caller owns the shared native transaction; identity/title/first month/creation never change on refresh. */
export const upsertConversation=async(client:SqlClient,input:{readonly owner:string;readonly id:string;readonly title:string;readonly month:string;readonly at:string}):Promise<ConversationThread>=>{
  if(!isConversationId(input.id)||!input.owner||!input.title||input.title.length>72||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)||!Number.isFinite(Date.parse(input.at)))unavailable();
  const expiry=new Date(Math.floor((Date.parse(input.at)+CONVERSATION_RETENTION_MS)/1000)*1000).toISOString();
  const row=(await client.query(`INSERT INTO olbia.conversation_threads (id,owner,title,first_month,created_at,updated_at,expires_at)
    VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT (id) DO UPDATE SET updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at
    WHERE olbia.conversation_threads.owner=EXCLUDED.owner RETURNING *`,[input.id,input.owner,input.title,input.month,input.at,expiry])).rows[0];
  return row?conversationPresentation(decodeConversationMetadata(row)):unavailable();
};
export const selectConversation=async(client:SqlClient,owner:string,id:string|undefined,at:string):Promise<void>=>{
  if(!owner||!Number.isFinite(Date.parse(at))||(id!==undefined&&!isConversationId(id)))unavailable();
  const row=(await client.query(id===undefined
    ?`INSERT INTO olbia.assistant_thread_selection (id,owner,thread_id,updated_at) VALUES (1,$1,$2::text,$3)
      ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id,updated_at=EXCLUDED.updated_at
      WHERE olbia.assistant_thread_selection.owner=EXCLUDED.owner RETURNING id`
    :`INSERT INTO olbia.assistant_thread_selection (id,owner,thread_id,updated_at)
      SELECT 1,owner,id,$3 FROM olbia.conversation_threads WHERE owner=$1 AND id=$2
      ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id,updated_at=EXCLUDED.updated_at
      WHERE olbia.assistant_thread_selection.owner=EXCLUDED.owner RETURNING id`,[owner,id??null,at])).rows[0];
  if(!row)unavailable();
};
export const deleteConversationMetadata=async(client:SqlClient,owner:string,id:string,at:string):Promise<void>=>{
  await client.query('UPDATE olbia.assistant_thread_selection SET thread_id=NULL,updated_at=$3 WHERE owner=$1 AND thread_id=$2',[owner,id,at]);
  await client.query('DELETE FROM olbia.conversation_threads WHERE owner=$1 AND id=$2',[owner,id]);
};
/** Only application metadata expires here. Provider events follow native Memory retention. */
export const expireConversationMetadata=async(client:SqlClient,at:Date):Promise<number>=>{
  if (!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=18')).rows.length)
    throw Object.assign(new Error('Olbia está en mantenimiento. Intenta de nuevo más tarde.'),{name:'MigrationPausedException'});
  const expired=(await client.query('SELECT id,owner FROM olbia.conversation_threads WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100',[at.toISOString()])).rows;
  for(const row of expired)await deleteConversationMetadata(client,String(row.owner),String(row.id),at.toISOString());
  return expired.length;
};
