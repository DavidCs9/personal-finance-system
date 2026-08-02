import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { InvalidMonthlyPlanError, isValidMonth, monthlyPlanKey, parseMonthlyPlan, type MonthlyPlanInput } from './monthly-plan.js';
import { reconciliationPartition } from './observed-events.js';
import { InvalidSantanderCsvError, merchantsMatch, parseSantanderCsv, santanderApplyAction, type SantanderCsvDocument, type SantanderCsvRow, type SantanderReconciliationDecision, type SantanderReconciliationStatus } from './santander-csv.js';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) throw new Error('Missing required environment variable: METADATA_TABLE_NAME');
const rawSourceBucketName = process.env.RAW_EMAIL_BUCKET_NAME;
if (!rawSourceBucketName) throw new Error('Missing required environment variable: RAW_EMAIL_BUCKET_NAME');

type JsonObject = Record<string, unknown>;

interface SantanderPreviewRow extends SantanderCsvRow {
  readonly status: SantanderReconciliationStatus;
  readonly candidateEventIds: readonly string[];
  readonly candidates: readonly { readonly id: string; readonly merchantRaw: string; readonly occurredAt?: string }[];
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/santander/preview') {
      return response(200, await previewSantanderImport(requestBody(event), principal(event)));
    }
    const importId = event.pathParameters?.importId;
    if (importId && event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/apply')) {
      return response(200, await applySantanderImport(importId, principal(event), requestBody(event)));
    }
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
    if (error instanceof InvalidMonthlyPlanError || error instanceof InvalidSantanderCsvError) {
      return response(400, { message: error.message });
    }
    console.error('API request failed', { message: errorMessage(error) });
    return response(500, { message: 'Unable to complete this request.' });
  }
};

const csvSourceKey = (owner: string, sha256: string): string => `manual-imports/santander/${owner}/${sha256}.csv`;
const rowClaimKey = (identity: string): { readonly PK: string; readonly SK: string } => ({
  PK: `DEDUPE#SANTANDER_CSV#${createHash('sha256').update(identity).digest('hex')}`,
  SK: 'CLAIM',
});

const localDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Chihuahua',
  }).formatToParts(date);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const allStoredEvents = async (): Promise<readonly JsonObject[]> => {
  const events: JsonObject[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': 'EVENTS' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) {
      if (item.payload) events.push(item.payload as JsonObject);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return events;
};

const claimedRowIdentities = async (rows: readonly SantanderCsvRow[]): Promise<ReadonlySet<string>> => {
  const claimed = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += 100) {
    let requestKeys: Record<string, unknown>[] = rows.slice(offset, offset + 100).map((row) => rowClaimKey(row.identity));
    let attempts = 0;
    do {
      if (attempts > 0) await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempts)));
      const result = await database.send(new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: requestKeys, ProjectionExpression: 'PK' } },
      }));
      for (const item of result.Responses?.[tableName] ?? []) claimed.add(String(item.PK));
      requestKeys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
      attempts += 1;
      if (attempts >= 6 && requestKeys.length > 0) throw new Error('Unable to verify Santander CSV dedupe keys after multiple attempts.');
    } while (requestKeys.length > 0);
  }
  return claimed;
};

const candidateEvents = (document: SantanderCsvDocument, row: SantanderCsvRow, events: readonly JsonObject[]): readonly JsonObject[] =>
  events.filter((event) => {
    const account = event.account as JsonObject | undefined;
    const amount = event.amount as JsonObject | undefined;
    return account?.lastFour === document.accountLastFour
      && amount?.currency === 'MXN'
      && amount.amountMinor === row.amountMinor
      && localDate(event.occurredAt ?? event.receivedAt) === row.occurredOn
      && typeof event.merchantRaw === 'string'
      && merchantsMatch(event.merchantRaw, row.merchantRaw);
  });

const classifySantanderRows = async (document: SantanderCsvDocument): Promise<readonly SantanderPreviewRow[]> => {
  const [events, claims] = await Promise.all([allStoredEvents(), claimedRowIdentities(document.rows)]);
  return document.rows.map((row): SantanderPreviewRow => {
    if (claims.has(rowClaimKey(row.identity).PK)) return { ...row, status: 'duplicate', candidateEventIds: [], candidates: [] };
    if (row.amountMinor < 0) return { ...row, status: 'excluded', candidateEventIds: [], candidates: [] };
    const candidates = candidateEvents(document, row, events);
    const candidateSummaries = candidates.map((candidate) => ({
      id: String(candidate.id),
      merchantRaw: String(candidate.merchantRaw),
      ...(typeof candidate.occurredAt === 'string' ? { occurredAt: candidate.occurredAt } : {}),
    }));
    if (!row.transactionId) return { ...row, status: 'ambiguous', candidateEventIds: candidates.map((candidate) => String(candidate.id)), candidates: candidateSummaries };
    if (candidates.length === 1) return { ...row, status: 'matched', candidateEventIds: [String(candidates[0].id)], candidates: candidateSummaries };
    if (candidates.length > 1) return { ...row, status: 'ambiguous', candidateEventIds: candidates.map((candidate) => String(candidate.id)), candidates: candidateSummaries };
    return { ...row, status: 'new', candidateEventIds: [], candidates: [] };
  });
};

const previewPayload = (importId: string, document: SantanderCsvDocument, rows: readonly SantanderPreviewRow[]): JsonObject => {
  const count = (status: SantanderReconciliationStatus) => rows.filter((row) => row.status === status).length;
  return {
    importId,
    accountLastFour: document.accountLastFour,
    product: document.product,
    period: document.period,
    summary: {
      total: rows.length,
      new: count('new'),
      matched: count('matched'),
      ambiguous: count('ambiguous'),
      duplicate: count('duplicate'),
      excluded: count('excluded'),
    },
    rows,
  };
};

const previewSantanderImport = async (body: string | undefined, owner: string): Promise<JsonObject> => {
  if (!body) throw new InvalidSantanderCsvError('Selecciona un archivo CSV de Santander.');
  if (Buffer.byteLength(body, 'utf8') > 2_000_000) throw new InvalidSantanderCsvError('El CSV excede el límite de 2 MB.');
  const document = parseSantanderCsv(body);
  const sourceHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const importId = sourceHash;
  const source = {
    bucket: rawSourceBucketName,
    key: csvSourceKey(owner, sourceHash),
    sha256: sourceHash,
    contentType: 'text/csv',
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: source.key,
    Body: body,
    ContentType: 'text/csv; charset=utf-8',
  }));
  const rows = await classifySantanderRows(document);
  const previewedAt = new Date().toISOString();
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${owner}`,
      SK: `IMPORT#SANTANDER#${importId}`,
      entityType: 'santander_csv_import',
      owner,
      importId,
      status: 'previewed',
      previewedAt,
      source,
      accountLastFour: document.accountLastFour,
      rows,
    },
  }));
  return previewPayload(importId, document, rows);
};

const claimAndCreateCsvEvent = async (
  owner: string,
  document: SantanderCsvDocument,
  row: SantanderPreviewRow,
  source: JsonObject,
  appliedAt: string,
): Promise<JsonObject | undefined> => {
  const id = randomUUID();
  const observationId = randomUUID();
  const occurredAt = `${row.occurredOn}T12:00:00.000Z`;
  const purchase: JsonObject = {
    id,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    status: 'accepted',
    account: {
      institution: 'santander_mx',
      accountId: `santander_mx:${document.accountLastFour}`,
      displayName: `Tarjeta terminada en ${document.accountLastFour}`,
      lastFour: document.accountLastFour,
    },
    amount: { amountMinor: row.amountMinor, currency: 'MXN' },
    merchantRaw: row.merchantRaw,
    bankTransactionId: row.transactionId,
    occurredAt,
    receivedAt: appliedAt,
    ingestedAt: appliedAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: [],
    captureSource: 'santander_csv',
    captureSources: ['santander_csv'],
    observationCount: 1,
    primaryObservationId: observationId,
    hasRawEmail: false,
  };
  const observation = {
    id: observationId,
    eventId: id,
    captureSource: 'santander_csv',
    observedAt: appliedAt,
    reconciliationAt: occurredAt,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    account: purchase.account,
    amount: purchase.amount,
    merchantRaw: row.merchantRaw,
    occurredAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: [],
    rowNumber: row.rowNumber,
    bankTransactionId: row.transactionId,
  };
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: { ...rowClaimKey(row.identity), entityType: 'santander_csv_dedupe', identity: row.identity, owner, createdAt: appliedAt },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: 'EVENT',
          GSI1PK: 'EVENTS',
          GSI1SK: appliedAt,
          GSI2PK: reconciliationPartition(purchase as Parameters<typeof reconciliationPartition>[0]),
          GSI2SK: `${occurredAt}#${id}`,
          reconciliationAt: occurredAt,
          entityType: 'observed_purchase',
          payload: purchase,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: `OBSERVATION#${occurredAt}#${observationId}`,
          entityType: 'event_observation',
          payload: observation,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
    ] }));
    return purchase;
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') return undefined;
    throw error;
  }
};

const claimAndLinkCsvEvidence = async (
  owner: string,
  eventId: string,
  row: SantanderPreviewRow,
  source: JsonObject,
  appliedAt: string,
): Promise<boolean> => {
  const revisionId = randomUUID();
  const observationId = randomUUID();
  const reconciliationAt = `${row.occurredOn}T12:00:00.000Z`;
  const reconciliation = { source, rowNumber: row.rowNumber, transactionId: row.transactionId, reconciledAt: appliedAt };
  const observation = {
    id: observationId,
    eventId,
    captureSource: 'santander_csv',
    observedAt: appliedAt,
    reconciliationAt,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    amount: { amountMinor: row.amountMinor, currency: 'MXN' },
    merchantRaw: row.merchantRaw,
    occurredAt: reconciliationAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: [],
    rowNumber: row.rowNumber,
    bankTransactionId: row.transactionId,
  };
  const revision = {
    id: revisionId,
    observedPurchaseId: eventId,
    createdAt: appliedAt,
    changedBy: owner,
    reason: 'Conciliado con un CSV de movimientos Santander.',
    changes: { reconciliation: { previous: null, next: reconciliation } },
  };
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: { ...rowClaimKey(row.identity), entityType: 'santander_csv_dedupe', identity: row.identity, owner, createdAt: appliedAt, eventId },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Update: {
        TableName: tableName,
        Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
        UpdateExpression: 'SET #payload.#count = if_not_exists(#payload.#count, :one) + :one, #payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source), #payload.#reconciledAt = :reconciledAt, #payload.#bankTransactionId = :transactionId',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#payload': 'payload', '#count': 'observationCount', '#sources': 'captureSources', '#reconciledAt': 'reconciledAt', '#bankTransactionId': 'bankTransactionId' },
        ExpressionAttributeValues: { ':one': 1, ':empty': [], ':source': ['santander_csv'], ':reconciledAt': appliedAt, ':transactionId': row.transactionId ?? row.identity },
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${eventId}`,
          SK: `OBSERVATION#${reconciliationAt}#${observationId}`,
          entityType: 'event_observation',
          payload: observation,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
      { Put: {
        TableName: tableName,
        Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${appliedAt}#${revisionId}`, entityType: 'event_revision', payload: revision },
      } },
    ] }));
    return true;
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') return false;
    throw error;
  }
};

const parseImportDecisions = (body: string | undefined): Readonly<Record<string, SantanderReconciliationDecision>> => {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { decisions?: unknown };
    if (!parsed.decisions || typeof parsed.decisions !== 'object' || Array.isArray(parsed.decisions)) return {};
    const decisions: Record<string, SantanderReconciliationDecision> = {};
    for (const [identity, raw] of Object.entries(parsed.decisions as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') throw new InvalidSantanderCsvError('Una decisión de conciliación no es válida.');
      const decision = raw as { action?: unknown; eventId?: unknown };
      if (decision.action !== 'create' && decision.action !== 'link') throw new InvalidSantanderCsvError('Una decisión de conciliación no es válida.');
      if (decision.action === 'link' && typeof decision.eventId !== 'string') throw new InvalidSantanderCsvError('Falta el movimiento elegido para una conciliación.');
      decisions[identity] = decision.action === 'create' ? { action: 'create' } : { action: 'link', eventId: String(decision.eventId) };
    }
    return decisions;
  } catch (error) {
    if (error instanceof InvalidSantanderCsvError) throw error;
    throw new InvalidSantanderCsvError('Las decisiones de conciliación no tienen un formato válido.');
  }
};

const applySantanderImport = async (importId: string, owner: string, decisionBody: string | undefined): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) throw new InvalidSantanderCsvError('Identificador de importación inválido.');
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER#${importId}` },
    ConsistentRead: true,
  }));
  const source = stored.Item?.source as JsonObject | undefined;
  if (!stored.Item || stored.Item.owner !== owner || typeof source?.key !== 'string') {
    throw new InvalidSantanderCsvError('La previsualización ya no está disponible. Vuelve a seleccionar el CSV.');
  }
  const object = await s3.send(new GetObjectCommand({ Bucket: rawSourceBucketName, Key: source.key }));
  if (!object.Body) throw new Error('The Santander CSV source did not contain a body.');
  const sourceBody = await object.Body.transformToString('utf8');
  const actualHash = createHash('sha256').update(sourceBody, 'utf8').digest('hex');
  if (actualHash !== importId) throw new Error('The stored Santander CSV hash does not match the import identifier.');

  const decisions = parseImportDecisions(decisionBody);
  const document = parseSantanderCsv(sourceBody);
  const rows = await classifySantanderRows(document);
  const previewRows = Array.isArray(stored.Item.rows) ? stored.Item.rows as readonly SantanderPreviewRow[] : [];
  const previewByIdentity = new Map(previewRows.map((row) => [row.identity, row]));
  const appliedAt = new Date().toISOString();
  const created: JsonObject[] = [];
  let linked = 0;
  let skipped = 0;
  for (const row of rows) {
    const previewRow = previewByIdentity.get(row.identity);
    const action = santanderApplyAction(row, previewRow, decisions[row.identity]);
    if (action.kind === 'create') {
      const purchase = await claimAndCreateCsvEvent(owner, document, row, source, appliedAt);
      if (purchase) created.push(toPublicEvent(purchase)); else skipped += 1;
    } else if (action.kind === 'link') {
      if (await claimAndLinkCsvEvidence(owner, action.eventId, row, source, appliedAt)) linked += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER#${importId}` },
    UpdateExpression: 'SET #status = :status, appliedAt = :appliedAt, result = :result',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'applied', ':appliedAt': appliedAt, ':result': { created: created.length, linked, skipped } },
  }));
  return { importId, created, summary: { created: created.length, linked, skipped } };
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
const errorName = (error: unknown): string | undefined => error && typeof error === 'object' && 'name' in error ? String(error.name) : undefined;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
