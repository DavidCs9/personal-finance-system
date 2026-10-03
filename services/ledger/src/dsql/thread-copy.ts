import { canonicalJson, projectRows, TABLE_COLUMNS, type SourceItem } from './model.js';
import type { SqlClient, TransactionPool } from './projection.js';
import { isConversationId, type ConversationMetadata } from './thread.js';
type Row=Record<string,unknown>;
const invalid=():never=>{throw new Error('Retained conversation metadata mapping is inconsistent');};
const text=(v:unknown):string=>typeof v==='string'?v:invalid();
const iso=(v:unknown):string=>{const d=new Date(text(v));return Number.isFinite(d.getTime())?d.toISOString():invalid();};
const known=(p:Row,keys:readonly string[])=>{if(Object.keys(p).some(k=>!keys.includes(k)))invalid();};
export const prepareThreadCopy=(rows:readonly Row[])=>{
  const headers:ConversationMetadata[]=[],active:{owner:string;id?:string;updatedAt:string}[]=[],owners=new Set<string>(),ids=new Set<string>();
  for(const row of rows){
    const p=row.source_item as Row;if(!p||typeof p!=='object'||Array.isArray(p))invalid();
    const owner=text(p.owner);if(!owner||p.PK!==`USER#${owner}`)invalid();owners.add(owner);
    if(p.SK==='ASSISTANT_THREAD#ACTIVE'){
      known(p,['PK','SK','entityType','owner','sessionId','updatedAt']);
      if(p.entityType!=='assistant_active_thread'||(p.sessionId!==null&&(typeof p.sessionId!=='string'||!isConversationId(p.sessionId))))invalid();
      active.push({owner,...(p.sessionId===null?{}:{id:text(p.sessionId)}),updatedAt:iso(p.updatedAt)});
    }else{
      known(p,['PK','SK','entityType','owner','sessionId','title','firstMonth','createdAt','updatedAt','expiresAt']);
      const id=text(p.sessionId),title=text(p.title),month=text(p.firstMonth);
      if(p.entityType!=='assistant_thread'||!isConversationId(id)||p.SK!==`ASSISTANT_THREAD#${id}`||ids.has(id)||!title||title.length>72
        ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!Number.isSafeInteger(p.expiresAt)||Number(p.expiresAt)<=0)invalid();
      const expiry=new Date(Number(p.expiresAt)*1000);if(!Number.isFinite(expiry.getTime()))invalid();
      ids.add(id);headers.push({id,owner,title,firstMonth:month,createdAt:iso(p.createdAt),updatedAt:iso(p.updatedAt),expiresAt:expiry.toISOString()});
    }
    const projected=projectRows({PK:text(p.PK),SK:text(p.SK)},p as SourceItem);
    const normalize=(r:Row)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v==null?v:
      (TABLE_COLUMNS.assistant_threads as Record<string,string>)[k]==='timestamptz'?new Date(v as string|Date).toISOString():
      (TABLE_COLUMNS.assistant_threads as Record<string,string>)[k]==='bigint'?String(v):v]));
    if(projected.length!==1||projected[0].table!=='assistant_threads'||canonicalJson(normalize(projected[0].values))!==canonicalJson(normalize(row)))invalid();
  }
  if(owners.size>1||active.length>1||active.some(r=>r.id!==undefined&&!ids.has(r.id))||headers.length+active.length+2>3000
    ||Buffer.byteLength(JSON.stringify({headers,active}))>8*1024*1024)invalid();
  return {headers,selection:active[0]};
};
export const migrateConversationMetadata=async(pool:TransactionPool):Promise<void>=>{
  await pool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=18')).rows.length)return;
    if((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode!=='sql'
      ||(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=17')).rows.length!==1)invalid();
    for(const table of ['conversation_threads','assistant_thread_selection'])if((await client.query(`SELECT 1 FROM olbia.${table} LIMIT 1`)).rows.length)invalid();
    const copy=prepareThreadCopy((await client.query('SELECT * FROM olbia.assistant_threads')).rows);
    for(const r of copy.headers)await client.query(`INSERT INTO olbia.conversation_threads (id,owner,title,first_month,created_at,updated_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[r.id,r.owner,r.title,r.firstMonth,r.createdAt,r.updatedAt,r.expiresAt]);
    if(copy.selection){const r=copy.selection;await client.query('INSERT INTO olbia.assistant_thread_selection (id,owner,thread_id,updated_at) VALUES (1,$1,$2,$3)',[r.owner,r.id??null,r.updatedAt]);}
    await client.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP)');
  });
};
