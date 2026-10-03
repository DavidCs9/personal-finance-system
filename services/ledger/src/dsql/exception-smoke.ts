import { randomUUID } from 'node:crypto';
import type { SqlClient } from './projection.js';
import { requireNativeExceptions,saveClaimedReviewException,readReviewException,requestReviewRetry,readLatestRetry,resolveRetryAttempt,failRetryAttempt,completeRetryAttempt,markReviewRetryDispatched,discardReviewException,type ReviewException } from './exception.js';
/** Caller rolls back every row. Never reads/writes provider sources, sends jobs/alerts or creates movements. */
export const smokeNativeExceptions=async(client:SqlClient,owner:string):Promise<void>=>{
  await requireNativeExceptions(client);const id=randomUUID(),at=new Date().toISOString();
  const source={bucket:'sql-rollback-verification',key:`${id}.eml`,sha256:'0'.repeat(64),contentType:'message/rfc822' as const};
  const input:ReviewException={id,receivedAt:at,reason:'parser_failed',details:'SQL rollback verification',source,sourceToken:id.replaceAll('-','').repeat(2)};
  if(!await saveClaimedReviewException(client,input,'sql-rollback-verification',at)||await saveClaimedReviewException(client,{...input,id:randomUUID()},'sql-rollback-verification',at))throw new Error('Native review claim failed');
  if((await readReviewException(client,id))?.source.sha256!==source.sha256)throw new Error('Native review source failed');
  const first=await requestReviewRetry(client,id,at,owner,randomUUID());await markReviewRetryDispatched(client,first,at);
  if(!(await resolveRetryAttempt(client,{receivedAt:at,source,retryExceptionId:id,retryRequestedAt:at})))throw new Error('Native retry reference failed');
  await failRetryAttempt(client,first,'SQL rollback verification',at);
  const nextAt=new Date(Date.parse(at)+1).toISOString();await requestReviewRetry(client,id,nextAt,owner,randomUUID());
  if((await readLatestRetry(client,id))?.requestedAt!==nextAt)throw new Error('Native retry selection failed');
  const movement=(await client.query('SELECT id FROM olbia.ledger_movements ORDER BY id LIMIT 1')).rows[0];
  if(movement){await completeRetryAttempt(client,first,String(movement.id),nextAt);if((await readLatestRetry(client,id))?.requestedAt!==nextAt)throw new Error('Older retry replaced current request');}
  await discardReviewException(client,id,at,owner);if((await readReviewException(client,id))?.discarded?.by!==owner)throw new Error('Native discard failed');
};
