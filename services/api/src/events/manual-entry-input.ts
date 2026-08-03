import { createHash } from 'node:crypto';
import { normaliseMerchant } from '@finance/ledger';

export class InvalidManualEntryError extends Error {}

const INSTITUTIONS = ['american_express_mx', 'santander_mx', 'nu_mx', 'amazon_web_services'] as const;
export type ManualEntryInstitution = (typeof INSTITUTIONS)[number];

export interface ManualEntryInput {
  readonly institution: ManualEntryInstitution;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly currency: 'MXN';
  readonly occurredOn: string;
  readonly occurredAt: string;
  readonly accountLastFour?: string;
  readonly note?: string;
}

type JsonObject = Record<string, unknown>;

const isInstitution = (value: unknown): value is ManualEntryInstitution =>
  typeof value === 'string' && (INSTITUTIONS as readonly string[]).includes(value);

const requiredText = (body: JsonObject, key: string, maxLength: number): string => {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new InvalidManualEntryError(`${key} must be non-empty text with at most ${maxLength} characters.`);
  }
  return value.trim();
};

const parseOccurredOn = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidManualEntryError('occurredOn must use YYYY-MM-DD format.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    Number.isNaN(probe.getTime())
    || probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    throw new InvalidManualEntryError('occurredOn must be a valid calendar date.');
  }
  return value;
};

const parseAmountMinor = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new InvalidManualEntryError('amountMinor must be a positive integer in minor units.');
  }
  return value;
};

const parseLastFour = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}$/.test(value.trim())) {
    throw new InvalidManualEntryError('accountLastFour must be exactly four digits when provided.');
  }
  return value.trim();
};

const parseNote = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 500) {
    throw new InvalidManualEntryError('note must be text with at most 500 characters when provided.');
  }
  const note = value.trim();
  return note || undefined;
};

export const parseManualEntry = (rawBody: string | undefined): ManualEntryInput => {
  let body: JsonObject;
  try {
    const parsed = JSON.parse(rawBody ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as JsonObject;
  } catch {
    throw new InvalidManualEntryError('Request body must be a JSON object.');
  }
  if (!isInstitution(body.institution)) {
    throw new InvalidManualEntryError(`institution must be one of: ${INSTITUTIONS.join(', ')}.`);
  }
  if (body.currency !== undefined && body.currency !== 'MXN') {
    throw new InvalidManualEntryError('currency must be MXN when provided.');
  }
  const occurredOn = typeof body.occurredOn === 'string'
    ? parseOccurredOn(body.occurredOn)
    : undefined;
  let occurredAt: string;
  if (typeof body.occurredAt === 'string' && body.occurredAt.trim()) {
    const timestamp = Date.parse(body.occurredAt);
    if (!Number.isFinite(timestamp)) {
      throw new InvalidManualEntryError('occurredAt must be an ISO 8601 timestamp when provided.');
    }
    occurredAt = new Date(timestamp).toISOString();
  } else if (occurredOn) {
    occurredAt = `${occurredOn}T12:00:00.000Z`;
  } else {
    throw new InvalidManualEntryError('occurredOn (YYYY-MM-DD) is required.');
  }
  const resolvedOccurredOn = occurredOn ?? localCalendarDate(occurredAt);
  if (!resolvedOccurredOn) {
    throw new InvalidManualEntryError('occurredAt must resolve to a valid calendar date.');
  }
  return {
    institution: body.institution,
    merchantRaw: requiredText(body, 'merchantRaw', 200),
    amountMinor: parseAmountMinor(body.amountMinor),
    currency: 'MXN',
    occurredOn: resolvedOccurredOn,
    occurredAt,
    accountLastFour: parseLastFour(body.accountLastFour),
    note: parseNote(body.note),
  };
};

const localCalendarDate = (value: string): string | undefined => {
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

export const manualEntryFingerprint = (owner: string, input: ManualEntryInput): string => {
  const material = [
    owner,
    input.institution,
    input.occurredOn,
    String(input.amountMinor),
    normaliseMerchant(input.merchantRaw),
    input.accountLastFour ?? '',
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
};

export const manualEntrySourceKey = (owner: string, sha256: string): string =>
  `manual-entries/${owner}/${sha256}.json`;
