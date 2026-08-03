import { GetObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildMonthEventFeed,
  eventMonthPartition,
  nextCalendarMonths,
  priorCalendarMonths,
  type MonthFeedEvent,
} from '@finance/ledger';
import { database, s3, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';

export const localDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Chihuahua',
  }).formatToParts(date);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export const allStoredEvents = async (): Promise<readonly JsonObject[]> => {
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

/** Spend-month events plus MSI plans whose cuota falls in `month` but purchase lives elsewhere. */
export const listEventsForMonth = async (
  month: string,
): Promise<{ readonly events: readonly JsonObject[]; readonly msiRelated: readonly JsonObject[] }> => {
  const events = await queryEventsForMonthPartition(month);
  const nearby: JsonObject[] = [];
  const nearbyMonths = [
    ...priorCalendarMonths(month, MSI_LOOKBACK_MONTHS),
    ...nextCalendarMonths(month, MSI_LOOKBACK_MONTHS),
  ];
  for (const nearbyMonth of nearbyMonths) {
    nearby.push(...await queryEventsForMonthPartition(nearbyMonth));
  }
  const feed = buildMonthEventFeed(
    month,
    events as unknown as readonly MonthFeedEvent[],
    nearby as unknown as readonly MonthFeedEvent[],
  );
  return {
    events: feed.events as unknown as readonly JsonObject[],
    msiRelated: feed.msiRelated as unknown as readonly JsonObject[],
  };
};

export const getEventDetail = async (eventId: string): Promise<JsonObject | undefined> => {
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

export const readRawEmail = async (eventId: string): Promise<string> => {
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

export const readSource = async (source: { bucket: string; key: string }, label: string): Promise<string> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
  if (!object.Body) throw new Error(`Raw source for ${label} did not contain a body`);
  return object.Body.transformToString();
};

export const toPublicEvent = (
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
