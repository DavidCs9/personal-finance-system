import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) throw new Error('Missing required environment variable: METADATA_TABLE_NAME');

type JsonObject = Record<string, unknown>;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const eventId = event.pathParameters?.eventId;
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/events') {
      return response(200, { events: await listEvents() });
    }
    if (!eventId) return response(404, { message: 'Route not found.' });
    if (event.requestContext.http.method === 'GET' && event.rawPath.endsWith('/raw')) {
      return response(200, { rawEmail: await readRawEmail(eventId) });
    }
    if (event.requestContext.http.method === 'GET') {
      const detail = await getEventDetail(eventId);
      return detail ? response(200, detail) : response(404, { message: 'Event not found.' });
    }
    if (event.requestContext.http.method === 'PATCH') {
      const updated = await markVerified(eventId, principal(event));
      return updated ? response(200, updated) : response(404, { message: 'Event not found.' });
    }
    return response(405, { message: 'Method not allowed.' });
  } catch (error) {
    console.error('API request failed', { message: errorMessage(error) });
    return response(500, { message: 'Unable to complete this request.' });
  }
};

const listEvents = async (): Promise<readonly JsonObject[]> => {
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :partition',
    ExpressionAttributeValues: { ':partition': 'EVENTS' },
    ScanIndexForward: false,
    Limit: 100,
  }));
  return (result.Items ?? []).map((item) => toPublicEvent(item.payload as JsonObject));
};

const getEventDetail = async (eventId: string): Promise<JsonObject | undefined> => {
  const record = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
  }));
  if (!record.Item?.payload) return undefined;
  const revisions = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :partition AND begins_with(SK, :revision)',
    ExpressionAttributeValues: { ':partition': `EVENT#${eventId}`, ':revision': 'REVISION#' },
    ScanIndexForward: false,
  }));
  return toPublicEvent(record.Item.payload as JsonObject, (revisions.Items ?? []).map((item) => item.payload as JsonObject));
};

const readRawEmail = async (eventId: string): Promise<string> => {
  const detail = await getEventDetail(eventId);
  const source = detail?.source as { bucket?: string; key?: string } | undefined;
  if (!source?.bucket || !source.key) throw new Error(`Missing raw source for event ${eventId}`);
  const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
  if (!object.Body) throw new Error(`Raw source for event ${eventId} did not contain a body`);
  return object.Body.transformToString();
};

const markVerified = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const previousWarnings = Array.isArray(existing.parseWarnings) ? existing.parseWarnings : [];
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: 'SET #payload.#status = :status, #payload.#warnings = :warnings',
    ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status', '#warnings': 'parseWarnings' },
    ExpressionAttributeValues: { ':status': 'accepted', ':warnings': [] },
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: 'Marcado como verificado desde la UI.',
    changes: {
      status: { previous: existing.status, next: 'accepted' },
      parseWarnings: { previous: previousWarnings, next: [] },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${revision.createdAt}#${revision.id}`, entityType: 'event_revision', payload: revision },
  }));
  return toPublicEvent(updated.Attributes?.payload as JsonObject, [revision]);
};

const toPublicEvent = (payload: JsonObject, revisions: readonly JsonObject[] = []): JsonObject => {
  const account = payload.account as JsonObject | undefined;
  return {
    id: payload.id,
    institution: payload.institution,
    status: payload.status,
    accountName: account?.displayName ?? 'Tarjeta sin identificar',
    amount: payload.amount,
    merchantRaw: payload.merchantRaw,
    occurredAt: payload.occurredAt,
    receivedAt: payload.receivedAt,
    ingestedAt: payload.ingestedAt,
    parserVersion: payload.parserVersion,
    source: payload.source,
    parseWarnings: payload.parseWarnings ?? [],
    revisions,
  };
};

const principal = (event: Parameters<APIGatewayProxyHandlerV2>[0]): string => {
  const context = event.requestContext as typeof event.requestContext & { authorizer?: { jwt?: { claims?: { sub?: string } } } };
  return String(context.authorizer?.jwt?.claims?.sub ?? 'authenticated-user');
};
const response = (statusCode: number, body: JsonObject) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
