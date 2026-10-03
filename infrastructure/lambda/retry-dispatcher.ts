import { expireConversationMetadata } from '@finance/ledger/native-threads';
import { createApplicationStore, storageAuthority, mutationsPaused, applicationStoreClient, withNativeTransaction } from '@finance/ledger/dsql-store';
import { UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { DynamoDBStreamEvent } from 'aws-lambda';

const database = createApplicationStore();
const sqs = new SQSClient({});
const tableName = process.env.METADATA_TABLE_NAME!;
const queueUrl = process.env.INGESTION_QUEUE_URL!;

// SQS delivery is at least once; the existing observed-event claims deduplicate retries.
// A failed send leaves the durable pending record for the next native scheduled run.
export const handler = async (event: Partial<DynamoDBStreamEvent>): Promise<void> => {
  if (await mutationsPaused()) return;
  const records: Record<string, any>[] = [];
  if (event.Records) {
    if (await storageAuthority() === 'sql') return; // stale DynamoDB deliveries cannot dispatch after activation
    for (const record of event.Records) {
      if (record.eventName === 'INSERT' && record.dynamodb?.NewImage?.entityType?.S === 'ingestion_retry') records.push(unmarshall(record.dynamodb.NewImage as any));
    }
  } else {
    if (await storageAuthority() !== 'sql') return;
    const client=applicationStoreClient();
    // Read promoted operational columns, rather than repeatedly transferring the whole ledger.
    // Match top-level DynamoDB TTL only; nested preview deadlines remain audit data.
    const at=new Date();
    await withNativeTransaction(client=>expireConversationMetadata(client,at));
    const now=Math.floor(at.getTime()/1000);
    const expired=(await client.query(`SELECT source_pk,source_sk FROM olbia.bulk_edit_operations WHERE expires_at<=$1
      UNION ALL SELECT source_pk,source_sk FROM olbia.dedupe_claims WHERE expires_at<=$1
      UNION ALL SELECT source_pk,source_sk FROM olbia.exception_claims WHERE expires_at<=$1 LIMIT 100`,[now])).rows;
    for(const item of expired) {
      try {await database.send(new DeleteCommand({TableName:tableName,Key:{PK:item.source_pk,SK:item.source_sk},ConditionExpression:'expiresAt <= :now',ExpressionAttributeValues:{':now':now}}));}
      catch(error) {if((error as Error).name!=='ConditionalCheckFailedException') throw error;}
    }
    records.push(...(await client.query("SELECT source_item FROM olbia.ingestion_retries WHERE status='pending' ORDER BY source_pk,source_sk LIMIT 25")).rows.map(row=>row.source_item as Record<string,any>));
  }
  for (const record of records) {
    if (!record.job || record.status !== 'pending') continue;
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(record.job) }));
    try {
      await database.send(new UpdateCommand({ TableName: tableName, Key: { PK: record.PK, SK: record.SK },
        UpdateExpression: 'SET #status = :status, dispatchedAt = :at', ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':pending': 'pending', ':status': 'dispatched', ':at': new Date().toISOString() } }));
    } catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; }
  }
};
