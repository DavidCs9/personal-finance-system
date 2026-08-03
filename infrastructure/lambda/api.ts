import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { TextractClient } from '@aws-sdk/client-textract';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  InvalidManualEntryError,
  manualEntryFingerprint,
  manualEntrySourceKey,
  parseManualEntry,
  type ManualEntryInput,
} from './manual-entry-input.js';
import {
  cancelRemainingInstallments,
  completeUnplannedSchedule,
  maybeAutoAmexMsi,
  monthKeyInZone,
  replaceMsiSchedule,
  type MsiPlan,
} from '@finance/domain';
import {
  amexMsiEvidenceLines,
  InvalidAmexStatementError,
  parseAmexStatementExtraction,
  type AmexStatementDocument,
} from './amex-statement.js';
import {
  deleteCard,
  InvalidCardError,
  isValidCardId,
  listCards,
  parseCardInput,
  saveCard,
  toPublicCard,
} from './cards.js';
import { InvalidMonthlyPlanError, isValidMonth, monthlyPlanKey, parseMonthlyPlan, type MonthlyPlanInput } from './monthly-plan.js';
import { buildPlanFromCreateDecision, isSantanderMsiRow, matchEvidenceLine, type EvidenceLine } from './msi-reconciliation.js';
import { reconciliationPartition } from './observed-events.js';
import { eventMonthIndexKeys, eventMonthPartition, priorCalendarMonths } from './event-month-index.js';
import { buildMonthEventFeed, type MonthFeedEvent } from './event-month-feed.js';
import {
  deletePushSubscription,
  InvalidPushSubscriptionError,
  listOwnerPushSubscriptions,
  parsePushSubscriptionInput,
  savePushSubscription,
} from './push-subscriptions.js';
import { InvalidSantanderCsvError, merchantsMatch, parseSantanderCsv, santanderApplyAction, santanderImportCompletionUpdate, type SantanderCsvDocument, type SantanderCsvRow, type SantanderReconciliationDecision, type SantanderReconciliationStatus } from './santander-csv.js';
import {
  InvalidSantanderStatementError,
  parseSantanderStatementExtraction,
  type SantanderStatementDocument,
} from './santander-statement.js';
import {
  classifyPurchaseCharge,
  statementClaimKey,
  statementImportCompletionUpdate,
  statementMsiApplyAction,
  statementPreviewSummary,
  statementPurchaseApplyAction,
  type StatementDecision,
  type StatementPreviewRow,
  type StatementProvider,
} from './statement-reconciliation.js';
import {
  fetchTextractStatementExtraction,
  getTextractAnalysisJobStatus,
  startTextractDocumentAnalysis,
  TextractDocumentError,
  type TextractStatementExtraction,
} from './textract-document.js';

class InvalidMsiError extends Error {}

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const textract = new TextractClient({});
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
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/cards') {
      const cards = await listCards({
        database,
        tableName,
        owner: principal(event),
      });
      return response(200, { cards: cards.map(toPublicCard) });
    }
    const cardId = event.pathParameters?.cardId;
    if (cardId && event.rawPath.startsWith('/cards/')) {
      const owner = principal(event);
      if (!isValidCardId(cardId)) return response(400, { message: 'cardId is invalid.' });
      if (event.requestContext.http.method === 'PUT') {
        const input = parseCardInput(requestBody(event));
        const saved = await saveCard({
          database,
          tableName,
          owner,
          cardId,
          body: input,
        });
        return response(200, toPublicCard(saved));
      }
      if (event.requestContext.http.method === 'DELETE') {
        await deleteCard({
          database,
          tableName,
          owner,
          cardId,
        });
        return response(200, { deleted: true });
      }
      return response(405, { message: 'Method not allowed.' });
    }
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/push/subscriptions') {
      const subscriptions = await listOwnerPushSubscriptions({
        database,
        tableName,
        owner: principal(event),
      });
      return response(200, {
        subscriptions: subscriptions.map((subscription) => ({
          subscriptionId: subscription.subscriptionId,
          contentMode: subscription.contentMode,
          createdAt: subscription.createdAt,
          updatedAt: subscription.updatedAt,
        })),
      });
    }
    const pushSubscriptionId = event.pathParameters?.subscriptionId;
    if (pushSubscriptionId && event.rawPath.startsWith('/push/subscriptions/')) {
      const owner = principal(event);
      if (event.requestContext.http.method === 'PUT') {
        const input = parsePushSubscriptionInput(requestBody(event), pushSubscriptionId);
        const saved = await savePushSubscription({
          database,
          tableName,
          owner,
          endpoint: input.endpoint,
          keys: input.keys,
          contentMode: input.contentMode,
        });
        return response(200, {
          subscriptionId: saved.subscriptionId,
          contentMode: saved.contentMode,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        });
      }
      if (event.requestContext.http.method === 'DELETE') {
        await deletePushSubscription({
          database,
          tableName,
          owner,
          subscriptionId: pushSubscriptionId.toLowerCase(),
        });
        return response(200, { deleted: true });
      }
      return response(405, { message: 'Method not allowed.' });
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/events/manual') {
      return response(201, await createManualEvent(requestBody(event), principal(event)));
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/santander/preview') {
      return response(200, await previewSantanderImport(requestBody(event), principal(event)));
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/santander-statement/preview') {
      return response(200, await previewSantanderStatementImport(event, principal(event)));
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/amex/preview') {
      return response(200, await previewAmexImport(event, principal(event)));
    }
    const importId = event.pathParameters?.importId;
    if (importId && event.rawPath.includes('/imports/santander-statement/')) {
      if (event.requestContext.http.method === 'GET') {
        return response(200, await getSantanderStatementImport(importId, principal(event)));
      }
      if (event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/apply')) {
        return response(200, await applySantanderStatementImport(importId, principal(event), requestBody(event)));
      }
    }
    if (importId && event.rawPath.includes('/imports/amex/')) {
      if (event.requestContext.http.method === 'GET') {
        return response(200, await getAmexImport(importId, principal(event)));
      }
      if (event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/apply')) {
        return response(200, await applyAmexImport(importId, principal(event), requestBody(event)));
      }
    }
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
      const month = event.queryStringParameters?.month;
      if (!month || !isValidMonth(month)) {
        return response(400, { message: 'Query parameter month (YYYY-MM) is required.' });
      }
      return response(200, await listEventsForMonth(month));
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
      const updated = await patchEvent(eventId, principal(event), requestBody(event));
      return updated ? response(200, updated) : response(404, { message: 'Event not found.' });
    }
    return response(405, { message: 'Method not allowed.' });
  } catch (error) {
    if (
      error instanceof InvalidMonthlyPlanError
      || error instanceof InvalidSantanderCsvError
      || error instanceof InvalidSantanderStatementError
      || error instanceof InvalidAmexStatementError
      || error instanceof TextractDocumentError
      || error instanceof InvalidPushSubscriptionError
      || error instanceof InvalidManualEntryError
      || error instanceof InvalidMsiError
      || error instanceof InvalidCardError
    ) {
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
const manualClaimKey = (fingerprint: string): { readonly PK: string; readonly SK: string } => ({
  PK: `DEDUPE#MANUAL#${fingerprint}`,
  SK: 'CLAIM',
});

const institutionDisplayName = (institution: ManualEntryInput['institution'], lastFour?: string): string => {
  const base = institution === 'american_express_mx'
    ? 'American Express'
    : institution === 'santander_mx'
      ? 'Santander'
      : institution === 'nu_mx'
        ? 'Nu'
        : 'AWS';
  return lastFour ? `${base} terminada en ${lastFour}` : `${base} (registro manual)`;
};

const createManualEvent = async (body: string | undefined, owner: string): Promise<JsonObject> => {
  const input = parseManualEntry(body);
  const appliedAt = new Date().toISOString();
  const fingerprint = manualEntryFingerprint(owner, input);
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: manualClaimKey(fingerprint),
    ConsistentRead: true,
  }));
  if (existing.Item?.eventId) {
    const detail = await getEventDetail(String(existing.Item.eventId));
    if (detail) return detail;
  }
  const evidenceBody = JSON.stringify({
    kind: 'manual_entry',
    createdAt: appliedAt,
    owner,
    institution: input.institution,
    merchantRaw: input.merchantRaw,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredOn: input.occurredOn,
    occurredAt: input.occurredAt,
    accountLastFour: input.accountLastFour,
    note: input.note,
    fingerprint,
  });
  const sourceHash = createHash('sha256').update(evidenceBody, 'utf8').digest('hex');
  const source = {
    kind: 'manual_entry' as const,
    bucket: rawSourceBucketName,
    key: manualEntrySourceKey(owner, sourceHash),
    sha256: sourceHash,
    contentType: 'application/json' as const,
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: source.key,
    Body: evidenceBody,
    ContentType: 'application/json; charset=utf-8',
  }));
  const id = randomUUID();
  const observationId = randomUUID();
  const account = {
    institution: input.institution,
    accountId: input.accountLastFour
      ? `${input.institution}:manual:${input.accountLastFour}`
      : `${input.institution}:manual`,
    displayName: institutionDisplayName(input.institution, input.accountLastFour),
    ...(input.accountLastFour ? { lastFour: input.accountLastFour } : {}),
  };
  const autoMsi = maybeAutoAmexMsi({
    institution: input.institution,
    amountMinor: input.amountMinor,
    occurredAt: input.occurredAt,
    receivedAt: appliedAt,
  });
  const purchase: JsonObject = {
    id,
    institution: input.institution,
    eventType: 'card_purchase',
    status: 'accepted',
    account,
    amount: { amountMinor: input.amountMinor, currency: input.currency },
    merchantRaw: input.merchantRaw,
    occurredAt: input.occurredAt,
    receivedAt: appliedAt,
    ingestedAt: appliedAt,
    source,
    parserVersion: 'manual-entry-v1',
    parseWarnings: [],
    captureSource: 'manual',
    captureSources: ['manual'],
    observationCount: 1,
    primaryObservationId: observationId,
    hasRawEmail: false,
    ...(autoMsi ? { msi: autoMsi } : {}),
  };
  const observation = {
    id: observationId,
    eventId: id,
    captureSource: 'manual',
    observedAt: appliedAt,
    reconciliationAt: input.occurredAt,
    institution: input.institution,
    eventType: 'card_purchase',
    account,
    amount: purchase.amount,
    merchantRaw: input.merchantRaw,
    occurredAt: input.occurredAt,
    source,
    parserVersion: 'manual-entry-v1',
    parseWarnings: [],
    note: input.note,
  };
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: {
          ...manualClaimKey(fingerprint),
          entityType: 'manual_entry_dedupe',
          fingerprint,
          owner,
          eventId: id,
          observationId,
          createdAt: appliedAt,
        },
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
          GSI2SK: `${input.occurredAt}#${id}`,
          ...eventMonthIndexKeys({ eventId: id, occurredAt: input.occurredAt, receivedAt: appliedAt }),
          reconciliationAt: input.occurredAt,
          entityType: 'observed_purchase',
          payload: purchase,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: `OBSERVATION#${input.occurredAt}#${observationId}`,
          entityType: 'event_observation',
          payload: observation,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
    ] }));
  } catch (error) {
    if (errorName(error) !== 'TransactionCanceledException') throw error;
    const claim = await database.send(new GetCommand({
      TableName: tableName,
      Key: manualClaimKey(fingerprint),
      ConsistentRead: true,
    }));
    if (claim.Item?.eventId) {
      const detail = await getEventDetail(String(claim.Item.eventId));
      if (detail) return detail;
    }
    throw error;
  }
  return toPublicEvent(purchase, [], [observation]);
};

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
    if (isSantanderMsiRow(row.merchantRaw) && row.amountMinor > 0) {
      const match = matchEvidenceLine({
        merchantRaw: row.merchantRaw,
        amountMinor: row.amountMinor,
        occurredOn: row.occurredOn,
        identity: row.identity,
      }, events);
      if (match.kind === 'confirm') {
        return {
          ...row,
          status: 'matched',
          candidateEventIds: [match.eventId],
          candidates: [{ id: match.eventId, merchantRaw: row.merchantRaw }],
        };
      }
      if (match.kind === 'needs_decision') {
        const candidates = match.candidates.map((candidate) => ({
          id: candidate.eventId,
          merchantRaw: candidate.merchantRaw,
        }));
        return {
          ...row,
          status: 'needs_decision',
          candidateEventIds: candidates.map((candidate) => candidate.id),
          candidates,
        };
      }
      if (match.kind === 'skip' && match.reason === 'already_confirmed') {
        return { ...row, status: 'duplicate', candidateEventIds: [], candidates: [] };
      }
    }
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
      needsDecision: count('needs_decision'),
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
  msi?: MsiPlan,
): Promise<JsonObject | undefined> => {
  const id = randomUUID();
  const observationId = randomUUID();
  const occurredAt = `${row.occurredOn}T12:00:00.000Z`;
  const purchase: JsonObject = {
    id,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    status: msi?.needsScheduleCompletion ? 'needs_review' : 'accepted',
    account: {
      institution: 'santander_mx',
      accountId: `santander_mx:${document.accountLastFour}`,
      displayName: `Tarjeta terminada en ${document.accountLastFour}`,
      lastFour: document.accountLastFour,
    },
    amount: {
      amountMinor: msi?.principalMinor ?? row.amountMinor,
      currency: 'MXN',
    },
    merchantRaw: row.merchantRaw,
    bankTransactionId: row.transactionId,
    occurredAt,
    receivedAt: appliedAt,
    ingestedAt: appliedAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: msi?.needsScheduleCompletion
      ? ['MSI sin plan completo: confirma meses y cuota.']
      : [],
    captureSource: 'santander_csv',
    captureSources: ['santander_csv'],
    observationCount: 1,
    primaryObservationId: observationId,
    hasRawEmail: false,
    ...(msi ? { msi } : {}),
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
          ...eventMonthIndexKeys({ eventId: id, occurredAt, receivedAt: appliedAt }),
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
      const decision = raw as {
        action?: unknown;
        eventId?: unknown;
        months?: unknown;
        cuotaMinor?: unknown;
        startMonth?: unknown;
      };
      if (decision.action === 'create') {
        decisions[identity] = { action: 'create' };
        continue;
      }
      if (decision.action === 'skip') {
        decisions[identity] = { action: 'skip' };
        continue;
      }
      if (decision.action === 'link' || decision.action === 'confirm_msi') {
        if (typeof decision.eventId !== 'string') {
          throw new InvalidSantanderCsvError('Falta el movimiento elegido para una conciliación.');
        }
        decisions[identity] = decision.action === 'link'
          ? { action: 'link', eventId: String(decision.eventId) }
          : { action: 'confirm_msi', eventId: String(decision.eventId) };
        continue;
      }
      if (decision.action === 'create_plan') {
        if (!Number.isInteger(decision.months) || Number(decision.months) < 1 || Number(decision.months) > 48) {
          throw new InvalidSantanderCsvError('Los meses del plan MSI no son válidos.');
        }
        if (!Number.isInteger(decision.cuotaMinor) || Number(decision.cuotaMinor) <= 0) {
          throw new InvalidSantanderCsvError('La cuota del plan MSI no es válida.');
        }
        if (decision.startMonth !== undefined && (typeof decision.startMonth !== 'string' || !isValidMonth(decision.startMonth))) {
          throw new InvalidSantanderCsvError('El mes de inicio del plan MSI no es válido.');
        }
        decisions[identity] = {
          action: 'create_plan',
          months: Number(decision.months),
          cuotaMinor: Number(decision.cuotaMinor),
          ...(typeof decision.startMonth === 'string' ? { startMonth: decision.startMonth } : {}),
        };
        continue;
      }
      throw new InvalidSantanderCsvError('Una decisión de conciliación no es válida.');
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
  let msiConfirmed = 0;
  let eventsSnapshot = await allStoredEvents();
  for (const row of rows) {
    const previewRow = previewByIdentity.get(row.identity);
    const action = santanderApplyAction(row, previewRow, decisions[row.identity]);
    const msiEvidence: EvidenceLine | undefined = isSantanderMsiRow(row.merchantRaw) && row.amountMinor > 0
      ? {
          merchantRaw: row.merchantRaw,
          amountMinor: row.amountMinor,
          occurredOn: row.occurredOn,
          identity: row.identity,
        }
      : undefined;

    if (action.kind === 'confirm_msi' && msiEvidence) {
      const scoped = eventsSnapshot.filter((event) => event.id === action.eventId);
      const match = matchEvidenceLine(msiEvidence, scoped.length > 0 ? scoped : eventsSnapshot);
      if (match.kind === 'confirm' && match.eventId === action.eventId) {
        const updated = await persistEventMsi(
          match.eventId,
          owner,
          match.previous,
          match.next,
          'Cuota MSI confirmada con CSV Santander.',
        );
        if (updated) {
          msiConfirmed += 1;
          linked += 1;
          eventsSnapshot = eventsSnapshot.map((event) => event.id === match.eventId ? { ...event, msi: match.next } : event);
          continue;
        }
      }
      skipped += 1;
      continue;
    }

    if (action.kind === 'create_plan' && msiEvidence) {
      const plan = buildPlanFromCreateDecision(msiEvidence, {
        months: action.months,
        cuotaMinor: action.cuotaMinor,
        startMonth: action.startMonth,
      });
      const purchase = await claimAndCreateCsvEvent(owner, document, row, source, appliedAt, plan);
      if (purchase) {
        created.push(toPublicEvent(purchase));
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
      continue;
    }

    if (action.kind === 'create') {
      // Matched MSI rows use link/confirm; never invent schedules on plain create.
      if (msiEvidence) {
        const match = matchEvidenceLine(msiEvidence, eventsSnapshot);
        if (match.kind === 'confirm') {
          const updated = await persistEventMsi(
            match.eventId,
            owner,
            match.previous,
            match.next,
            'Cuota MSI confirmada con CSV Santander.',
          );
          if (updated) {
            msiConfirmed += 1;
            linked += 1;
            eventsSnapshot = eventsSnapshot.map((event) => event.id === match.eventId ? { ...event, msi: match.next } : event);
            continue;
          }
        }
        skipped += 1;
        continue;
      }
      const purchase = await claimAndCreateCsvEvent(owner, document, row, source, appliedAt);
      if (purchase) {
        created.push(toPublicEvent(purchase));
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
    } else if (action.kind === 'link') {
      if (msiEvidence) {
        const scoped = eventsSnapshot.filter((event) => event.id === action.eventId);
        const match = matchEvidenceLine(msiEvidence, scoped.length > 0 ? scoped : eventsSnapshot);
        if (match.kind === 'confirm') {
          const updated = await persistEventMsi(
            match.eventId,
            owner,
            match.previous,
            match.next,
            'Cuota MSI confirmada con CSV Santander.',
          );
          if (updated) {
            msiConfirmed += 1;
            eventsSnapshot = eventsSnapshot.map((event) => event.id === match.eventId ? { ...event, msi: match.next } : event);
          }
        }
      }
      if (await claimAndLinkCsvEvidence(owner, action.eventId, row, source, appliedAt)) linked += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER#${importId}` },
    ...santanderImportCompletionUpdate(appliedAt, { created: created.length, linked, skipped }),
  }));
  return {
    importId,
    created,
    summary: { created: created.length, linked, skipped, msiConfirmed },
  };
};

const amexSourceKey = (owner: string, sha256: string): string =>
  `manual-imports/amex/${owner}/${sha256}.pdf`;
const santanderStatementSourceKey = (owner: string, sha256: string): string =>
  `manual-imports/santander-statement/${owner}/${sha256}.pdf`;

const headerValue = (event: { readonly headers?: Record<string, string | undefined> }, name: string): string | undefined => {
  if (!event.headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
};

const requestBinaryBody = (event: {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}): Buffer | undefined => {
  if (!event.body) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
};

const claimedStatementIdentities = async (
  provider: StatementProvider,
  identities: readonly string[],
): Promise<ReadonlySet<string>> => {
  const claimed = new Set<string>();
  for (let offset = 0; offset < identities.length; offset += 100) {
    let requestKeys: Record<string, unknown>[] = identities
      .slice(offset, offset + 100)
      .map((identity) => statementClaimKey(provider, identity));
    let attempts = 0;
    do {
      if (attempts > 0) await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempts)));
      const result = await database.send(new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: requestKeys, ProjectionExpression: 'PK' } },
      }));
      for (const item of result.Responses?.[tableName] ?? []) claimed.add(String(item.PK));
      requestKeys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
      attempts += 1;
      if (attempts >= 6 && requestKeys.length > 0) {
        throw new Error('Unable to verify statement dedupe keys after multiple attempts.');
      }
    } while (requestKeys.length > 0);
  }
  return claimed;
};

const classifyMsiEvidenceRow = (
  line: EvidenceLine,
  events: readonly JsonObject[],
): StatementPreviewRow => {
  const match = matchEvidenceLine(line, events);
  if (match.kind === 'confirm') {
    return {
      identity: line.identity,
      kind: 'msi',
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      occurredOn: line.occurredOn,
      msi: true,
      installmentIndex: line.installmentIndex,
      installmentMonths: line.installmentMonths,
      originalAmountMinor: line.originalAmountMinor,
      status: 'matched',
      eventId: match.eventId,
      candidateEventIds: [match.eventId],
      candidates: [],
    };
  }
  if (match.kind === 'needs_decision') {
    const candidates = match.candidates.map((candidate) => ({
      id: candidate.eventId,
      merchantRaw: candidate.merchantRaw,
    }));
    return {
      identity: line.identity,
      kind: 'msi',
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      occurredOn: line.occurredOn,
      msi: true,
      installmentIndex: line.installmentIndex,
      installmentMonths: line.installmentMonths,
      originalAmountMinor: line.originalAmountMinor,
      status: 'needs_decision',
      candidateEventIds: candidates.map((candidate) => candidate.id),
      candidates,
    };
  }
  return {
    identity: line.identity,
    kind: 'msi',
    merchantRaw: line.merchantRaw,
    amountMinor: line.amountMinor,
    occurredOn: line.occurredOn,
    msi: true,
    installmentIndex: line.installmentIndex,
    installmentMonths: line.installmentMonths,
    originalAmountMinor: line.originalAmountMinor,
    status: 'skipped',
    candidateEventIds: [],
    candidates: [],
  };
};

const buildSantanderStatementPreviewRows = async (
  document: SantanderStatementDocument,
): Promise<readonly StatementPreviewRow[]> => {
  const events = await allStoredEvents();
  const identities = document.charges.map((charge) => charge.identity);
  const claimed = await claimedStatementIdentities('santander', identities);
  const purchaseRows = document.charges
    .filter((charge) => !charge.msi)
    .map((charge) => classifyPurchaseCharge({
      provider: 'santander',
      accountLastFour: document.accountLastFour,
      institution: 'santander_mx',
      charge,
      events,
      claimed,
      localDate,
    }));
  const msiRows = document.msiCharges.map((charge) => classifyMsiEvidenceRow({
    merchantRaw: charge.merchantRaw,
    amountMinor: charge.amountMinor,
    occurredOn: charge.occurredOn,
    identity: charge.identity,
    installmentIndex: charge.installmentIndex,
    installmentMonths: charge.installmentMonths,
    originalAmountMinor: charge.originalAmountMinor,
  }, events));
  return [...purchaseRows, ...msiRows];
};

const statementPreviewResponse = (
  importId: string,
  document: { readonly accountLastFour: string; readonly product: string; readonly period: { readonly from: string; readonly to: string } },
  rows: readonly StatementPreviewRow[],
): JsonObject => ({
  importId,
  status: 'ready',
  accountLastFour: document.accountLastFour,
  product: document.product,
  period: document.period,
  summary: statementPreviewSummary(rows),
  rows,
});

const previewSantanderStatementImport = async (
  event: {
    readonly body?: string | null;
    readonly isBase64Encoded?: boolean;
    readonly headers?: Record<string, string | undefined>;
  },
  owner: string,
): Promise<JsonObject> => {
  const contentType = (headerValue(event, 'content-type') ?? 'application/pdf').toLowerCase();
  const bytes = requestBinaryBody(event);
  if (!bytes || bytes.length === 0) {
    throw new InvalidSantanderStatementError('El estado de cuenta Santander está vacío.');
  }
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new InvalidSantanderStatementError('Sube el PDF del estado de cuenta Santander.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = {
    bucket: rawSourceBucketName,
    key: santanderStatementSourceKey(owner, sha256),
    sha256,
    contentType: 'application/pdf' as const,
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: source.key,
    Body: bytes,
    ContentType: 'application/pdf',
  }));
  const textractJobId = await startTextractDocumentAnalysis(
    textract,
    rawSourceBucketName,
    source.key,
    'santander',
  );
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${owner}`,
      SK: `IMPORT#SANTANDER_STATEMENT#${sha256}`,
      entityType: 'santander_statement_import',
      owner,
      status: 'processing',
      createdAt: new Date().toISOString(),
      source,
      textractJobId,
    },
  }));
  return {
    importId: sha256,
    status: 'processing',
    message: 'Leyendo el PDF con Textract. Consulta el estado en unos segundos.',
  };
};

const persistTextractExtraction = async (
  sourceKey: string,
  extraction: TextractStatementExtraction,
): Promise<string> => {
  const extractionKey = sourceKey.replace(/\.pdf$/i, '.textract.json');
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: extractionKey,
    Body: JSON.stringify(extraction),
    ContentType: 'application/json; charset=utf-8',
  }));
  return extractionKey;
};

const loadStatementTextractExtraction = async (item: JsonObject): Promise<TextractStatementExtraction> => {
  const source = item.source as JsonObject | undefined;
  const extractionKey = typeof item.extractionKey === 'string'
    ? item.extractionKey
    : typeof source?.key === 'string'
      ? source.key.replace(/\.pdf$/i, '.textract.json')
      : undefined;
  if (!extractionKey) throw new Error('Missing Textract extraction for statement import apply.');
  const object = await s3.send(new GetObjectCommand({ Bucket: rawSourceBucketName, Key: extractionKey }));
  if (!object.Body) throw new Error('Statement Textract extraction did not contain a body.');
  const parsed = JSON.parse(await object.Body.transformToString('utf8')) as TextractStatementExtraction;
  if (!parsed?.answers || !Array.isArray(parsed.tables)) {
    throw new Error('Invalid Textract extraction payload.');
  }
  return parsed;
};

const getSantanderStatementImport = async (importId: string, owner: string): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) {
    throw new InvalidSantanderStatementError('Identificador de importación inválido.');
  }
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
    ConsistentRead: true,
  }));
  if (!stored.Item || stored.Item.owner !== owner) {
    throw new InvalidSantanderStatementError('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.Item.status === 'previewed' || stored.Item.status === 'applied') {
    const rows = Array.isArray(stored.Item.rows) ? stored.Item.rows as readonly StatementPreviewRow[] : [];
    return statementPreviewResponse(
      importId,
      {
        accountLastFour: String(stored.Item.accountLastFour ?? ''),
        product: String(stored.Item.product ?? 'Santander'),
        period: stored.Item.period as { readonly from: string; readonly to: string },
      },
      rows,
    );
  }
  if (stored.Item.status === 'failed') {
    throw new InvalidSantanderStatementError(
      typeof stored.Item.errorMessage === 'string'
        ? stored.Item.errorMessage
        : 'No se pudo leer el estado Santander.',
    );
  }

  const jobId = typeof stored.Item.textractJobId === 'string' ? stored.Item.textractJobId : undefined;
  if (!jobId) throw new InvalidSantanderStatementError('Falta el trabajo de Textract para este import.');

  const job = await getTextractAnalysisJobStatus(textract, jobId);
  if (job.status === 'IN_PROGRESS') {
    return {
      importId,
      status: 'processing',
      message: 'Textract sigue leyendo el PDF…',
    };
  }
  if (job.status === 'FAILED') {
    const message = job.statusMessage ?? 'Textract falló al leer el PDF.';
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
      UpdateExpression: 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: { '#status': 'status', '#errorMessage': 'errorMessage' },
      ExpressionAttributeValues: { ':status': 'failed', ':errorMessage': message },
    }));
    throw new TextractDocumentError(message);
  }

  const source = stored.Item.source as JsonObject;
  const sourceKey = typeof source.key === 'string'
    ? source.key
    : santanderStatementSourceKey(owner, importId);
  let extractionKey: string | undefined;
  let answers: Readonly<Record<string, string>> = {};
  try {
    const extraction = await fetchTextractStatementExtraction(textract, jobId, 'santander');
    answers = extraction.answers;
    console.info('Santander Textract extraction ready', {
      importId,
      jobId,
      answers: Object.keys(extraction.answers),
      tables: extraction.tables.length,
      lines: extraction.lines.length,
    });
    extractionKey = await persistTextractExtraction(sourceKey, extraction);
    const document = parseSantanderStatementExtraction(extraction);
    const rows = await buildSantanderStatementPreviewRows(document);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
      UpdateExpression: 'SET #status = :status, #accountLastFour = :accountLastFour, #product = :product, #period = :period, #rows = :rows, #extractionKey = :extractionKey, #textractAnswers = :textractAnswers',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#accountLastFour': 'accountLastFour',
        '#product': 'product',
        '#period': 'period',
        '#rows': 'rows',
        '#extractionKey': 'extractionKey',
        '#textractAnswers': 'textractAnswers',
      },
      ExpressionAttributeValues: {
        ':status': 'previewed',
        ':accountLastFour': document.accountLastFour,
        ':product': document.product,
        ':period': document.period,
        ':rows': rows,
        ':extractionKey': extractionKey,
        ':textractAnswers': extraction.answers,
      },
    }));
    return statementPreviewResponse(importId, document, rows);
  } catch (error) {
    const message = errorMessage(error);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
      UpdateExpression: extractionKey
        ? 'SET #status = :status, #errorMessage = :errorMessage, #extractionKey = :extractionKey, #textractAnswers = :textractAnswers'
        : 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#errorMessage': 'errorMessage',
        ...(extractionKey
          ? { '#extractionKey': 'extractionKey', '#textractAnswers': 'textractAnswers' }
          : {}),
      },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':errorMessage': message,
        ...(extractionKey
          ? {
              ':extractionKey': extractionKey,
              ':textractAnswers': answers,
            }
          : {}),
      },
    }));
    if (
      error instanceof InvalidSantanderStatementError
      || error instanceof TextractDocumentError
    ) {
      throw error;
    }
    throw new InvalidSantanderStatementError(message);
  }
};


const parseStatementDecisions = (body: string | undefined): Readonly<Record<string, StatementDecision>> => {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { decisions?: unknown };
    if (!parsed.decisions || typeof parsed.decisions !== 'object' || Array.isArray(parsed.decisions)) return {};
    const decisions: Record<string, StatementDecision> = {};
    for (const [identity, raw] of Object.entries(parsed.decisions as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') {
        throw new InvalidAmexStatementError('Una decisión de conciliación no es válida.');
      }
      const decision = raw as {
        action?: unknown;
        eventId?: unknown;
        months?: unknown;
        cuotaMinor?: unknown;
        startMonth?: unknown;
      };
      if (decision.action === 'create') {
        decisions[identity] = { action: 'create' };
        continue;
      }
      if (decision.action === 'skip') {
        decisions[identity] = { action: 'skip' };
        continue;
      }
      if (decision.action === 'link' || decision.action === 'confirm_msi') {
        if (typeof decision.eventId !== 'string') {
          throw new InvalidAmexStatementError('Falta el movimiento elegido para una conciliación MSI.');
        }
        decisions[identity] = decision.action === 'link'
          ? { action: 'link', eventId: decision.eventId }
          : { action: 'confirm_msi', eventId: decision.eventId };
        continue;
      }
      if (decision.action === 'create_plan') {
        if (!Number.isInteger(decision.months) || Number(decision.months) < 1 || Number(decision.months) > 48) {
          throw new InvalidAmexStatementError('Los meses del plan MSI no son válidos.');
        }
        if (!Number.isInteger(decision.cuotaMinor) || Number(decision.cuotaMinor) <= 0) {
          throw new InvalidAmexStatementError('La cuota del plan MSI no es válida.');
        }
        if (decision.startMonth !== undefined && (typeof decision.startMonth !== 'string' || !isValidMonth(decision.startMonth))) {
          throw new InvalidAmexStatementError('El mes de inicio del plan MSI no es válido.');
        }
        decisions[identity] = {
          action: 'create_plan',
          months: Number(decision.months),
          cuotaMinor: Number(decision.cuotaMinor),
          ...(typeof decision.startMonth === 'string' ? { startMonth: decision.startMonth } : {}),
        };
        continue;
      }
      throw new InvalidAmexStatementError('Una decisión de conciliación no es válida.');
    }
    return decisions;
  } catch (error) {
    if (error instanceof InvalidAmexStatementError) throw error;
    throw new InvalidAmexStatementError('Las decisiones de conciliación no tienen un formato válido.');
  }
};

const claimAndCreateStatementEvent = async (input: {
  readonly provider: StatementProvider;
  readonly owner: string;
  readonly accountLastFour: string;
  readonly row: StatementPreviewRow;
  readonly source: JsonObject;
  readonly appliedAt: string;
  readonly msi?: MsiPlan;
}): Promise<JsonObject | undefined> => {
  const institution = input.provider === 'amex' ? 'american_express_mx' : 'santander_mx';
  const captureSource = input.provider === 'amex' ? 'amex_statement' : 'santander_statement';
  const parserVersion = input.provider === 'amex'
    ? 'amex-mx-statement-textract-v1'
    : 'santander-mx-statement-textract-v1';
  const id = randomUUID();
  const observationId = randomUUID();
  const occurredAt = `${input.row.occurredOn}T12:00:00.000Z`;
  const amountMinor = input.msi?.principalMinor ?? input.row.amountMinor;
  const purchase: JsonObject = {
    id,
    institution,
    eventType: 'card_purchase',
    status: input.msi?.needsScheduleCompletion ? 'needs_review' : 'accepted',
    account: {
      institution,
      accountId: `${institution}:${input.accountLastFour}`,
      displayName: input.provider === 'amex'
        ? `American Express · ${input.accountLastFour}`
        : `Santander · ${input.accountLastFour}`,
      lastFour: input.accountLastFour,
    },
    amount: { amountMinor, currency: 'MXN' },
    merchantRaw: input.row.merchantRaw,
    occurredAt,
    receivedAt: input.appliedAt,
    ingestedAt: input.appliedAt,
    source: input.source,
    parserVersion,
    parseWarnings: input.msi?.needsScheduleCompletion
      ? ['MSI sin plan completo: confirma meses y cuota.']
      : [],
    captureSource,
    captureSources: [captureSource],
    observationCount: 1,
    primaryObservationId: observationId,
    hasRawEmail: false,
    ...(input.msi ? { msi: input.msi } : {}),
  };
  const claim = statementClaimKey(input.provider, input.row.identity);
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: {
          ...claim,
          entityType: `${captureSource}_dedupe`,
          identity: input.row.identity,
          owner: input.owner,
          eventId: id,
          createdAt: input.appliedAt,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: 'EVENT',
          GSI1PK: 'EVENTS',
          GSI1SK: input.appliedAt,
          GSI2PK: reconciliationPartition(purchase as Parameters<typeof reconciliationPartition>[0]),
          GSI2SK: `${occurredAt}#${id}`,
          ...eventMonthIndexKeys({ eventId: id, occurredAt, receivedAt: input.appliedAt }),
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
          payload: {
            id: observationId,
            eventId: id,
            captureSource,
            observedAt: input.appliedAt,
            reconciliationAt: occurredAt,
            institution,
            eventType: 'card_purchase',
            account: purchase.account,
            amount: purchase.amount,
            merchantRaw: input.row.merchantRaw,
            occurredAt,
            source: input.source,
            parserVersion,
            parseWarnings: purchase.parseWarnings,
          },
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

const claimAndLinkStatementEvidence = async (input: {
  readonly provider: StatementProvider;
  readonly owner: string;
  readonly eventId: string;
  readonly row: StatementPreviewRow;
  readonly source: JsonObject;
  readonly appliedAt: string;
}): Promise<boolean> => {
  const institution = input.provider === 'amex' ? 'american_express_mx' : 'santander_mx';
  const captureSource = input.provider === 'amex' ? 'amex_statement' : 'santander_statement';
  const parserVersion = input.provider === 'amex'
    ? 'amex-mx-statement-textract-v1'
    : 'santander-mx-statement-textract-v1';
  const revisionId = randomUUID();
  const observationId = randomUUID();
  const reconciliationAt = `${input.row.occurredOn}T12:00:00.000Z`;
  const claim = statementClaimKey(input.provider, input.row.identity);
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: {
          ...claim,
          entityType: `${captureSource}_dedupe`,
          identity: input.row.identity,
          owner: input.owner,
          createdAt: input.appliedAt,
          eventId: input.eventId,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Update: {
        TableName: tableName,
        Key: { PK: `EVENT#${input.eventId}`, SK: 'EVENT' },
        UpdateExpression: 'SET #payload.#count = if_not_exists(#payload.#count, :one) + :one, #payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source), #payload.#reconciledAt = :reconciledAt',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: {
          '#payload': 'payload',
          '#count': 'observationCount',
          '#sources': 'captureSources',
          '#reconciledAt': 'reconciledAt',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':empty': [],
          ':source': [captureSource],
          ':reconciledAt': input.appliedAt,
        },
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${input.eventId}`,
          SK: `OBSERVATION#${reconciliationAt}#${observationId}`,
          entityType: 'event_observation',
          payload: {
            id: observationId,
            eventId: input.eventId,
            captureSource,
            observedAt: input.appliedAt,
            reconciliationAt,
            institution,
            eventType: 'card_purchase',
            amount: { amountMinor: input.row.amountMinor, currency: 'MXN' },
            merchantRaw: input.row.merchantRaw,
            occurredAt: reconciliationAt,
            source: input.source,
            parserVersion,
            parseWarnings: [],
          },
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${input.eventId}`,
          SK: `REVISION#${input.appliedAt}#${revisionId}`,
          entityType: 'event_revision',
          payload: {
            id: revisionId,
            observedPurchaseId: input.eventId,
            createdAt: input.appliedAt,
            changedBy: input.owner,
            reason: input.provider === 'amex'
              ? 'Conciliado con estado de cuenta Amex.'
              : 'Conciliado con estado de cuenta Santander.',
            changes: { reconciliation: { previous: null, next: { source: input.source, reconciledAt: input.appliedAt } } },
          },
        },
      } },
    ] }));
    return true;
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') return false;
    throw error;
  }
};

const applyStatementImport = async (input: {
  readonly provider: StatementProvider;
  readonly importId: string;
  readonly owner: string;
  readonly decisionBody: string | undefined;
  readonly rebuildRows: () => Promise<readonly StatementPreviewRow[]>;
}): Promise<JsonObject> => {
  const invalid = input.provider === 'amex' ? InvalidAmexStatementError : InvalidSantanderStatementError;
  const sk = input.provider === 'amex'
    ? `IMPORT#AMEX#${input.importId}`
    : `IMPORT#SANTANDER_STATEMENT#${input.importId}`;
  if (!/^[a-f0-9]{64}$/.test(input.importId)) throw new invalid('Identificador de importación inválido.');
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${input.owner}`, SK: sk },
    ConsistentRead: true,
  }));
  const source = stored.Item?.source as JsonObject | undefined;
  if (!stored.Item || stored.Item.owner !== input.owner || typeof source?.key !== 'string') {
    throw new invalid('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.Item.status === 'processing') {
    throw new invalid('El PDF aún se está leyendo. Espera a que termine Textract.');
  }
  if (stored.Item.status === 'failed') {
    throw new invalid(
      typeof stored.Item.errorMessage === 'string'
        ? stored.Item.errorMessage
        : 'No se pudo leer el estado de cuenta.',
    );
  }
  if (stored.Item.status === 'applied') {
    const previous = stored.Item.result as JsonObject | undefined;
    return {
      importId: input.importId,
      created: [],
      summary: previous ?? { created: 0, linked: 0, skipped: 0, msiConfirmed: 0, createdUnplanned: 0 },
      alreadyApplied: true,
    };
  }
  if (stored.Item.status !== 'previewed' || !Array.isArray(stored.Item.rows)) {
    throw new invalid('La previsualización aún no está lista.');
  }

  const accountLastFour = String(stored.Item.accountLastFour ?? '');
  const previewRows = stored.Item.rows as readonly StatementPreviewRow[];
  const previewByIdentity = new Map(previewRows.map((row) => [row.identity, row]));
  const decisions = parseStatementDecisions(input.decisionBody);
  const currentRows = await input.rebuildRows();
  const appliedAt = new Date().toISOString();
  let eventsSnapshot = await allStoredEvents();
  let createdCount = 0;
  let linked = 0;
  let skipped = 0;
  let msiConfirmed = 0;
  let createdUnplanned = 0;
  const created: JsonObject[] = [];

  for (const row of currentRows) {
    const preview = previewByIdentity.get(row.identity);
    if (row.kind === 'msi') {
      const evidence: EvidenceLine = {
        merchantRaw: row.merchantRaw,
        amountMinor: row.amountMinor,
        occurredOn: row.occurredOn,
        identity: row.identity,
        installmentIndex: row.installmentIndex,
        installmentMonths: row.installmentMonths,
        originalAmountMinor: row.originalAmountMinor,
      };
      const action = statementMsiApplyAction(row, preview, decisions[row.identity]);
      const msiNote = input.provider === 'amex'
        ? 'Cuota MSI confirmada con estado de cuenta Amex.'
        : 'Cuota MSI confirmada con estado de cuenta Santander.';
      if (action.kind === 'confirm_msi') {
        const match = matchEvidenceLine(
          evidence,
          eventsSnapshot.filter((event) => event.id === action.eventId),
        );
        if (match.kind !== 'confirm') {
          // Fall back to full snapshot if scoped miss (e.g. plan updated mid-apply).
          const fallback = matchEvidenceLine(evidence, eventsSnapshot);
          if (fallback.kind !== 'confirm' || fallback.eventId !== action.eventId) {
            skipped += 1;
            continue;
          }
          const updated = await persistEventMsi(fallback.eventId, input.owner, fallback.previous, fallback.next, msiNote);
          if (updated) {
            msiConfirmed += 1;
            linked += 1;
            eventsSnapshot = eventsSnapshot.map((event) => (
              event.id === fallback.eventId ? { ...event, msi: fallback.next } : event
            ));
          } else skipped += 1;
          continue;
        }
        const updated = await persistEventMsi(match.eventId, input.owner, match.previous, match.next, msiNote);
        if (updated) {
          msiConfirmed += 1;
          linked += 1;
          eventsSnapshot = eventsSnapshot.map((event) => (
            event.id === match.eventId ? { ...event, msi: match.next } : event
          ));
        } else skipped += 1;
        continue;
      }
      if (action.kind === 'create_plan') {
        const plan = buildPlanFromCreateDecision(evidence, {
          months: action.months,
          cuotaMinor: action.cuotaMinor,
          startMonth: action.startMonth,
        });
        const purchase = await claimAndCreateStatementEvent({
          provider: input.provider,
          owner: input.owner,
          accountLastFour,
          row,
          source,
          appliedAt,
          msi: plan,
        });
        if (purchase) {
          created.push(toPublicEvent(purchase));
          createdCount += 1;
          eventsSnapshot = [...eventsSnapshot, purchase];
        } else skipped += 1;
        continue;
      }
      skipped += 1;
      continue;
    }

    const action = statementPurchaseApplyAction(row, preview, decisions[row.identity]);
    if (action.kind === 'create') {
      const purchase = await claimAndCreateStatementEvent({
        provider: input.provider,
        owner: input.owner,
        accountLastFour,
        row,
        source,
        appliedAt,
      });
      if (purchase) {
        created.push(toPublicEvent(purchase));
        createdCount += 1;
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
    } else if (action.kind === 'link') {
      if (await claimAndLinkStatementEvidence({
        provider: input.provider,
        owner: input.owner,
        eventId: action.eventId,
        row,
        source,
        appliedAt,
      })) linked += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }

  const summary = { created: createdCount, linked, skipped, msiConfirmed, createdUnplanned };
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `USER#${input.owner}`, SK: sk },
    ...statementImportCompletionUpdate(appliedAt, summary),
  }));
  return { importId: input.importId, created, summary };
};

const applySantanderStatementImport = async (
  importId: string,
  owner: string,
  decisionBody: string | undefined,
): Promise<JsonObject> => applyStatementImport({
  provider: 'santander',
  importId,
  owner,
  decisionBody,
  rebuildRows: async () => {
    const stored = await database.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
      ConsistentRead: true,
    }));
    const extraction = await loadStatementTextractExtraction(stored.Item as JsonObject);
    return buildSantanderStatementPreviewRows(parseSantanderStatementExtraction(extraction));
  },
});

const buildAmexPreviewRows = async (
  document: AmexStatementDocument,
): Promise<readonly StatementPreviewRow[]> => {
  const events = await allStoredEvents();
  const purchaseCharges = document.charges.filter((charge) => !charge.msi);
  const claimed = await claimedStatementIdentities(
    'amex',
    purchaseCharges.map((charge) => charge.identity),
  );
  const purchaseRows = purchaseCharges.map((charge) => classifyPurchaseCharge({
    provider: 'amex',
    accountLastFour: document.accountLastFour,
    institution: 'american_express_mx',
    charge,
    events,
    claimed,
    localDate,
  }));

  const msiRows = amexMsiEvidenceLines(document).map((line) => classifyMsiEvidenceRow(line, events));
  return [...purchaseRows, ...msiRows];
};

const previewAmexImport = async (
  event: {
    readonly body?: string | null;
    readonly isBase64Encoded?: boolean;
    readonly headers?: Record<string, string | undefined>;
  },
  owner: string,
): Promise<JsonObject> => {
  const contentType = (headerValue(event, 'content-type') ?? 'application/pdf').toLowerCase();
  const bytes = requestBinaryBody(event);
  if (!bytes || bytes.length === 0) throw new InvalidAmexStatementError('El estado de cuenta Amex está vacío.');
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new InvalidAmexStatementError('Sube el PDF del estado de cuenta Amex.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = {
    bucket: rawSourceBucketName,
    key: amexSourceKey(owner, sha256),
    sha256,
    contentType: 'application/pdf' as const,
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: source.key,
    Body: bytes,
    ContentType: 'application/pdf',
  }));
  const textractJobId = await startTextractDocumentAnalysis(
    textract,
    rawSourceBucketName,
    source.key,
    'amex',
  );
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${owner}`,
      SK: `IMPORT#AMEX#${sha256}`,
      entityType: 'amex_statement_import',
      owner,
      status: 'processing',
      createdAt: new Date().toISOString(),
      source,
      textractJobId,
    },
  }));
  return {
    importId: sha256,
    status: 'processing',
    message: 'Leyendo el PDF con Textract. Consulta el estado en unos segundos.',
  };
};

const getAmexImport = async (importId: string, owner: string): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) {
    throw new InvalidAmexStatementError('Identificador de importación inválido.');
  }
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
    ConsistentRead: true,
  }));
  if (!stored.Item || stored.Item.owner !== owner) {
    throw new InvalidAmexStatementError('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.Item.status === 'previewed' || stored.Item.status === 'applied') {
    const rows = Array.isArray(stored.Item.rows) ? stored.Item.rows as readonly StatementPreviewRow[] : [];
    return statementPreviewResponse(
      importId,
      {
        accountLastFour: String(stored.Item.accountLastFour ?? ''),
        product: String(stored.Item.product ?? 'American Express'),
        period: stored.Item.period as { readonly from: string; readonly to: string },
      },
      rows,
    );
  }
  if (stored.Item.status === 'failed') {
    throw new InvalidAmexStatementError(
      typeof stored.Item.errorMessage === 'string'
        ? stored.Item.errorMessage
        : 'No se pudo leer el estado Amex.',
    );
  }

  const jobId = typeof stored.Item.textractJobId === 'string' ? stored.Item.textractJobId : undefined;
  if (!jobId) throw new InvalidAmexStatementError('Falta el trabajo de Textract para este import.');

  const job = await getTextractAnalysisJobStatus(textract, jobId);
  if (job.status === 'IN_PROGRESS') {
    return {
      importId,
      status: 'processing',
      message: 'Textract sigue leyendo el PDF…',
    };
  }
  if (job.status === 'FAILED') {
    const message = job.statusMessage ?? 'Textract falló al leer el PDF.';
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      UpdateExpression: 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: { '#status': 'status', '#errorMessage': 'errorMessage' },
      ExpressionAttributeValues: { ':status': 'failed', ':errorMessage': message },
    }));
    throw new TextractDocumentError(message);
  }

  const source = stored.Item.source as JsonObject;
  const sourceKey = typeof source.key === 'string'
    ? source.key
    : amexSourceKey(owner, importId);
  let extractionKey: string | undefined;
  let answers: Readonly<Record<string, string>> = {};
  try {
    const extraction = await fetchTextractStatementExtraction(textract, jobId, 'amex');
    answers = extraction.answers;
    console.info('Amex Textract extraction ready', {
      importId,
      jobId,
      answers: Object.keys(extraction.answers),
      tables: extraction.tables.length,
      lines: extraction.lines.length,
    });
    extractionKey = await persistTextractExtraction(sourceKey, extraction);
    const document = parseAmexStatementExtraction(extraction);
    const rows = await buildAmexPreviewRows(document);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      UpdateExpression: 'SET #status = :status, #accountLastFour = :accountLastFour, #product = :product, #period = :period, #rows = :rows, #extractionKey = :extractionKey, #textractAnswers = :textractAnswers',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#accountLastFour': 'accountLastFour',
        '#product': 'product',
        '#period': 'period',
        '#rows': 'rows',
        '#extractionKey': 'extractionKey',
        '#textractAnswers': 'textractAnswers',
      },
      ExpressionAttributeValues: {
        ':status': 'previewed',
        ':accountLastFour': document.accountLastFour,
        ':product': document.product,
        ':period': document.period,
        ':rows': rows,
        ':extractionKey': extractionKey,
        ':textractAnswers': extraction.answers,
      },
    }));
    return statementPreviewResponse(importId, document, rows);
  } catch (error) {
    const message = errorMessage(error);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      UpdateExpression: extractionKey
        ? 'SET #status = :status, #errorMessage = :errorMessage, #extractionKey = :extractionKey, #textractAnswers = :textractAnswers'
        : 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#errorMessage': 'errorMessage',
        ...(extractionKey
          ? { '#extractionKey': 'extractionKey', '#textractAnswers': 'textractAnswers' }
          : {}),
      },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':errorMessage': message,
        ...(extractionKey
          ? {
              ':extractionKey': extractionKey,
              ':textractAnswers': answers,
            }
          : {}),
      },
    }));
    if (error instanceof InvalidAmexStatementError || error instanceof TextractDocumentError) {
      throw error;
    }
    throw new InvalidAmexStatementError(message);
  }
};

const applyAmexImport = async (
  importId: string,
  owner: string,
  decisionBody: string | undefined,
): Promise<JsonObject> => applyStatementImport({
  provider: 'amex',
  importId,
  owner,
  decisionBody,
  rebuildRows: async () => {
    const stored = await database.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      ConsistentRead: true,
    }));
    const extraction = await loadStatementTextractExtraction(stored.Item as JsonObject);
    return buildAmexPreviewRows(parseAmexStatementExtraction(extraction));
  },
});

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

const MSI_LOOKBACK_MONTHS = 24;

const queryEventsForMonthPartition = async (month: string): Promise<readonly JsonObject[]> => {
  const events: JsonObject[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :partition',
      ExpressionAttributeValues: { ':partition': eventMonthPartition(month) },
      ScanIndexForward: false,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) {
      if (item.payload) events.push(toPublicEvent(item.payload as JsonObject));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return events;
};

/** Spend-month events plus MSI plans whose cuota falls in `month` but purchase was earlier. */
const listEventsForMonth = async (
  month: string,
): Promise<{ readonly events: readonly JsonObject[]; readonly msiRelated: readonly JsonObject[] }> => {
  const events = await queryEventsForMonthPartition(month);
  const lookback: JsonObject[] = [];
  for (const priorMonth of priorCalendarMonths(month, MSI_LOOKBACK_MONTHS)) {
    lookback.push(...await queryEventsForMonthPartition(priorMonth));
  }
  const feed = buildMonthEventFeed(
    month,
    events as unknown as readonly MonthFeedEvent[],
    lookback as unknown as readonly MonthFeedEvent[],
  );
  return {
    events: feed.events as unknown as readonly JsonObject[],
    msiRelated: feed.msiRelated as unknown as readonly JsonObject[],
  };
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

const patchEvent = async (
  eventId: string,
  changedBy: string,
  body: string | undefined,
): Promise<JsonObject | undefined> => {
  let parsed: JsonObject = {};
  if (body?.trim()) {
    try {
      const value = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      parsed = value as JsonObject;
    } catch {
      throw new InvalidManualEntryError('PATCH body must be a JSON object when provided.');
    }
  }
  const action = typeof parsed.action === 'string'
    ? parsed.action
    : parsed.status === 'rejected'
      ? 'reject'
      : parsed.status === 'accepted'
        ? 'verify'
        : 'verify';
  if (action === 'reject') return markRejected(eventId, changedBy);
  if (action === 'set_msi') return setEventMsi(eventId, changedBy, parsed);
  if (action === 'clear_msi') return clearEventMsi(eventId, changedBy);
  if (action === 'cancel_msi_remaining') return cancelEventMsiRemaining(eventId, changedBy);
  if (action === 'complete_msi_schedule') return completeEventMsiSchedule(eventId, changedBy, parsed);
  if (action === 'verify') return markVerified(eventId, changedBy);
  throw new InvalidManualEntryError('Unsupported PATCH action.');
};

const readMsiPlan = (value: unknown): MsiPlan | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  return value as MsiPlan;
};

const persistEventMsi = async (
  eventId: string,
  changedBy: string,
  previous: unknown,
  next: MsiPlan | undefined,
  reason: string,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: next
      ? 'SET #payload.#msi = :msi'
      : 'REMOVE #payload.#msi',
    ExpressionAttributeNames: { '#payload': 'payload', '#msi': 'msi' },
    ...(next ? { ExpressionAttributeValues: { ':msi': next } } : {}),
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason,
    changes: {
      msi: { previous, next: next ?? null },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${revision.createdAt}#${revision.id}`, entityType: 'event_revision', payload: revision },
  }));
  return toPublicEvent(
    updated.Attributes?.payload as JsonObject,
    [revision, ...(Array.isArray(existing.revisions) ? existing.revisions as JsonObject[] : [])],
    Array.isArray(existing.observations) ? existing.observations as JsonObject[] : [],
  );
};

const setEventMsi = async (eventId: string, changedBy: string, body: JsonObject): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const amount = existing.amount as { amountMinor?: number } | undefined;
  const principalMinor = Number(amount?.amountMinor);
  const months = Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > 48) throw new InvalidMsiError('Los meses MSI deben ser un entero entre 1 y 48.');
  if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) throw new InvalidMsiError('El movimiento no tiene un monto válido para MSI.');
  const startMonth = typeof body.startMonth === 'string' && /^\d{4}-\d{2}$/.test(body.startMonth)
    ? body.startMonth
    : monthKeyInZone(new Date(String(existing.occurredAt ?? existing.receivedAt)));
  const cuotaMinor = body.cuotaMinor === undefined ? undefined : Number(body.cuotaMinor);
  if (cuotaMinor !== undefined && (!Number.isSafeInteger(cuotaMinor) || cuotaMinor <= 0)) {
    throw new InvalidMsiError('La cuota MSI debe ser un entero positivo en centavos.');
  }
  const previous = readMsiPlan(existing.msi);
  const plan = replaceMsiSchedule(previous, {
    principalMinor,
    months,
    startMonth,
    origin: previous?.origin === 'amex_auto' ? 'amex_auto' : 'manual',
    ...(cuotaMinor !== undefined ? { cuotaMinor } : {}),
  });
  return persistEventMsi(eventId, changedBy, existing.msi, plan, 'Plan MSI actualizado desde la UI.');
};

const clearEventMsi = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  return persistEventMsi(eventId, changedBy, existing.msi, undefined, 'Plan MSI eliminado desde la UI.');
};

const cancelEventMsiRemaining = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const current = readMsiPlan(existing.msi);
  if (!current) throw new InvalidMsiError('Este movimiento no tiene un plan MSI.');
  return persistEventMsi(
    eventId,
    changedBy,
    current,
    cancelRemainingInstallments(current),
    'Cuotas MSI restantes canceladas manualmente.',
  );
};

const completeEventMsiSchedule = async (
  eventId: string,
  changedBy: string,
  body: JsonObject,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const current = readMsiPlan(existing.msi);
  if (!current) throw new InvalidMsiError('Este movimiento no tiene un plan MSI.');
  const months = Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > 48) throw new InvalidMsiError('Los meses MSI deben ser un entero entre 1 y 48.');
  const startMonth = typeof body.startMonth === 'string' && /^\d{4}-\d{2}$/.test(body.startMonth)
    ? body.startMonth
    : monthKeyInZone(new Date(String(existing.occurredAt ?? existing.receivedAt)));
  const cuotaMinor = body.cuotaMinor === undefined ? undefined : Number(body.cuotaMinor);
  const next = completeUnplannedSchedule(current, {
    months,
    startMonth,
    ...(cuotaMinor !== undefined ? { cuotaMinor } : {}),
  });
  return persistEventMsi(eventId, changedBy, current, next, 'Schedule MSI completado desde la UI.');
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
  return toPublicEvent(updated.Attributes?.payload as JsonObject, [revision, ...(Array.isArray(existing.revisions) ? existing.revisions as JsonObject[] : [])], Array.isArray(existing.observations) ? existing.observations as JsonObject[] : []);
};

const markRejected = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  if (existing.status === 'rejected') {
    return existing;
  }
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: 'SET #payload.#status = :status',
    ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'rejected' },
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: 'Marcado como rechazado desde la UI.',
    changes: {
      status: { previous: existing.status, next: 'rejected' },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${revision.createdAt}#${revision.id}`, entityType: 'event_revision', payload: revision },
  }));
  return toPublicEvent(updated.Attributes?.payload as JsonObject, [revision, ...(Array.isArray(existing.revisions) ? existing.revisions as JsonObject[] : [])], Array.isArray(existing.observations) ? existing.observations as JsonObject[] : []);
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
    msi: payload.msi,
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
