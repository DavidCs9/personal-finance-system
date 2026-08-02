import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { DynamoDBStreamHandler } from 'aws-lambda';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const tableName = process.env.METADATA_TABLE_NAME!;
const queueUrl = process.env.INGESTION_QUEUE_URL!;

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || record.dynamodb?.NewImage?.entityType?.S !== 'ingestion_retry') continue;
    const exceptionId = record.dynamodb.NewImage.PK?.S?.replace(/^RETRY#/, '');
    const job = record.dynamodb.NewImage.job?.M;
    if (!exceptionId || !job) continue;
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({
      receivedAt: job.receivedAt?.S, retryExceptionId: job.retryExceptionId?.S,
      source: { bucket: job.source?.M?.bucket?.S, key: job.source?.M?.key?.S },
    }) }));
    await database.send(new UpdateCommand({ TableName: tableName, Key: { PK: `RETRY#${exceptionId}`, SK: 'DISPATCH' }, UpdateExpression: 'SET #status = :status, dispatchedAt = :at', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': 'dispatched', ':at': new Date().toISOString() } }));
  }
};
