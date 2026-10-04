import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { withSqlClient } from '@finance/ledger/sql-runtime';
import { samePublicResult } from '../events/read-selection.js';
import { readerPool,withLedgerVerificationSnapshot,type ReadSqlClient } from '../events/sql-reads.js';
import { s3,rawSourceBucketName } from '../http/clients.js';
import { normalizeEmail } from '../../../ingestion/src/email.js';
import { listExceptions,readStoredException } from './service.js';
type Row=Record<string,unknown>;
type Reader=(source:{bucket:string;key:string})=>Promise<Uint8Array>;
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
const readOriginal:Reader=async source=>{
  if(source.bucket!==rawSourceBucketName||!source.key.startsWith('inbound/'))throw new Error('Review original is outside verification scope');
  const object=await s3.send(new GetObjectCommand({Bucket:source.bucket,Key:source.key}));if(!object.Body)throw new Error('Review original has no body');return object.Body.transformToByteArray();
};
const verifySnapshot=async(now:Date,client:ReadSqlClient,read:Reader)=>{
  const started=Date.now();let mismatches=0,productReads=0,originalChecks=0;
  const check=(a:unknown,b:unknown)=>{mismatches+=Number(!samePublicResult(a,b));};
  const activated=(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows.length===1;mismatches+=Number(!activated);
  const headers=(await client.query('SELECT * FROM olbia.ingestion_review_exceptions')).rows,claims=(await client.query('SELECT * FROM olbia.ingestion_review_claims')).rows,attempts=(await client.query('SELECT * FROM olbia.ingestion_retry_attempts')).rows;
  const names=['ingestion_review_exceptions_pkey','ingestion_review_exceptions_institution_check','ingestion_review_exceptions_reason_check','ingestion_review_exceptions_source_bucket_check','ingestion_review_exceptions_source_key_check',
    'ingestion_review_exceptions_source_sha256_check','ingestion_review_exceptions_source_content_type_check','ingestion_review_exceptions_source_token_check','ingestion_review_exceptions_discarded_by_check','ingestion_review_discard_pair','ingestion_review_claim_identity',
    'ingestion_review_claims_source_token_check','ingestion_review_claims_extractor_version_check','ingestion_review_claims_pkey','ingestion_review_claim_parent',
    'ingestion_retry_attempts_exception_id_fkey','ingestion_retry_attempts_requested_by_check','ingestion_retry_attempts_request_id_key','ingestion_retry_attempts_job_source_sha256_check','ingestion_retry_attempts_job_source_content_type_check',
    'ingestion_retry_attempts_movement_id_fkey','ingestion_retry_attempts_pkey','ingestion_retry_source_pair','ingestion_retry_dispatch_order','ingestion_retry_outcome'];
  const constraints=(await client.query("SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace AND conname=ANY($1::text[]) ORDER BY conname",[names])).rows;
  check(constraints,names.sort().map(conname=>({conname,convalidated:true})));let requiredColumns=0;
  for(const [table,names] of Object.entries({ingestion_review_exceptions:['id','received_at','reason','details','source_bucket','source_key','source_sha256','source_content_type','source_token'],ingestion_review_claims:['source_token','extractor_version','reason','exception_id','created_at'],ingestion_retry_attempts:['exception_id','requested_at','requested_by']})){
    const actual=(await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attnotnull ORDER BY attname',[`olbia.${table}`])).rows;check(actual,names.sort().map(attname=>({attname})));requiredColumns+=actual.length;
  }
  const parentById=new Map(headers.map(r=>[String(r.id),r])),latest=new Map<string,Row>();
  const orderedAttempts=[...attempts].sort((a,b)=>iso(a.requested_at).localeCompare(iso(b.requested_at)));
  for(const r of orderedAttempts){latest.set(String(r.exception_id),r);mismatches+=Number(!parentById.has(String(r.exception_id))||(r.completed_at==null)!==(r.movement_id==null)||(r.failed_at==null)!==(r.failure_details==null));}
  for(const r of claims){const parent=parentById.get(String(r.exception_id));mismatches+=Number(!parent||parent.source_token!==r.source_token||parent.reason!==r.reason);}
  const originals=new Map<string,{sha256:string;token:string}>();
  for(const r of headers){
    const source={bucket:String(r.source_bucket),key:String(r.source_key)},key=JSON.stringify(source);let proof=originals.get(key);
    if(!proof){const bytes=await read(source),sha256=createHash('sha256').update(bytes).digest('hex'),email=await normalizeEmail(Buffer.from(bytes).toString('utf8'));
      const messageId=email.messageId?.trim().replace(/^<|>$/g,'').toLowerCase()||'no-message-id';proof={sha256,token:createHash('sha256').update(`${messageId}:${sha256}`).digest('hex')};originals.set(key,proof);}
    check([r.source_sha256,r.source_token,r.source_content_type],[proof.sha256,proof.token,'message/rfc822']);originalChecks++;
  }
  const presentation=(r:Row)=>({id:r.id,receivedAt:iso(r.received_at),...(r.institution==null?{}:{institution:r.institution}),reason:r.reason,details:r.details});
  const clocks=new Set([now.getTime(),...headers.flatMap(r=>r.expires_at==null?[]:[Date.parse(iso(r.expires_at))-1,Date.parse(iso(r.expires_at)),Date.parse(iso(r.expires_at))+1])]);
  const firstPage=[...headers].sort((a,b)=>iso(b.received_at).localeCompare(iso(a.received_at))||String(b.id).localeCompare(String(a.id))).slice(0,100);
  for(const clock of clocks){const expected=firstPage.filter(r=>r.discarded_at==null&&(r.expires_at==null||Date.parse(iso(r.expires_at))>clock)&&latest.get(String(r.id))?.completed_at==null).map(r=>{
    const a=latest.get(String(r.id));return {...presentation(r),...(a&&a.failed_at==null?{retry:{status:'queued',requestedAt:iso(a.requested_at),requestedBy:a.requested_by,...(a.request_id==null?{}:{requestId:a.request_id})}}:{})};
  });check(expected,await listExceptions(new Date(clock)));productReads++;
    for(const r of headers){const live=r.expires_at==null||Date.parse(iso(r.expires_at))>clock;const actual=await readStoredException(String(r.id),new Date(clock));
      check(live?{...presentation(r),source:{bucket:r.source_bucket,key:r.source_key,sha256:r.source_sha256,contentType:r.source_content_type},sourceToken:r.source_token,
        ...(r.discarded_at==null?{}:{discarded:{at:iso(r.discarded_at),by:r.discarded_by}}),...(r.expires_at==null?{}:{expiresAt:iso(r.expires_at)})}:undefined,actual);productReads++;}
  }
  check(undefined,await readStoredException('00000000-0000-4000-8000-000000000000',now));productReads++;
  return {mode:'native-sql',activated,headers:headers.length,claims:claims.length,attempts:attempts.length,productReads,originalChecks,originalObjects:originals.size,validatedConstraints:constraints.filter(r=>r.convalidated===true).length,requiredColumns,mismatches,elapsedMs:Date.now()-started};
};
export const verifyNativeExceptions=(now:Date,client?:ReadSqlClient,read:Reader=readOriginal)=>client
  ?withSqlClient(client,()=>verifySnapshot(now,client,read))
  :withLedgerVerificationSnapshot(()=>withSqlClient(readerPool(),()=>verifySnapshot(now,readerPool(),read)));
