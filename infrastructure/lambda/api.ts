import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { InvalidMonthlyPlanError, isValidMonth, monthlyPlanKey, parseMonthlyPlan, type MonthlyPlanInput } from './monthly-plan.js';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) throw new Error('Missing required environment variable: METADATA_TABLE_NAME');

type JsonObject = Record<string, unknown>;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const month = event.pathParameters?.month;
    if (month !== undefined) {
      if (!isValidMonth(month)) return response(400, { message: 'Month must use YYYY-MM format.' });
      const owner = principal(event);
      if (event.requestContext.http.method === 'GET') {
        return response(200, await getMonthlyPlan(owner, month));
      }
      if (event.requestContext.http.method === 'PUT') {
        const input = parseMonthlyPlan(requestBody(event));
        return response(200, await saveMonthlyPlan(owner, month, input));
      }
      return response(405, { message: 'Method not allowed.' });
    }
    const eventId = event.pathParameters?.eventId;
    const exceptionId = event.pathParameters?.exceptionId;
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/events') {
      return response(200, { events: await listEvents() });
    }
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/exceptions') {
      return response(200, { exceptions: await listExceptions() });
    }
    if (exceptionId && event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/retry')) {
      return response(202, await requestRetry(exceptionId, principal(event)));
    }
    if (exceptionId && event.requestContext.http.method === 'GET' && event.rawPath.endsWith('/raw')) {
      return response(200, { rawEmail: await readExceptionRawEmail(exceptionId) });
    }
    if (exceptionId && event.requestContext.http.method === 'DELETE') {
      return response(200, await discardException(exceptionId, principal(event)));
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
    if (error instanceof InvalidMonthlyPlanError) {
      return response(400, { message: error.message });
    }
    console.error('API request failed', { message: errorMessage(error) });
    return response(500, { message: 'Unable to complete this request.' });
  }
};

const getMonthlyPlan = async (owner: string, month: string): Promise<JsonObject> => {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: monthlyPlanKey(owner, month),
    ConsistentRead: true,
  }));
  const plan = result.Item?.payload as JsonObject | undefined;
  return plan ? toPublicMonthlyPlan(month, plan, true) : toPublicMonthlyPlan(month, {}, false);
};

const saveMonthlyPlan = async (owner: string, month: string, input: MonthlyPlanInput): Promise<JsonObject> => {
  const updatedAt = new Date().toISOString();
  const payload = { ...input, updatedAt };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...monthlyPlanKey(owner, month),
      entityType: 'monthly_plan',
      month,
      owner,
      updatedAt,
      payload,
    },
  }));
  return toPublicMonthlyPlan(month, payload, true);
};

const toPublicMonthlyPlan = (month: string, payload: JsonObject, configured: boolean): JsonObject => ({
  month,
  configured,
  incomeMinor: configured ? payload.incomeMinor : 0,
  currency: 'MXN',
  upcomingPayments: configured && Array.isArray(payload.upcomingPayments) ? payload.upcomingPayments : [],
  ...(configured && typeof payload.updatedAt === 'string' ? { updatedAt: payload.updatedAt } : {}),
});

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

const listExceptions = async (): Promise<readonly JsonObject[]> => {
  const result = await database.send(new QueryCommand({
    TableName: tableName, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :partition',
    ExpressionAttributeValues: { ':partition': 'EXCEPTIONS' }, ScanIndexForward: false, Limit: 100,
  }));
  return (result.Items ?? [])
    .map((item) => item.payload as JsonObject)
    .filter((payload) => !payload.discarded && (payload.retry as JsonObject | undefined)?.status !== 'completed')
    .map(toPublicException);
};

const toPublicException = (payload: JsonObject): JsonObject => ({
  id: payload.id, receivedAt: payload.receivedAt, institution: payload.institution, reason: payload.reason,
  details: payload.details, retry: payload.retry,
});

const requestRetry = async (exceptionId: string, requestedBy: string): Promise<JsonObject> => {
  const existing = await database.send(new GetCommand({ TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' }, ConsistentRead: true }));
  const exception = existing.Item?.payload as JsonObject | undefined;
  const source = exception?.source as JsonObject | undefined;
  if (!exception || !source?.bucket || !source.key) throw new Error('Exception not found.');
  const requestedAt = new Date().toISOString();
  const retry = { status: 'queued', requestedAt, requestedBy };
  await database.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' },
      UpdateExpression: 'SET #payload.#retry = :retry', ConditionExpression: 'attribute_not_exists(#payload.#retry)',
      ExpressionAttributeNames: { '#payload': 'payload', '#retry': 'retry' }, ExpressionAttributeValues: { ':retry': retry },
    } },
    { Put: { TableName: tableName, Item: {
      PK: `RETRY#${exceptionId}`, SK: 'DISPATCH', entityType: 'ingestion_retry', status: 'pending',
      job: { receivedAt: exception.receivedAt, source, retryExceptionId: exceptionId }, createdAt: requestedAt,
    }, ConditionExpression: 'attribute_not_exists(PK)' } },
  ] }));
  return { id: exceptionId, retry };
};

const discardException = async (exceptionId: string, discardedBy: string): Promise<JsonObject> => {
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

const readExceptionRawEmail = async (exceptionId: string): Promise<string> => {
  const record = await database.send(new GetCommand({
    TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' }, ConsistentRead: true,
  }));
  const source = (record.Item?.payload as JsonObject | undefined)?.source as { bucket?: string; key?: string } | undefined;
  if (!source?.bucket || !source.key) throw new Error(`Missing raw source for exception ${exceptionId}`);
  return readSource({ bucket: source.bucket, key: source.key }, `exception ${exceptionId}`);
};

const getEventDetail = async (eventId: string): Promise<JsonObject | undefined> => {
  const record = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
  }));
  if (!record.Item?.payload) return undefined;
  const related = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :partition',
    ExpressionAttributeValues: { ':partition': `EVENT#${eventId}` },
    ScanIndexForward: false,
  }));
  const revisions = (related.Items ?? [])
    .filter((item) => typeof item.SK === 'string' && item.SK.startsWith('REVISION#'))
    .map((item) => item.payload as JsonObject);
  const observations = (related.Items ?? [])
    .filter((item) => typeof item.SK === 'string' && item.SK.startsWith('OBSERVATION#'))
    .map((item) => item.payload as JsonObject);
  return toPublicEvent(record.Item.payload as JsonObject, revisions, observations);
};

const readRawEmail = async (eventId: string): Promise<string> => {
  const detail = await getEventDetail(eventId);
  const directSource = detail?.source as { bucket?: string; key?: string } | undefined;
  const linkedSource = Array.isArray(detail?.observations)
    ? detail.observations
      .map((observation) => (observation as JsonObject).source as { bucket?: string; key?: string } | undefined)
      .find((source) => source?.bucket && source.key)
    : undefined;
  const source = directSource?.bucket && directSource.key ? directSource : linkedSource;
  if (!source?.bucket || !source.key) throw new Error(`Missing raw source for event ${eventId}`);
  return readSource({ bucket: source.bucket, key: source.key }, `event ${eventId}`);
};

const readSource = async (source: { bucket: string; key: string }, label: string): Promise<string> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
  if (!object.Body) throw new Error(`Raw source for ${label} did not contain a body`);
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

const toPublicEvent = (
  payload: JsonObject,
  revisions: readonly JsonObject[] = [],
  observations: readonly JsonObject[] = [],
): JsonObject => {
  const account = payload.account as JsonObject | undefined;
  return {
    id: payload.id,
    institution: payload.institution,
    eventType: payload.eventType ?? 'card_purchase',
    status: payload.status,
    accountName: account?.displayName ?? 'Tarjeta sin identificar',
    amount: payload.amount,
    merchantRaw: payload.merchantRaw,
    billingPeriod: payload.billingPeriod,
    paymentMethodLastFour: payload.paymentMethodLastFour,
    occurredAt: payload.occurredAt,
    receivedAt: payload.receivedAt,
    ingestedAt: payload.ingestedAt,
    parserVersion: payload.parserVersion,
    source: payload.source,
    captureSource: payload.captureSource,
    captureSources: payload.captureSources ?? [],
    observationCount: payload.observationCount ?? Math.max(1, observations.length),
    reconciledAt: payload.reconciledAt,
    hasRawEmail: payload.hasRawEmail ?? (payload.source as JsonObject | undefined)?.contentType === 'message/rfc822',
    parseWarnings: payload.parseWarnings ?? [],
    revisions,
    observations,
  };
};

const principal = (event: Parameters<APIGatewayProxyHandlerV2>[0]): string => {
  const context = event.requestContext as typeof event.requestContext & { authorizer?: { jwt?: { claims?: { sub?: string } } } };
  const subject = context.authorizer?.jwt?.claims?.sub;
  if (!subject) throw new Error('Missing authenticated principal.');
  return subject;
};
const requestBody = (event: Parameters<APIGatewayProxyHandlerV2>[0]): string | undefined => {
  if (!event.body) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
};
const response = (statusCode: number, body: JsonObject) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
