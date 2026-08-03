import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { maybeAutoAmexMsi } from '@finance/domain';
import { eventMonthIndexKeys, reconciliationPartition } from '@finance/ingestion';
import {
  manualEntryFingerprint,
  manualEntrySourceKey,
  parseManualEntry,
  type ManualEntryInput,
} from './manual-entry-input.js';
import { database, rawSourceBucketName, s3, tableName } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { getEventDetail, toPublicEvent } from './queries.js';

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

export const createManualEvent = async (body: string | undefined, owner: string): Promise<JsonObject> => {
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
