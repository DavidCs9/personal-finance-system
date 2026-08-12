import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { readSource } from '../events/queries.js';
import { randomUUID } from 'node:crypto';

export const listExceptions = async (): Promise<readonly JsonObject[]> => {
  const result = await database.send(new QueryCommand({
    TableName: tableName, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :partition',
    ExpressionAttributeValues: { ':partition': 'EXCEPTIONS' }, ScanIndexForward: false, Limit: 100,
  }));
  return (result.Items ?? [])
    .map((item) => item.payload as JsonObject)
    .filter((payload) => !payload.discarded && (payload.retry as JsonObject | undefined)?.status !== 'completed')
    .map(toPublicException);
};

const toPublicException = (payload: JsonObject): JsonObject => {
  const retry = payload.retry as JsonObject | undefined;
  return {
    id: payload.id, receivedAt: payload.receivedAt, institution: payload.institution, reason: payload.reason,
    details: payload.details,
    ...(retry?.status === 'queued' || retry?.status === 'completed' ? { retry } : {}),
  };
};

export const requestRetry = async (exceptionId: string, requestedBy: string): Promise<JsonObject> => {
  const existing = await database.send(new GetCommand({ TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' }, ConsistentRead: true }));
  const exception = existing.Item?.payload as JsonObject | undefined;
  const source = exception?.source as JsonObject | undefined;
  if (!exception || !source?.bucket || !source.key) throw new Error('Exception not found.');
  const requestedAt = new Date().toISOString();
  const requestId = randomUUID();
  const retry = { status: 'queued', requestId, requestedAt, requestedBy };
  await database.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' },
      UpdateExpression: 'SET #payload.#retry = :retry',
      ConditionExpression: 'attribute_not_exists(#payload.#retry) OR #payload.#retry.#status = :failed',
      ExpressionAttributeNames: { '#payload': 'payload', '#retry': 'retry', '#status': 'status' },
      ExpressionAttributeValues: { ':retry': retry, ':failed': 'failed' },
    } },
    { Put: { TableName: tableName, Item: {
      PK: `RETRY#${exceptionId}`, SK: `DISPATCH#${requestId}`, entityType: 'ingestion_retry', status: 'pending',
      job: { receivedAt: exception.receivedAt, source, retryExceptionId: exceptionId }, createdAt: requestedAt,
    }, ConditionExpression: 'attribute_not_exists(PK)' } },
  ] }));
  return { id: exceptionId, retry };
};

export const discardException = async (exceptionId: string, discardedBy: string): Promise<JsonObject> => {
  const discarded = { at: new Date().toISOString(), by: discardedBy };
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' },
    UpdateExpression: 'SET #payload.#discarded = if_not_exists(#payload.#discarded, :discarded)',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#payload': 'payload', '#discarded': 'discarded' },
    ExpressionAttributeValues: { ':discarded': discarded },
  }));
  return { id: exceptionId, discarded };
};

export const readExceptionRawEmail = async (exceptionId: string): Promise<string> => {
  const record = await database.send(new GetCommand({
    TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' }, ConsistentRead: true,
  }));
  const source = (record.Item?.payload as JsonObject | undefined)?.source as { bucket?: string; key?: string } | undefined;
  if (!source?.bucket || !source.key) throw new Error(`Missing raw source for exception ${exceptionId}`);
  return readSource({ bucket: source.bucket, key: source.key }, `exception ${exceptionId}`);
};
