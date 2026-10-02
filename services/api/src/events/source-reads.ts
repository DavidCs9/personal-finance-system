import { assertLegacyLedgerReadAvailable } from './legacy-read-guard.js';
import { paginateQuery, paginateScan } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { feedFromPayloads, type EventFeed } from './month-feed.js';
import { toPublicEvent } from './public-event.js';

/** Temporary cross-engine freshness guard; strong base-table reads include new/moved/deleted items missed by GSIs. */
export const readCurrentMovementPayloads = async (): Promise<JsonObject[]> => {
  await assertLegacyLedgerReadAvailable();
  const payloads: JsonObject[] = [];
  for await (const page of paginateScan({ client: database }, {
    TableName: tableName, ConsistentRead: true,
    FilterExpression: 'begins_with(PK,:prefix) AND SK=:event',
    ProjectionExpression: 'payload', ExpressionAttributeValues: { ':prefix': 'EVENT#', ':event': 'EVENT' },
  })) for (const item of page.Items ?? []) if (item.payload) payloads.push(item.payload as JsonObject);
  return payloads;
};
export const readSourceFeed = async (months: readonly string[]): Promise<EventFeed> =>
  feedFromPayloads(months, await readCurrentMovementPayloads());

export const readSourceDetail = async (eventId: string): Promise<JsonObject | undefined> => {
  await assertLegacyLedgerReadAvailable();
  const items: JsonObject[] = [];
  for await (const page of paginateQuery({ client: database }, {
    TableName: tableName, ConsistentRead: true, ScanIndexForward: false,
    KeyConditionExpression: 'PK=:pk', ExpressionAttributeValues: { ':pk': `EVENT#${eventId}` },
  })) items.push(...page.Items ?? []);
  const movement = items.find(item => item.SK === 'EVENT')?.payload as JsonObject | undefined;
  if (!movement) return undefined;
  return toPublicEvent(movement,
    items.filter(item => String(item.SK).startsWith('REVISION#')).map(item => item.payload as JsonObject),
    items.filter(item => String(item.SK).startsWith('OBSERVATION#')).map(item => item.payload as JsonObject));
};
