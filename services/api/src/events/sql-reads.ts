import { currentSqlClient, withSqlClient } from '@finance/ledger/sql-runtime';
import { createPool } from '@finance/ledger/dsql-connection';
import type { JsonObject } from '../http/response.js';
import { feedFromMovements, type EventFeed } from './month-feed.js';
import { isLedgerMovementId, ledgerMovementReadStatement, readLedgerMovements, readLedgerDetail } from '@finance/ledger/native-ledger';
import { toPublicEvent } from './public-event.js';

export interface ReadSqlClient { query(statement: string, values?: unknown[]): Promise<{ rows: JsonObject[] }> }
let pool: ReturnType<typeof createPool> | undefined;
let verifierPool: ReturnType<typeof createPool> | undefined;
const nativeReaderPool = () => pool ??= createPool('olbia_reader', {
  connectionTimeoutMillis: 1_500, queryTimeoutMillis: 3_000,
});
export const readerPool = (): ReadSqlClient => currentSqlClient() ?? nativeReaderPool();

/** Provider-managed read snapshot; no write barrier, custom lock or manual retry. */
export const withLedgerReadSnapshot = <T>(callback: () => Promise<T>): Promise<T> =>
  currentSqlClient() ? callback() : nativeReaderPool().transaction(client => withSqlClient(client, callback));

/** The deployed verifier has a bounded read-only snapshot of the current native model. */
export const withLedgerVerificationSnapshot = <T>(callback: () => Promise<T>): Promise<T> => {
  if (currentSqlClient()) return callback();
  verifierPool ??= createPool('olbia_operational_verifier', { connectionTimeoutMillis: 1_500, queryTimeoutMillis: 3_000 });
  return verifierPool.transaction(client => withSqlClient(client, callback));
};

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
