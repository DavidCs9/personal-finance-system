import { currentStoreTransaction, withStoreClient } from '@finance/ledger/dsql-store';
import { createPool } from '@finance/ledger/dsql-connection';
import type { JsonObject } from '../http/response.js';
import { feedFromMovements, type EventFeed } from './month-feed.js';
import { isLedgerMovementId, ledgerMovementReadStatement, readLedgerMovements, readLedgerDetail } from '@finance/ledger/native-ledger';
import { toPublicEvent } from './public-event.js';

export interface ReadSqlClient { query(statement: string, values?: unknown[]): Promise<{ rows: JsonObject[] }> }
let pool: ReturnType<typeof createPool> | undefined;
const nativeReaderPool = () => pool ??= createPool('olbia_reader', {
  connectionTimeoutMillis: 1_500, queryTimeoutMillis: 3_000,
});
export const readerPool = (): ReadSqlClient => currentStoreTransaction() ?? nativeReaderPool();

/** Provider-managed read snapshot; no write barrier, custom lock or manual retry. */
export const withLedgerReadSnapshot = <T>(callback: () => Promise<T>): Promise<T> =>
  currentStoreTransaction() ? callback() : nativeReaderPool().transaction(client => withStoreClient(client, callback));

export const monthReadStatement = ledgerMovementReadStatement;

export const readSqlFeed = async (months: readonly string[], client?: ReadSqlClient): Promise<EventFeed> => {
  const requested = [...new Set(months)];
  if (!requested.length) return { events: [], msiRelated: [] };
  return feedFromMovements(requested, await readLedgerMovements(client ?? readerPool(), { months: requested }));
};

export const readSqlDetail = async (eventId: string, client?: ReadSqlClient): Promise<JsonObject | undefined> => {
  if (!isLedgerMovementId(eventId)) return undefined;
  const detail = await readLedgerDetail(client ?? readerPool(), eventId);
  return detail ? toPublicEvent(detail, detail.revisions as JsonObject[], detail.observations as JsonObject[]) : undefined;
};
