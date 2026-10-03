import { expireConversationMetadata } from '@finance/ledger/native-threads';
import { assertNativeExceptionAccess,pendingReviewRetries,markReviewRetryDispatched,expireReviewClaims } from '@finance/ledger/native-exceptions';
import { assertSqlMutationsAvailable,applicationSqlClient,withSqlTransaction } from '@finance/ledger/sql-runtime';
import { SendMessageCommand,SQSClient } from '@aws-sdk/client-sqs';
import type { DynamoDBStreamEvent } from 'aws-lambda';
const sqs=new SQSClient({});
const queueUrl=process.env.INGESTION_QUEUE_URL!;

// Existing native SQS delivery is at least once; financial source claims deduplicate observations.
// Provider acceptance and dispatch recording remain separate; a failed send leaves the attempt pending.
export const handler=async(event:Partial<DynamoDBStreamEvent>):Promise<void>=>{
  await assertNativeExceptionAccess();await assertSqlMutationsAvailable();
  if(event.Records)return;
  const at=new Date();
  await withSqlTransaction(async client=>{await assertNativeExceptionAccess(client);await expireConversationMetadata(client,at);await expireReviewClaims(client,at);});
  let pending;
  try{pending=await pendingReviewRetries(applicationSqlClient());}
  catch(error){if((error as {code?:string}).code)throw Object.assign(new Error('Olbia storage is unavailable.'),{name:'StorageUnavailableException'});throw error;}
  for(const attempt of pending){
    await assertNativeExceptionAccess();
    await assertSqlMutationsAvailable();
    await sqs.send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify(attempt.job)}));
    const dispatchedAt=new Date().toISOString();
    await withSqlTransaction(async client=>{await assertNativeExceptionAccess(client);await markReviewRetryDispatched(client,attempt.ref,dispatchedAt);});
  }
};
