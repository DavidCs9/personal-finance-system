import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export type CaptureSource = 'email' | 'apple_pay_shortcut';

export interface ObservedEventInput {
  readonly id: string;
  readonly institution: string;
  readonly eventType: string;
  readonly status: string;
  readonly account?: Readonly<Record<string, unknown>>;
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly merchantRaw: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly ingestedAt: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly parserVersion: string;
  readonly parseWarnings: readonly string[];
  readonly [key: string]: unknown;
}

export interface SaveObservedEventInput {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly dedupeKey: string;
  readonly captureSource: CaptureSource;
  readonly event: ObservedEventInput;
  /** Timestamp with transaction-level precision. Email ingestion should use receipt time. */
  readonly reconciliationAt: string;
}

export interface SaveObservedEventResult {
  readonly eventId: string;
  readonly observationId: string;
  readonly duplicate: boolean;
  readonly reconciled: boolean;
  readonly created: boolean;
}

const RECONCILIATION_WINDOW_MS = 30 * 60 * 1000;
const SAME_SOURCE_RETRY_WINDOW_MS = 2 * 60 * 1000;

export const normaliseMerchant = (merchant: string): string => merchant
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ')
  .trim();

export const reconciliationPartition = (event: Pick<ObservedEventInput, 'institution' | 'eventType' | 'amount'>): string =>
  `RECON#${event.institution}#${event.eventType}#${event.amount.currency}#${event.amount.amountMinor}`;

const observationPayload = (
  eventId: string,
  observationId: string,
  captureSource: CaptureSource,
  event: ObservedEventInput,
  reconciliationAt: string,
) => ({
  id: observationId,
  eventId,
  captureSource,
  observedAt: event.receivedAt,
  reconciliationAt,
  institution: event.institution,
  eventType: event.eventType,
  account: event.account,
  amount: event.amount,
  merchantRaw: event.merchantRaw,
  occurredAt: event.occurredAt,
  source: event.source,
  parserVersion: event.parserVersion,
  parseWarnings: event.parseWarnings,
});

interface Candidate {
  readonly eventId: string;
  readonly reconciliationAt: string;
  readonly captureSources: readonly CaptureSource[];
  readonly primaryObservationId?: string;
}

const findCandidates = async (input: SaveObservedEventInput): Promise<readonly Candidate[]> => {
  const center = Date.parse(input.reconciliationAt);
  if (!Number.isFinite(center)) throw new Error('Invalid reconciliation timestamp.');
  const from = new Date(center - RECONCILIATION_WINDOW_MS).toISOString();
  const to = new Date(center + RECONCILIATION_WINDOW_MS).toISOString();
  const result = await input.database.send(new QueryCommand({
    TableName: input.tableName,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :partition AND GSI2SK BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':partition': reconciliationPartition(input.event),
      ':from': from,
      ':to': `${to}\uffff`,
    },
    ConsistentRead: false,
  }));
  const merchant = normaliseMerchant(input.event.merchantRaw);
  return (result.Items ?? []).flatMap((item) => {
    const payload = item.payload as Record<string, unknown> | undefined;
    if (!payload || normaliseMerchant(String(payload.merchantRaw ?? '')) !== merchant) return [];
    const eventId = typeof payload.id === 'string' ? payload.id : undefined;
    const reconciliationAt = typeof item.reconciliationAt === 'string' ? item.reconciliationAt : undefined;
    if (!eventId || !reconciliationAt) return [];
    const sources = Array.isArray(payload.captureSources)
      ? payload.captureSources.filter((value): value is CaptureSource => value === 'email' || value === 'apple_pay_shortcut')
      : [];
    const primaryObservationId = typeof payload.primaryObservationId === 'string' ? payload.primaryObservationId : undefined;
    return [{ eventId, reconciliationAt, captureSources: sources, primaryObservationId }];
  });
};

const existingClaim = async (input: SaveObservedEventInput): Promise<SaveObservedEventResult | undefined> => {
  const result = await input.database.send(new GetCommand({
    TableName: input.tableName,
    Key: { PK: `DEDUPE#${input.dedupeKey}`, SK: 'CLAIM' },
    ConsistentRead: true,
  }));
  if (!result.Item) return undefined;
  return {
    eventId: String(result.Item.eventId),
    observationId: String(result.Item.observationId),
    duplicate: true,
    reconciled: Boolean(result.Item.reconciled),
    created: false,
  };
};

const isTransactionCanceled = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TransactionCanceledException';

export const saveObservedEvent = async (input: SaveObservedEventInput): Promise<SaveObservedEventResult> => {
  const candidates = await findCandidates(input);
  const center = Date.parse(input.reconciliationAt);
  const sameSourceRetry = candidates.find((candidate) =>
    candidate.captureSources.includes(input.captureSource)
    && candidate.primaryObservationId
    && Math.abs(Date.parse(candidate.reconciliationAt) - center) <= SAME_SOURCE_RETRY_WINDOW_MS);
  if (sameSourceRetry) {
    const observationId = sameSourceRetry.primaryObservationId as string;
    try {
      await input.database.send(new TransactWriteCommand({ TransactItems: [{ Put: {
        TableName: input.tableName,
        Item: {
          PK: `DEDUPE#${input.dedupeKey}`,
          SK: 'CLAIM',
          entityType: 'source_dedupe_claim',
          eventId: sameSourceRetry.eventId,
          observationId,
          reconciled: sameSourceRetry.captureSources.length > 1,
          createdAt: input.event.ingestedAt,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } }] }));
      return {
        eventId: sameSourceRetry.eventId,
        observationId,
        duplicate: true,
        reconciled: sameSourceRetry.captureSources.length > 1,
        created: false,
      };
    } catch (error) {
      if (!isTransactionCanceled(error)) throw error;
      const claim = await existingClaim(input);
      if (claim) return claim;
      throw error;
    }
  }

  const crossSourceCandidates = candidates.filter((candidate) => !candidate.captureSources.includes(input.captureSource));
  const candidate = crossSourceCandidates.length === 1 ? crossSourceCandidates[0] : undefined;
  const eventId = candidate?.eventId ?? input.event.id;
  const observationId = randomUUID();
  const observation = observationPayload(eventId, observationId, input.captureSource, input.event, input.reconciliationAt);
  const claim = {
    PK: `DEDUPE#${input.dedupeKey}`,
    SK: 'CLAIM',
    entityType: 'source_dedupe_claim',
    eventId,
    observationId,
    reconciled: Boolean(candidate),
    createdAt: input.event.ingestedAt,
  };

  const transactItems = candidate
    ? [
        { Put: {
          TableName: input.tableName,
          Item: claim,
          ConditionExpression: 'attribute_not_exists(PK)',
        } },
        { Put: {
          TableName: input.tableName,
          Item: {
            PK: `EVENT#${eventId}`,
            SK: `OBSERVATION#${input.reconciliationAt}#${observationId}`,
            entityType: 'event_observation',
            payload: observation,
          },
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        } },
        { Update: {
          TableName: input.tableName,
          Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
          UpdateExpression: `SET #payload.#count = if_not_exists(#payload.#count, :one) + :one, #payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source), #payload.#reconciledAt = :reconciledAt${input.captureSource === 'email' ? ', #payload.#hasRawEmail = :true' : ''}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: {
            '#payload': 'payload',
            '#count': 'observationCount',
            '#sources': 'captureSources',
            '#reconciledAt': 'reconciledAt',
            ...(input.captureSource === 'email' ? { '#hasRawEmail': 'hasRawEmail' } : {}),
          },
          ExpressionAttributeValues: {
            ':one': 1,
            ':empty': [],
            ':source': [input.captureSource],
            ':reconciledAt': input.event.ingestedAt,
            ...(input.captureSource === 'email' ? { ':true': true } : {}),
          },
        } },
      ]
    : [
        { Put: {
          TableName: input.tableName,
          Item: claim,
          ConditionExpression: 'attribute_not_exists(PK)',
        } },
        { Put: {
          TableName: input.tableName,
          Item: {
            PK: `EVENT#${eventId}`,
            SK: 'EVENT',
            GSI1PK: 'EVENTS',
            GSI1SK: input.event.receivedAt,
            GSI2PK: reconciliationPartition(input.event),
            GSI2SK: `${input.reconciliationAt}#${eventId}`,
            reconciliationAt: input.reconciliationAt,
            entityType: 'observed_purchase',
            payload: {
              ...input.event,
              captureSource: input.captureSource,
              captureSources: [input.captureSource],
              observationCount: 1,
              primaryObservationId: observationId,
              hasRawEmail: input.captureSource === 'email',
            },
          },
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        } },
        { Put: {
          TableName: input.tableName,
          Item: {
            PK: `EVENT#${eventId}`,
            SK: `OBSERVATION#${input.reconciliationAt}#${observationId}`,
            entityType: 'event_observation',
            payload: observation,
          },
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        } },
      ];

  try {
    await input.database.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    if (!isTransactionCanceled(error)) throw error;
    const existing = await existingClaim(input);
    if (existing) return existing;
    throw error;
  }
  return {
    eventId,
    observationId,
    duplicate: false,
    reconciled: Boolean(candidate),
    created: !candidate,
  };
};
