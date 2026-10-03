import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { canonicalJson,projectRows,TABLE_COLUMNS,type SourceItem, type TableName } from './model.js';
import { insertReviewException,type ReviewException,type RetryAttempt } from './exception.js';
import { NATIVE_EXCEPTION_TABLES } from './exception-schema.js';
import type { SqlClient,TransactionPool } from './projection.js';
type Row=Record<string,unknown>;
export interface RetainedExceptionSnapshot { readonly exceptions:readonly Row[];readonly claims:readonly Row[];readonly retries:readonly Row[] }
export type OriginalEmailReader=(source:{readonly bucket:string;readonly key:string})=>Promise<Uint8Array>;
const invalid=():never=>{throw new Error('Retained ingestion review mapping is inconsistent');};
const object=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:invalid();
const text=(v:unknown):string=>typeof v==='string'?v:invalid();
const nonempty=(v:unknown):string=>{const s=text(v);return s.length?s:invalid();};
const iso=(v:unknown):string=>{const d=new Date(text(v));return Number.isFinite(d.getTime())?d.toISOString():invalid();};
const optionalIso=(v:unknown):string|undefined=>v===undefined?undefined:iso(v);
const uuid=(v:unknown):string=>{const s=text(v);return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s)?s:invalid();};
const known=(r:Row,keys:readonly string[])=>{if(Object.keys(r).some(k=>!keys.includes(k)))invalid();};
const expiry=(v:unknown):string|undefined=>{if(v===undefined)return undefined;if(!Number.isSafeInteger(v)||Number(v)<0)invalid();const d=new Date(Number(v)*1000);return Number.isFinite(d.getTime())?d.toISOString():invalid();};
const retained=(row:Row,table:TableName):Row=>{
  const p=object(row.source_item),projected=projectRows({PK:text(p.PK),SK:text(p.SK)},p as SourceItem);
  const normalize=(r:Row)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v==null?v:
    (TABLE_COLUMNS[table] as Record<string,string>)[k]==='timestamptz'?new Date(v as string|Date).toISOString():
    (TABLE_COLUMNS[table] as Record<string,string>)[k]==='bigint'?String(v):v]));
  if(projected.length!==1||projected[0].table!==table||canonicalJson(normalize(projected[0].values))!==canonicalJson(normalize(row)))invalid();
  return p;
};
export const originalEmailSourceToken=async(bytes:Uint8Array):Promise<{sha256:string;sourceToken:string}>=>{
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const parsed=await simpleParser(Buffer.from(bytes).toString('utf8'),{skipHtmlToText:false,skipTextToHtml:true,keepCidLinks:true});
  const messageId=parsed.messageId?.trim().replace(/^<|>$/g,'').toLowerCase()||undefined;
  return {sha256,sourceToken:createHash('sha256').update(`${messageId??'no-message-id'}:${sha256}`).digest('hex')};
};
export const prepareExceptionCopy=async(snapshot:RetainedExceptionSnapshot,readOriginal:OriginalEmailReader)=>{
  if(snapshot.exceptions.length+snapshot.claims.length+snapshot.retries.length+10>2900||Buffer.byteLength(JSON.stringify(snapshot))>8*1024*1024)invalid();
  const headers:ReviewException[]=[],nested=new Map<string,Row>(),ids=new Set<string>(),sources=new Map<string,{sha256:string;sourceToken:string}>();
  for(const row of snapshot.exceptions){
    const p=retained(row,'ingestion_exceptions');known(p,['PK','SK','GSI1PK','GSI1SK','entityType','payload','expiresAt']);
    const e=object(p.payload);known(e,['id','receivedAt','institution','reason','details','source','discarded','retry']);
    const id=uuid(e.id),receivedAt=iso(e.receivedAt),reason=text(e.reason);
    if(ids.has(id)||p.PK!==`EXCEPTION#${id}`||p.SK!=='EXCEPTION'||p.GSI1PK!=='EXCEPTIONS'||p.GSI1SK!==e.receivedAt||p.entityType!=='ingestion_exception'
      ||!['unsupported_source','parser_failed','missing_required_data'].includes(reason))invalid();
    ids.add(id);const source=object(e.source);known(source,['bucket','key','sha256','contentType']);
    const bucket=nonempty(source.bucket),key=nonempty(source.key),sha256=text(source.sha256);
    if(!/^[a-f0-9]{64}$/.test(sha256)||source.contentType!=='message/rfc822')invalid();
    const sourceId=JSON.stringify([bucket,key]);let evidence=sources.get(sourceId);
    if(!evidence){evidence=await originalEmailSourceToken(await readOriginal({bucket,key}));sources.set(sourceId,evidence);}
    if(evidence.sha256!==sha256)invalid();
    const discarded=e.discarded===undefined?undefined:object(e.discarded);if(discarded)known(discarded,['at','by']);
    headers.push({id,receivedAt,reason:reason as ReviewException['reason'],details:text(e.details),source:{bucket,key,sha256,contentType:'message/rfc822'},
      sourceToken:evidence.sourceToken,...(e.institution===undefined?{}:{institution:nonempty(e.institution)}),
      ...(discarded?{discarded:{at:iso(discarded.at),by:nonempty(discarded.by)}}:{}),...(p.expiresAt===undefined?{}:{expiresAt:expiry(p.expiresAt)})});
    if(e.retry!==undefined)nested.set(id,object(e.retry));
  }
  const claims:{sourceToken:string;extractorVersion:string;reason:string;exceptionId:string;createdAt:string;expiresAt?:string}[]=[],claimKeys=new Set<string>();
  for(const row of snapshot.claims){
    const p=retained(row,'exception_claims');known(p,['PK','SK','entityType','sourceDedupeKey','extractorVersion','createdAt','expiresAt']);
    if(p.SK!=='CLAIM'||p.entityType!=='ingestion_exception_claim')invalid();
    const sourceToken=text(p.sourceDedupeKey),extractorVersion=nonempty(p.extractorVersion);
    if(!/^[a-f0-9]{64}$/.test(sourceToken))invalid();
    const matches=headers.filter(h=>h.sourceToken===sourceToken&&p.PK===`EXCEPTION_DEDUPE#${createHash('sha256').update(`${sourceToken}:${extractorVersion}:${h.reason}`).digest('hex')}`);
    if(matches.length!==1)invalid();const parent=matches[0],claimKey=JSON.stringify([sourceToken,extractorVersion,parent.reason]);if(claimKeys.has(claimKey))invalid();claimKeys.add(claimKey);
    claims.push({sourceToken,extractorVersion,reason:parent.reason,exceptionId:parent.id,createdAt:iso(p.createdAt),...(p.expiresAt===undefined?{}:{expiresAt:expiry(p.expiresAt)})});
  }
  const attempts:(RetryAttempt&{expiresAt?:string})[]=[],attemptKeys=new Set<string>(),requests=new Set<string>();
  for(const row of snapshot.retries){
    const p=retained(row,'ingestion_retries');known(p,['PK','SK','entityType','status','createdAt','dispatchedAt','job','expiresAt']);
    const job=object(p.job);known(job,['receivedAt','source','retryExceptionId','sourceMessageId']);
    const id=uuid(job.retryExceptionId),parent=headers.find(h=>h.id===id)??invalid(),retry=nested.get(id)??invalid();
    if(p.PK!==`RETRY#${id}`||p.entityType!=='ingestion_retry'||!['pending','dispatched'].includes(text(p.status)))invalid();
    known(retry,['status','requestId','requestedAt','requestedBy','completedAt','eventId','failedAt','details']);
    const requestedAt=iso(retry.requestedAt),requestId=retry.requestId===undefined?undefined:uuid(retry.requestId);
    if(iso(p.createdAt)!==requestedAt||p.SK!==(requestId?`DISPATCH#${requestId}`:'DISPATCH')||iso(job.receivedAt)!==parent.receivedAt)invalid();
    const source=object(job.source);known(source,['bucket','key','sha256','contentType']);
    if(source.bucket!==parent.source.bucket||source.key!==parent.source.key||(source.sha256!==undefined&&source.sha256!==parent.source.sha256)
      ||(source.contentType!==undefined&&source.contentType!==parent.source.contentType)||(source.sha256===undefined)!==(source.contentType===undefined))invalid();
    const completedAt=optionalIso(retry.completedAt),failedAt=optionalIso(retry.failedAt),dispatchedAt=optionalIso(p.dispatchedAt);
    const derived=completedAt?'completed':failedAt?'failed':'queued';
    if(retry.status!==derived||(completedAt===undefined)!==(retry.eventId===undefined)||(failedAt===undefined)!==(retry.details===undefined)
      ||(p.status==='dispatched')!==(dispatchedAt!==undefined)||(dispatchedAt&&dispatchedAt<requestedAt)||(completedAt&&completedAt<requestedAt)||(failedAt&&failedAt<requestedAt))invalid();
    const attemptKey=JSON.stringify([id,requestedAt]);if(attemptKeys.has(attemptKey)||requestId&&requests.has(requestId))invalid();attemptKeys.add(attemptKey);if(requestId)requests.add(requestId);
    attempts.push({exceptionId:id,requestedAt,requestedBy:nonempty(retry.requestedBy),...(requestId?{requestId}:{}),...(dispatchedAt?{dispatchedAt}:{}),
      ...(completedAt?{completedAt,eventId:uuid(retry.eventId)}:{}),...(failedAt?{failedAt,details:text(retry.details)}:{}),
      ...(source.sha256===undefined?{}:{jobSourceSha256:text(source.sha256),jobSourceContentType:text(source.contentType)}),
      ...(job.sourceMessageId===undefined?{}:{jobSourceMessageId:text(job.sourceMessageId)}),...(p.expiresAt===undefined?{}:{expiresAt:expiry(p.expiresAt)})});
  }
  if(attempts.length!==nested.size||[...nested.keys()].some(id=>!attempts.some(a=>a.exceptionId===id)))invalid();
  return {headers,claims,attempts};
};
const snapshotFrom=async(client:SqlClient):Promise<RetainedExceptionSnapshot>=>({exceptions:(await client.query('SELECT * FROM olbia.ingestion_exceptions')).rows,
  claims:(await client.query('SELECT * FROM olbia.exception_claims')).rows,retries:(await client.query('SELECT * FROM olbia.ingestion_retries')).rows});
const orderedSnapshot=(s:RetainedExceptionSnapshot)=>canonicalJson(Object.fromEntries(Object.entries(s).map(([k,v])=>[k,(v as Row[]).map(canonicalJson).sort()])));
export const migrateIngestionReview=async(pool:TransactionPool,readOriginal:OriginalEmailReader):Promise<void>=>{
  const baseline=await pool.transaction(async client=>{
    if((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows.length)return undefined;
    return snapshotFrom(client);
  });if(!baseline)return;
  // Consume native source IO once before the connector can retry the activation callback.
  const copy=await prepareExceptionCopy(baseline,readOriginal);
  await pool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows.length)return;
    if((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode!=='sql'
      ||(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=18')).rows.length!==1
      ||orderedSnapshot(await snapshotFrom(client))!==orderedSnapshot(baseline))invalid();
    for(const table of NATIVE_EXCEPTION_TABLES)if((await client.query(`SELECT 1 FROM olbia.${table} LIMIT 1`)).rows.length)invalid();
    for(const header of copy.headers)await insertReviewException(client,header);
    for(const r of copy.claims)await client.query(`INSERT INTO olbia.ingestion_review_claims (source_token,extractor_version,reason,exception_id,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)`,[r.sourceToken,r.extractorVersion,r.reason,r.exceptionId,r.createdAt,r.expiresAt??null]);
    for(const r of copy.attempts)await client.query(`INSERT INTO olbia.ingestion_retry_attempts (exception_id,requested_at,requested_by,request_id,job_source_sha256,
      job_source_content_type,job_source_message_id,dispatched_at,completed_at,failed_at,failure_details,movement_id,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[r.exceptionId,r.requestedAt,r.requestedBy,r.requestId??null,r.jobSourceSha256??null,r.jobSourceContentType??null,
      r.jobSourceMessageId??null,r.dispatchedAt??null,r.completedAt??null,r.failedAt??null,r.details??null,r.eventId??null,r.expiresAt??null]);
    await client.query('INSERT INTO olbia.schema_migrations VALUES (19,CURRENT_TIMESTAMP)');
  });
};
