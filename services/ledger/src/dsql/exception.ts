import { applicationSqlClient } from './sql-runtime.js';
import type { SqlClient } from './projection.js';

export interface ReviewSource { readonly bucket:string; readonly key:string; readonly sha256:string; readonly contentType:'message/rfc822' }
export interface ReviewException {
  readonly id:string; readonly receivedAt:string; readonly institution?:string;
  readonly reason:'unsupported_source'|'parser_failed'|'missing_required_data'; readonly details:string;
  readonly source:ReviewSource; readonly sourceToken:string;
  readonly discarded?:{readonly at:string;readonly by:string}; readonly expiresAt?:string;
}
export interface RetryReference { readonly exceptionId:string; readonly requestedAt:string }
export interface RetryAttempt extends RetryReference {
  readonly requestedBy:string; readonly requestId?:string; readonly dispatchedAt?:string;
  readonly completedAt?:string; readonly eventId?:string; readonly failedAt?:string; readonly details?:string;
  readonly jobSourceSha256?:string; readonly jobSourceContentType?:string; readonly jobSourceMessageId?:string;
}
type Row=Record<string,unknown>;
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
const conditional=():never=>{throw Object.assign(new Error('Exception retry precondition failed.'),{name:'ConditionalCheckFailedException'});};
export const requireNativeExceptions=async(client:SqlClient):Promise<void>=>{
  if(!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=19')).rows.length)
    throw Object.assign(new Error('Olbia está en mantenimiento. Intenta de nuevo más tarde.'),{name:'MigrationPausedException'});
};
export const assertNativeExceptionAccess=async(client:SqlClient=applicationSqlClient()):Promise<void>=>{
  try {await requireNativeExceptions(client);}
  catch(error){if((error as {code?:string}).code)throw Object.assign(new Error('Olbia storage is unavailable.'),{name:'StorageUnavailableException'});throw error;}
};
export const decodeReviewException=(r:Row):ReviewException=>({id:String(r.id),receivedAt:iso(r.received_at),
  ...(r.institution==null?{}:{institution:String(r.institution)}),reason:r.reason as ReviewException['reason'],details:String(r.details),
  source:{bucket:String(r.source_bucket),key:String(r.source_key),sha256:String(r.source_sha256),contentType:'message/rfc822'},sourceToken:String(r.source_token),
  ...(r.discarded_at==null?{}:{discarded:{at:iso(r.discarded_at),by:String(r.discarded_by)}}),...(r.expires_at==null?{}:{expiresAt:iso(r.expires_at)})});
export const decodeRetryAttempt=(r:Row):RetryAttempt=>({exceptionId:String(r.exception_id),requestedAt:iso(r.requested_at),requestedBy:String(r.requested_by),
  ...(r.request_id==null?{}:{requestId:String(r.request_id)}),...(r.dispatched_at==null?{}:{dispatchedAt:iso(r.dispatched_at)}),
  ...(r.completed_at==null?{}:{completedAt:iso(r.completed_at),eventId:String(r.movement_id)}),
  ...(r.failed_at==null?{}:{failedAt:iso(r.failed_at),details:String(r.failure_details)}),
  ...(r.job_source_sha256==null?{}:{jobSourceSha256:String(r.job_source_sha256),jobSourceContentType:String(r.job_source_content_type)}),
  ...(r.job_source_message_id==null?{}:{jobSourceMessageId:String(r.job_source_message_id)})});
export const publicRetry=(r:RetryAttempt)=>({status:r.completedAt?'completed':r.failedAt?'failed':'queued',
  ...(r.requestId?{requestId:r.requestId}:{}),requestedAt:r.requestedAt,requestedBy:r.requestedBy,
  ...(r.completedAt?{completedAt:r.completedAt,eventId:r.eventId}:{}),...(r.failedAt?{failedAt:r.failedAt,details:r.details}:{})});
export const readReviewException=async(client:SqlClient,id:string,at?:Date):Promise<ReviewException|undefined>=>{
  const r=(await client.query(`SELECT * FROM olbia.ingestion_review_exceptions WHERE id=$1${at?' AND (expires_at IS NULL OR expires_at>$2)':''}`,[id,...(at?[at.toISOString()]:[])])).rows[0];
  return r?decodeReviewException(r):undefined;
};
export const readLatestRetry=async(client:SqlClient,id:string):Promise<RetryAttempt|undefined>=>{
  const r=(await client.query('SELECT * FROM olbia.ingestion_retry_attempts WHERE exception_id=$1 ORDER BY requested_at DESC LIMIT 1',[id])).rows[0];
  return r?decodeRetryAttempt(r):undefined;
};
/** Limit precedes discard/completion/expiry filtering, preserving the existing review contract. */
export const listReviewExceptions=async(client:SqlClient,at:Date):Promise<Record<string,unknown>[]>=>{
  const rows=(await client.query(`WITH first_page AS (SELECT * FROM olbia.ingestion_review_exceptions ORDER BY received_at DESC,id DESC LIMIT 100),
    latest AS (SELECT exception_id,max(requested_at) AS requested_at FROM olbia.ingestion_retry_attempts GROUP BY exception_id)
    SELECT e.*,r.exception_id,r.requested_at,r.requested_by,r.request_id,r.completed_at,r.failed_at,r.failure_details,r.movement_id
    FROM first_page e LEFT JOIN latest l ON l.exception_id=e.id
    LEFT JOIN olbia.ingestion_retry_attempts r ON r.exception_id=l.exception_id AND r.requested_at=l.requested_at
    WHERE e.discarded_at IS NULL AND r.completed_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>$1)
    ORDER BY e.received_at DESC,e.id DESC`,[at.toISOString()])).rows;
  return rows.map(r=>({id:String(r.id),receivedAt:iso(r.received_at),...(r.institution==null?{}:{institution:String(r.institution)}),reason:r.reason,details:r.details,
    ...(r.requested_at==null||r.failed_at!=null?{}:{retry:publicRetry(decodeRetryAttempt(r))})}));
};
export const insertReviewException=async(client:SqlClient,r:ReviewException):Promise<void>=>{
  await client.query(`INSERT INTO olbia.ingestion_review_exceptions (id,received_at,institution,reason,details,source_bucket,source_key,source_sha256,
    source_content_type,source_token,discarded_at,discarded_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [r.id,r.receivedAt,r.institution??null,r.reason,r.details,r.source.bucket,r.source.key,r.source.sha256,r.source.contentType,r.sourceToken,r.discarded?.at??null,r.discarded?.by??null,r.expiresAt??null]);
};
/** Claim collision is an explicit duplicate, not a generic swallowed database failure. Caller owns the transaction. */
export const saveClaimedReviewException=async(client:SqlClient,r:ReviewException,extractorVersion:string,createdAt:string):Promise<boolean>=>{
  if((await client.query('SELECT exception_id FROM olbia.ingestion_review_claims WHERE source_token=$1 AND extractor_version=$2 AND reason=$3',[r.sourceToken,extractorVersion,r.reason])).rows.length)return false;
  await insertReviewException(client,r);
  await client.query('INSERT INTO olbia.ingestion_review_claims (source_token,extractor_version,reason,exception_id,created_at) VALUES ($1,$2,$3,$4,$5)',[r.sourceToken,extractorVersion,r.reason,r.id,createdAt]);
  return true;
};
export const discardReviewException=async(client:SqlClient,id:string,at:string,by:string):Promise<void>=>{
  const result=await client.query(`UPDATE olbia.ingestion_review_exceptions SET discarded_at=COALESCE(discarded_at,$2::timestamptz),discarded_by=COALESCE(discarded_by,$3) WHERE id=$1 RETURNING id`,[id,at,by]);
  if(!result.rows.length)conditional();
};
export const requestReviewRetry=async(client:SqlClient,id:string,at:string,by:string,requestId:string):Promise<RetryAttempt>=>{
  const parent=await readReviewException(client,id);if(!parent)throw new Error('Exception not found.');
  const prior=await readLatestRetry(client,id);if(prior&&(prior.completedAt||!prior.failedAt))conditional();
  await client.query(`INSERT INTO olbia.ingestion_retry_attempts (exception_id,requested_at,requested_by,request_id,job_source_sha256,job_source_content_type)
    VALUES ($1,$2,$3,$4,$5,$6)`,[id,at,by,requestId,parent.source.sha256,parent.source.contentType]);
  return {exceptionId:id,requestedAt:at,requestedBy:by,requestId,jobSourceSha256:parent.source.sha256,jobSourceContentType:parent.source.contentType};
};

export interface RetryJob {
  readonly receivedAt:string; readonly source:{readonly bucket:string;readonly key:string;readonly sha256?:string;readonly contentType?:string};
  readonly sourceMessageId?:string; readonly retryExceptionId?:string; readonly retryRequestedAt?:string;
}
/** Old identityless deliveries may reference only a sole matching attempt, never a guessed latest request. */
export const resolveRetryAttempt=async(client:SqlClient,job:RetryJob):Promise<RetryAttempt|undefined>=>{
  if(!job.retryExceptionId){if(job.retryRequestedAt)conditional();return undefined;}
  const parent=await readReviewException(client,job.retryExceptionId);
  if(!parent||parent.source.bucket!==job.source.bucket||parent.source.key!==job.source.key||parent.receivedAt!==iso(job.receivedAt)
    ||(job.source.sha256!==undefined&&job.source.sha256!==parent.source.sha256)
    ||(job.source.contentType!==undefined&&job.source.contentType!==parent.source.contentType))conditional();
  const rows=(await client.query(`SELECT * FROM olbia.ingestion_retry_attempts WHERE exception_id=$1${job.retryRequestedAt?' AND requested_at=$2':''} LIMIT 2`,
    [job.retryExceptionId,...(job.retryRequestedAt?[job.retryRequestedAt]:[])])).rows;
  if(rows.length!==1)conditional();
  return decodeRetryAttempt(rows[0]);
};
/** A completed outcome is immutable. Repeated delivery cannot replace its movement or change it to failed. */
export const completeRetryAttempt=async(client:SqlClient,ref:RetryReference,movementId:string,at:string):Promise<void>=>{
  const result=await client.query(`UPDATE olbia.ingestion_retry_attempts SET completed_at=$3,movement_id=$4
    WHERE exception_id=$1 AND requested_at=$2 AND completed_at IS NULL RETURNING exception_id`,[ref.exceptionId,ref.requestedAt,at,movementId]);
  if(result.rows.length)return;
  const rows=(await client.query('SELECT * FROM olbia.ingestion_retry_attempts WHERE exception_id=$1 AND requested_at=$2',[ref.exceptionId,ref.requestedAt])).rows;
  if(!rows[0]||rows[0].movement_id!==movementId)conditional();
};
export const failRetryAttempt=async(client:SqlClient,ref:RetryReference,details:string,at:string):Promise<void>=>{
  const result=await client.query(`UPDATE olbia.ingestion_retry_attempts SET failed_at=$3,failure_details=$4
    WHERE exception_id=$1 AND requested_at=$2 AND completed_at IS NULL RETURNING exception_id`,[ref.exceptionId,ref.requestedAt,at,details]);
  if(result.rows.length)return;
  if(!(await client.query('SELECT exception_id FROM olbia.ingestion_retry_attempts WHERE exception_id=$1 AND requested_at=$2',[ref.exceptionId,ref.requestedAt])).rows.length)conditional();
};
export const pendingReviewRetries=async(client:SqlClient,limit=25):Promise<{readonly ref:RetryReference;readonly job:RetryJob}[]>=>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new Error('Invalid retry dispatch limit');
  return (await client.query(`SELECT r.*,e.received_at,e.source_bucket,e.source_key FROM olbia.ingestion_retry_attempts r
    JOIN olbia.ingestion_review_exceptions e ON e.id=r.exception_id
    WHERE r.dispatched_at IS NULL AND r.completed_at IS NULL AND r.failed_at IS NULL
    ORDER BY r.exception_id,r.requested_at LIMIT $1`,[limit])).rows.map(r=>({ref:{exceptionId:String(r.exception_id),requestedAt:iso(r.requested_at)},
    job:{receivedAt:iso(r.received_at),retryExceptionId:String(r.exception_id),retryRequestedAt:iso(r.requested_at),
      source:{bucket:String(r.source_bucket),key:String(r.source_key),...(r.job_source_sha256==null?{}:{sha256:String(r.job_source_sha256),contentType:String(r.job_source_content_type)})},
      ...(r.job_source_message_id==null?{}:{sourceMessageId:String(r.job_source_message_id)})}}));
};
export const markReviewRetryDispatched=async(client:SqlClient,ref:RetryReference,at:string):Promise<void>=>{
  await client.query(`UPDATE olbia.ingestion_retry_attempts SET dispatched_at=$3
    WHERE exception_id=$1 AND requested_at=$2 AND dispatched_at IS NULL`,[ref.exceptionId,ref.requestedAt,at]);
};
export const expireReviewClaims=async(client:SqlClient,at:Date):Promise<void>=>{
  await client.query(`DELETE FROM olbia.ingestion_review_claims WHERE (source_token,extractor_version,reason) IN
    (SELECT source_token,extractor_version,reason FROM olbia.ingestion_review_claims WHERE expires_at<=$1 LIMIT 100)`,[at.toISOString()]);
};
