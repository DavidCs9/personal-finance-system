import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { eventMonthIndexKeys } from './event-month-index.js';

export type CaptureSource =
  | 'email'
  | 'apple_pay_shortcut'
  | 'santander_csv'
  | 'manual'
  | 'amex_statement'
  | 'santander_statement';

const isCaptureSource = (value: unknown): value is CaptureSource =>
  value === 'email'
  || value === 'apple_pay_shortcut'
  || value === 'santander_csv'
  || value === 'manual'
  || value === 'amex_statement'
  || value === 'santander_statement';

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
const SANTANDER_CSV_WINDOW_MS = 18 * 60 * 60 * 1000;
const SAME_SOURCE_RETRY_WINDOW_MS = 2 * 60 * 1000;
const FOREIGN_LOOKUP_WINDOW_MS = 30 * 60 * 60 * 1000;
const MIN_PLAUSIBLE_MXN_PER_USD = 10;
const MAX_PLAUSIBLE_MXN_PER_USD = 30;

export const normaliseMerchant = (merchant: string): string => merchant
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ')
  .trim();

const merchantsMatch = (left: string, right: string, allowTruncation: boolean): boolean => {
  const a = normaliseMerchant(left).replace(/\s+/g, '');
  const b = normaliseMerchant(right).replace(/\s+/g, '');
  return a === b || (allowTruncation && Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a)));
};

const FOREIGN_MERCHANT_STOP_WORDS = new Set(['THE', 'STORE', 'STORES', 'SHOP', 'SHOPS', 'TO', 'LAS', 'VEG', 'VEGAS']);

/**
 * Foreign authorizations and posted bank alerts frequently use different descriptors.
 * Require either the normal match or strong overlap of at least two meaningful tokens.
 */
export const foreignMerchantsMatch = (left: string, right: string): boolean => {
  if (merchantsMatch(left, right, true)) return true;
  const tokens = (value: string) => normaliseMerchant(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !FOREIGN_MERCHANT_STOP_WORDS.has(token));
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (a.size === 0 || b.size === 0) return false;
  const common = [...a].filter((token) => b.has(token)).length;
  return common >= 2 && common / Math.min(a.size, b.size) >= 2 / 3;
};

const accountLastFour = (account: unknown): string | undefined => {
  if (!account || typeof account !== 'object' || !('lastFour' in account)) return undefined;
  return typeof account.lastFour === 'string' ? account.lastFour : undefined;
};

const localCalendarDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Chihuahua',
  }).formatToParts(date);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : undefined;
};

const nearbyCalendarDates = (left: string | undefined, right: string | undefined): boolean => {
  if (!left || !right) return false;
  const leftDay = Date.parse(`${left}T12:00:00.000Z`);
  const rightDay = Date.parse(`${right}T12:00:00.000Z`);
  return Number.isFinite(leftDay)
    && Number.isFinite(rightDay)
    && Math.abs(leftDay - rightDay) <= 24 * 60 * 60 * 1000;
};

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
  readonly matchKind: 'exact' | 'foreign';
}

const findExactCandidates = async (input: SaveObservedEventInput): Promise<readonly Candidate[]> => {
  const center = Date.parse(input.reconciliationAt);
  if (!Number.isFinite(center)) throw new Error('Invalid reconciliation timestamp.');
  // CSV and manual entries often lack precise clock times, so automatic sources query a same-day window.
  const couldMatchDayLevel = input.captureSource === 'santander_csv'
    || input.captureSource === 'santander_statement'
    || input.captureSource === 'manual'
    || input.captureSource === 'email'
    || (input.captureSource === 'apple_pay_shortcut');
  const queryWindow = couldMatchDayLevel ? SANTANDER_CSV_WINDOW_MS : RECONCILIATION_WINDOW_MS;
  const from = new Date(center - queryWindow).toISOString();
  const to = new Date(center + queryWindow).toISOString();
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
  return (result.Items ?? []).flatMap((item) => {
    const payload = item.payload as Record<string, unknown> | undefined;
    if (!payload) return [];
    const eventId = typeof payload.id === 'string' ? payload.id : undefined;
    const reconciliationAt = typeof item.reconciliationAt === 'string' ? item.reconciliationAt : undefined;
    if (!eventId || !reconciliationAt) return [];
    const sources = Array.isArray(payload.captureSources)
      ? payload.captureSources.filter(isCaptureSource)
      : [];
    const involvesCsv = input.captureSource === 'santander_csv' || sources.includes('santander_csv');
    const involvesStatement = input.captureSource === 'santander_statement' || sources.includes('santander_statement');
    const involvesManual = input.captureSource === 'manual' || sources.includes('manual');
    const dayLevelMatch = involvesCsv || involvesStatement || involvesManual;
    if (!merchantsMatch(input.event.merchantRaw, String(payload.merchantRaw ?? ''), dayLevelMatch)) return [];
    if (!dayLevelMatch && Math.abs(Date.parse(reconciliationAt) - center) > RECONCILIATION_WINDOW_MS) return [];
    if (dayLevelMatch) {
      const inputDate = localCalendarDate(input.event.occurredAt ?? input.reconciliationAt);
      const candidateDate = localCalendarDate(payload.occurredAt ?? reconciliationAt);
      if (!inputDate || inputDate !== candidateDate) return [];
      const inputLastFour = accountLastFour(input.event.account);
      const candidateLastFour = accountLastFour(payload.account);
      if (inputLastFour && candidateLastFour && inputLastFour !== candidateLastFour) return [];
    }
    const primaryObservationId = typeof payload.primaryObservationId === 'string' ? payload.primaryObservationId : undefined;
    return [{ eventId, reconciliationAt, captureSources: sources, primaryObservationId, matchKind: 'exact' as const }];
  });
};

const moneyFrom = (value: unknown): { readonly amountMinor: number; readonly currency: string } | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const amountMinor = 'amountMinor' in value ? value.amountMinor : undefined;
  const currency = 'currency' in value ? value.currency : undefined;
  return typeof amountMinor === 'number' && typeof currency === 'string' ? { amountMinor, currency } : undefined;
};

const isPlausibleForeignPair = (
  inputAmount: ObservedEventInput['amount'],
  candidateAmount: ObservedEventInput['amount'],
): boolean => {
  const usd = inputAmount.currency === 'USD' ? inputAmount : candidateAmount.currency === 'USD' ? candidateAmount : undefined;
  const mxn = inputAmount.currency === 'MXN' ? inputAmount : candidateAmount.currency === 'MXN' ? candidateAmount : undefined;
  if (!usd || !mxn || usd.amountMinor <= 0) return false;
  const ratio = mxn.amountMinor / usd.amountMinor;
  return ratio >= MIN_PLAUSIBLE_MXN_PER_USD && ratio <= MAX_PLAUSIBLE_MXN_PER_USD;
};

const findForeignCandidates = async (input: SaveObservedEventInput): Promise<readonly Candidate[]> => {
  const incomingEmail = input.captureSource === 'email'
    && input.event.institution === 'santander_mx'
    && input.event.eventType === 'card_purchase'
    && input.event.amount.currency === 'MXN';
  const incomingApple = input.captureSource === 'apple_pay_shortcut'
    && input.event.institution === 'santander_mx'
    && input.event.eventType === 'card_purchase'
    && input.event.amount.currency === 'USD';
  if (!incomingEmail && !incomingApple) return [];

  const occurredAt = input.event.occurredAt;
  const center = occurredAt ? Date.parse(occurredAt) : Number.NaN;
  if (!Number.isFinite(center)) return [];
  const result = await input.database.send(new QueryCommand({
    TableName: input.tableName,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :partition AND GSI1SK BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':partition': 'EVENTS',
      ':from': new Date(center - FOREIGN_LOOKUP_WINDOW_MS).toISOString(),
      ':to': new Date(center + FOREIGN_LOOKUP_WINDOW_MS).toISOString(),
    },
    ConsistentRead: false,
  }));

  const inputDate = localCalendarDate(occurredAt);
  return (result.Items ?? []).flatMap((item) => {
    const payload = item.payload as Record<string, unknown> | undefined;
    if (!payload || payload.institution !== input.event.institution || payload.eventType !== input.event.eventType) return [];
    const eventId = typeof payload.id === 'string' ? payload.id : undefined;
    const reconciliationAt = typeof item.reconciliationAt === 'string' ? item.reconciliationAt : undefined;
    const candidateAmount = moneyFrom(payload.amount);
    if (!eventId || !reconciliationAt || !candidateAmount) return [];
    const sources = Array.isArray(payload.captureSources) ? payload.captureSources.filter(isCaptureSource) : [];
    const isPendingApple = sources.includes('apple_pay_shortcut')
      && candidateAmount.currency === 'USD'
      && payload.status === 'pending_foreign';
    const isPostedEmail = sources.includes('email')
      && candidateAmount.currency === 'MXN'
      && payload.status !== 'rejected'
      && payload.status !== 'pending_foreign';
    if ((incomingEmail && !isPendingApple) || (incomingApple && !isPostedEmail)) return [];
    // Vegas and Chihuahua can disagree on the calendar day during the last local hour.
    // The bounded lookup, merchant, FX sanity check, and uniqueness guard still all apply.
    if (!nearbyCalendarDates(inputDate, localCalendarDate(payload.occurredAt ?? reconciliationAt))) return [];
    if (!foreignMerchantsMatch(input.event.merchantRaw, String(payload.merchantRaw ?? ''))) return [];
    if (!isPlausibleForeignPair(input.event.amount, candidateAmount)) return [];
    const primaryObservationId = typeof payload.primaryObservationId === 'string' ? payload.primaryObservationId : undefined;
    return [{ eventId, reconciliationAt, captureSources: sources, primaryObservationId, matchKind: 'foreign' as const }];
  });
};

const findCandidates = async (input: SaveObservedEventInput): Promise<readonly Candidate[]> => {
  const exact = await findExactCandidates(input);
  return exact.length > 0 ? exact : findForeignCandidates(input);
};

const existingClaim = async (input: SaveObservedEventInput): Promise<SaveObservedEventResult | undefined> => {
  const result = await input.database.send(new GetCommand({
    TableName: input.tableName,
    Key: { PK: `DEDUPE#${input.dedupeKey}`, SK: 'CLAIM' },
    ConsistentRead: true,
  }));
  if (!result.Item) return undefined;
  if (!result.Item.eventId || !result.Item.observationId) throw new LegacyExceptionClaimError();
  return {
    eventId: String(result.Item.eventId),
    observationId: String(result.Item.observationId),
    duplicate: true,
    reconciled: Boolean(result.Item.reconciled),
    created: false,
  };
};

class LegacyExceptionClaimError extends Error {}

const removeLegacyExceptionClaim = async (input: SaveObservedEventInput): Promise<void> => {
  await input.database.send(new DeleteCommand({
    TableName: input.tableName,
    Key: { PK: `DEDUPE#${input.dedupeKey}`, SK: 'CLAIM' },
    ConditionExpression: 'attribute_not_exists(eventId) AND attribute_not_exists(observationId)',
  }));
};

const isTransactionCanceled = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TransactionCanceledException';

export const saveObservedEvent = async (input: SaveObservedEventInput, recoveredLegacyClaim = false): Promise<SaveObservedEventResult> => {
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
      try {
        const claim = await existingClaim(input);
        if (claim) return claim;
      } catch (claimError) {
        if (claimError instanceof LegacyExceptionClaimError && !recoveredLegacyClaim) {
          await removeLegacyExceptionClaim(input);
          return saveObservedEvent(input, true);
        }
        throw claimError;
      }
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

  const promotesForeignAuthorization = candidate?.matchKind === 'foreign'
    && input.captureSource === 'email'
    && input.event.amount.currency === 'MXN';
  const linkedUpdateExpression = promotesForeignAuthorization
    ? [
        'SET #payload.#count = if_not_exists(#payload.#count, :one) + :one',
        '#payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source)',
        '#payload.#reconciledAt = :reconciledAt',
        '#payload.#hasRawEmail = :true',
        '#payload.#amount = :postedAmount',
        '#payload.#status = :postedStatus',
        '#payload.#merchantRaw = :postedMerchant',
        ...(input.event.occurredAt ? ['#payload.#occurredAt = :postedOccurredAt'] : []),
        ...(input.event.account ? ['#payload.#account = :postedAccount'] : []),
        '#gsi2pk = :postedPartition',
        '#gsi2sk = :postedSort',
        '#topReconciliationAt = :sourceReconciliationAt',
      ].join(', ')
    : `SET #payload.#count = if_not_exists(#payload.#count, :one) + :one, #payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source), #payload.#reconciledAt = :reconciledAt${input.captureSource === 'email' ? ', #payload.#hasRawEmail = :true' : ''}`;
  const linkedExpressionNames = {
    '#payload': 'payload',
    '#count': 'observationCount',
    '#sources': 'captureSources',
    '#reconciledAt': 'reconciledAt',
    ...(input.captureSource === 'email' ? { '#hasRawEmail': 'hasRawEmail' } : {}),
    ...(promotesForeignAuthorization ? {
      '#amount': 'amount',
      '#status': 'status',
      '#merchantRaw': 'merchantRaw',
      ...(input.event.occurredAt ? { '#occurredAt': 'occurredAt' } : {}),
      ...(input.event.account ? { '#account': 'account' } : {}),
      '#gsi2pk': 'GSI2PK',
      '#gsi2sk': 'GSI2SK',
      '#topReconciliationAt': 'reconciliationAt',
    } : {}),
  };
  const linkedExpressionValues = {
    ':one': 1,
    ':empty': [],
    ':source': [input.captureSource],
    ':reconciledAt': input.event.ingestedAt,
    ...(input.captureSource === 'email' ? { ':true': true } : {}),
    ...(promotesForeignAuthorization ? {
      ':postedAmount': input.event.amount,
      ':postedStatus': input.event.status,
      ':postedMerchant': input.event.merchantRaw,
      ...(input.event.occurredAt ? { ':postedOccurredAt': input.event.occurredAt } : {}),
      ...(input.event.account ? { ':postedAccount': input.event.account } : {}),
      ':postedPartition': reconciliationPartition(input.event),
      ':postedSort': `${input.reconciliationAt}#${eventId}`,
      ':sourceReconciliationAt': input.reconciliationAt,
      ':pendingForeign': 'pending_foreign',
    } : {}),
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
          UpdateExpression: linkedUpdateExpression,
          ConditionExpression: promotesForeignAuthorization
            ? '#payload.#status = :pendingForeign'
            : 'attribute_exists(PK)',
          ExpressionAttributeNames: linkedExpressionNames,
          ExpressionAttributeValues: linkedExpressionValues,
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
            ...eventMonthIndexKeys({
              eventId,
              occurredAt: input.event.occurredAt,
              receivedAt: input.event.receivedAt,
            }),
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
    try {
      const existing = await existingClaim(input);
      if (existing) return existing;
    } catch (claimError) {
      if (claimError instanceof LegacyExceptionClaimError && !recoveredLegacyClaim) {
        await removeLegacyExceptionClaim(input);
        return saveObservedEvent(input, true);
      }
      throw claimError;
    }
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
