import {
  FONDO_AHORRO_ACCOUNT_ID, WEALTH_ACCOUNTS,
  type CardLiabilitySnapshot, type WealthAccountDefinition, type WealthAccountId, type WealthHolding, type WealthSnapshot,
} from '@finance/domain';
import { cardReadStatement, toNativeCardRecord } from '../cards/sql-reads.js';
import type { CardRecord } from '../cards/cards.js';
import type { JsonObject } from '../http/response.js';
import { readerPool, withLedgerReadSnapshot, type ReadSqlClient } from '../events/sql-reads.js';

export interface NativeWealthInputs {
  readonly accounts: readonly WealthAccountDefinition[];
  readonly snapshots: readonly WealthSnapshot[];
  readonly liabilitySnapshots: readonly CardLiabilitySnapshot[];
  readonly cards: readonly CardRecord[];
}
export type NativeWealthAudit = {
  readonly captureId: string; readonly replacedByCaptureId: string; readonly replacedAt: string;
} & ({ readonly kind: 'asset'; readonly snapshot: WealthSnapshot }
  | { readonly kind: 'liability'; readonly snapshot: CardLiabilitySnapshot });

const selectedAssetStatement = (selection: string) => `WITH selected AS (${selection}), valuations AS (
  SELECT h.capture_id,SUM(h.value_mxn_minor)::bigint AS total_mxn_minor
    FROM olbia.asset_holdings h JOIN selected c ON c.id=h.capture_id GROUP BY h.capture_id)
  SELECT c.*,c.day::text AS capture_day,COALESCE(v.total_mxn_minor,0)::bigint AS total_mxn_minor
    FROM selected c LEFT JOIN valuations v ON v.capture_id=c.id ORDER BY c.day,c.account_id,c.captured_at,c.id`;
export const nativeAssetReadStatement = selectedAssetStatement(`SELECT c.* FROM olbia.asset_daily_captures d
  JOIN olbia.asset_captures c ON c.id=d.capture_id WHERE c.owner=$1`);
export const nativeAssetAuditReadStatement = selectedAssetStatement(`SELECT c.*,r.replacement_capture_id,next.captured_at AS superseded_at
  FROM olbia.asset_capture_replacements r JOIN olbia.asset_captures c ON c.id=r.previous_capture_id
  JOIN olbia.asset_captures next ON next.id=r.replacement_capture_id WHERE c.owner=$1`);
export const nativeLiabilityReadStatement = `SELECT c.*,c.day::text AS capture_day
  FROM olbia.liability_daily_captures d JOIN olbia.liability_captures c ON c.id=d.capture_id
  WHERE c.owner=$1 ORDER BY c.day,c.card_id`;
export const nativeLiabilityAuditReadStatement = `SELECT c.*,c.day::text AS capture_day,r.replacement_capture_id,next.captured_at AS superseded_at
  FROM olbia.liability_capture_replacements r JOIN olbia.liability_captures c ON c.id=r.previous_capture_id
  JOIN olbia.liability_captures next ON next.id=r.replacement_capture_id
  WHERE c.owner=$1 ORDER BY c.day,c.card_id,c.captured_at,c.id`;
export const nativeHoldingReadStatement = `SELECT * FROM olbia.asset_holdings
  WHERE capture_id=ANY($1::uuid[]) ORDER BY capture_id,position`;
const invalid = (): never => { throw new Error('Invalid native wealth facts'); };
const minor = (value: unknown): number => {
  const amount = Number(value); return Number.isSafeInteger(amount) ? amount : invalid();
};
const finite = (value: unknown): number => {
  const amount = Number(value); return Number.isFinite(amount) ? amount : invalid();
};
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const evidence = (row: JsonObject): WealthSnapshot['evidence'] => ({ bucket: String(row.evidence_bucket), key: String(row.evidence_key),
  sha256: String(row.evidence_sha256), contentType: 'application/json' });
export const toNativeHolding = (row: JsonObject): WealthHolding => ({ id: String(row.id), symbol: String(row.symbol), name: String(row.name),
  quantity: finite(row.quantity), currency: String(row.currency), valueNativeMinor: minor(row.value_native_minor), valueMxnMinor: minor(row.value_mxn_minor) });
export const toNativeAssetSnapshot = (row: JsonObject, holdings: readonly WealthHolding[]): WealthSnapshot => ({
  accountId: row.account_id as WealthAccountId, day: String(row.capture_day), capturedAt: iso(row.captured_at),
  source: row.source as WealthSnapshot['source'], currency: 'MXN', totalMxnMinor: minor(row.total_mxn_minor), holdings, evidence: evidence(row),
  ...(row.fx_rate == null ? {} : { fxRate: finite(row.fx_rate) }), ...(row.fx_source == null ? {} : { fxSource: String(row.fx_source) }),
});
export const toNativeLiabilitySnapshot = (row: JsonObject): CardLiabilitySnapshot => ({ cardId: String(row.card_id), day: String(row.capture_day),
  capturedAt: iso(row.captured_at), source: 'manual', currency: 'MXN', totalMxnMinor: minor(row.amount_mxn_minor), evidence: evidence(row) });
const groupHoldings = async (client: ReadSqlClient, assets: readonly JsonObject[]): Promise<Map<string, WealthHolding[]>> => {
  const grouped = new Map<string, WealthHolding[]>();
  if (!assets.length) return grouped;
  const rows = (await client.query(nativeHoldingReadStatement, [assets.map(row => row.id)])).rows;
  for (const row of rows) {
    const id = String(row.capture_id), holdings = grouped.get(id) ?? [];
    if (Number(row.position) !== holdings.length) invalid();
    holdings.push(toNativeHolding(row)); grouped.set(id, holdings);
  }
  return grouped;
};

const readInputs = async (owner: string, client: ReadSqlClient): Promise<NativeWealthInputs> => {
  const [accounts, assets, liabilities, cards] = await Promise.all([
    client.query('SELECT * FROM olbia.asset_accounts ORDER BY position'), client.query(nativeAssetReadStatement, [owner]),
    client.query(nativeLiabilityReadStatement, [owner]), client.query(cardReadStatement, [owner]),
  ]);
  if (accounts.rows.length !== 3 || accounts.rows.some((row, index) => Number(row.position) !== index)) invalid();
  const holdings = await groupHoldings(client, assets.rows);
  const definitions: WealthAccountDefinition[] = accounts.rows.map(row => ({ id: row.id as WealthAccountId, name: String(row.name),
    institution: String(row.institution), role: row.role as WealthAccountDefinition['role'], sync: row.sync as WealthAccountDefinition['sync'] }));
  // Fondo has no persisted capture; its established display position and payroll-derived meaning stay intact.
  definitions.splice(1, 0, WEALTH_ACCOUNTS.find(account => account.id === FONDO_AHORRO_ACCOUNT_ID)!);
  return { accounts: definitions,
    snapshots: assets.rows.map(row => toNativeAssetSnapshot(row, holdings.get(String(row.id)) ?? []))
      .sort((a, b) => a.day.localeCompare(b.day) || a.accountId.localeCompare(b.accountId)),
    liabilitySnapshots: liabilities.rows.map(toNativeLiabilitySnapshot),
    cards: cards.rows.map(toNativeCardRecord).sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id)),
  };
};
const readAudit = async (owner: string, client: ReadSqlClient): Promise<readonly NativeWealthAudit[]> => {
  const [assets, liabilities] = await Promise.all([
    client.query(nativeAssetAuditReadStatement, [owner]), client.query(nativeLiabilityAuditReadStatement, [owner]),
  ]);
  const holdings = await groupHoldings(client, assets.rows);
  const relation = (row: JsonObject) => ({ captureId: String(row.id), replacedByCaptureId: String(row.replacement_capture_id), replacedAt: iso(row.superseded_at) });
  return [
    ...assets.rows.map(row => ({ ...relation(row), kind: 'asset' as const, snapshot: toNativeAssetSnapshot(row, holdings.get(String(row.id)) ?? []) })),
    ...liabilities.rows.map(row => ({ ...relation(row), kind: 'liability' as const, snapshot: toNativeLiabilitySnapshot(row) })),
  ].sort((a, b) => a.snapshot.capturedAt.localeCompare(b.snapshot.capturedAt) || a.captureId.localeCompare(b.captureId));
};
const available = async <T>(read: () => Promise<T>): Promise<T> => {
  try { return await read(); }
  catch (error) {
    if ((error as { code?: string }).code)
      throw Object.assign(new Error('Olbia storage is unavailable.'), { name: 'StorageUnavailableException' });
    throw error;
  }
};

/** Provider transaction snapshot, direct typed queries and no legacy authority/fallback. */
export const readNativeWealthInputs = (owner: string, client?: ReadSqlClient): Promise<NativeWealthInputs> => available(() =>
  client ? readInputs(owner, client) : withLedgerReadSnapshot(() => readInputs(owner, readerPool())));
export const readNativeWealthAudit = (owner: string, client?: ReadSqlClient): Promise<readonly NativeWealthAudit[]> => available(() =>
  client ? readAudit(owner, client) : withLedgerReadSnapshot(() => readAudit(owner, readerPool())));
