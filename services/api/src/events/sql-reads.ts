import { createPool } from '@finance/ledger/dsql-connection';
import type { JsonObject } from '../http/response.js';
import { candidateMonthsFor, feedFromPayloads, type EventFeed } from './month-feed.js';
import { toPublicEvent } from './public-event.js';

export interface ReadSqlClient { query(statement: string, values?: unknown[]): Promise<{ rows: JsonObject[] }> }
let pool: ReturnType<typeof createPool> | undefined;
export const readerPool = (): ReadSqlClient => pool ??= createPool('olbia_reader', {
  connectionTimeoutMillis: 1_500, queryTimeoutMillis: 3_000,
});

export const monthReadStatement = `SELECT m.payload FROM olbia.movements m
  WHERE m.spend_month=ANY($2::text[]) AND (m.spend_month=ANY($1::text[]) OR EXISTS (
    SELECT 1 FROM olbia.msi_installments i WHERE i.source_pk=m.source_pk AND i.source_sk=m.source_sk AND i.month=ANY($1::text[])))`;

export const readSqlFeed = async (months: readonly string[], client: ReadSqlClient = readerPool()): Promise<EventFeed> => {
  const requested = [...new Set(months)];
  if (!requested.length) return { events: [], msiRelated: [] };
  const result = await client.query(monthReadStatement, [requested, candidateMonthsFor(requested)]);
  return feedFromPayloads(requested, result.rows.map(row => row.payload as JsonObject));
};

export const readSqlDetail = async (eventId: string, client: ReadSqlClient = readerPool()): Promise<JsonObject | undefined> => {
  // One statement supplies a consistent SQL snapshot of the movement and its provenance.
  const result = await client.query(`SELECT source_sk,payload,'movement' AS kind FROM olbia.movements WHERE source_pk=$1 AND source_sk='EVENT'
    UNION ALL SELECT source_sk,payload,'revision' AS kind FROM olbia.movement_revisions WHERE source_pk=$1
    UNION ALL SELECT source_sk,payload,'observation' AS kind FROM olbia.movement_observations WHERE source_pk=$1
    ORDER BY source_sk DESC`, [`EVENT#${eventId}`]);
  const movement = result.rows.find(row => row.kind === 'movement')?.payload as JsonObject | undefined;
  if (!movement) return undefined;
  return toPublicEvent(movement,
    result.rows.filter(row => row.kind === 'revision').map(row => row.payload as JsonObject),
    result.rows.filter(row => row.kind === 'observation').map(row => row.payload as JsonObject));
};
