import { GetObjectCommand } from '@aws-sdk/client-s3';
import { readLedgerMovements } from '@finance/ledger/native-ledger';
import { s3 } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { readSqlFeed, readSqlDetail, readerPool } from './sql-reads.js';
export { toPublicEvent } from './public-event.js';

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

export const allStoredEvents = (): Promise<readonly JsonObject[]> => readLedgerMovements(readerPool());

export const listEventsForMonth = (month: string) => readSqlFeed([month]);
export const listEventsForMonths = (months: readonly string[]) => readSqlFeed(months);
export const getEventDetail = (eventId: string) => readSqlDetail(eventId);

export const readRawEmail = async (eventId: string): Promise<string> => {
  const detail = await getEventDetail(eventId);
  const observations = Array.isArray(detail?.observations) ? detail.observations as JsonObject[] : [];
  const sources = detail?.hasRawEmail === true
    ? [...(detail.captureSource === 'email' ? [detail.source] : []),
      ...observations.filter(observation => observation.captureSource === 'email').map(observation => observation.source)]
    : [detail?.source, ...observations.map(observation => observation.source)];
  const source = (sources as ({ bucket?: string; key?: string } | undefined)[]).find(candidate => candidate?.bucket && candidate.key);
  if (!source?.bucket || !source.key) throw new Error(`Missing raw source for event ${eventId}`);
  return readSource({ bucket: source.bucket, key: source.key }, `event ${eventId}`);
};

export const readSource = async (source: { bucket: string; key: string }, label: string): Promise<string> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
  if (!object.Body) throw new Error(`Raw source for ${label} did not contain a body`);
  return object.Body.transformToString();
};
