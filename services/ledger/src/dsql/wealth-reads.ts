import type { WealthSnapshot, WealthAccountId, WealthHolding, CardLiabilitySnapshot } from '@finance/domain';
const invalid = (): never => { throw new Error('Invalid native wealth facts'); };
const minor = (value: unknown): number => {
  const amount = Number(value); return Number.isSafeInteger(amount) ? amount : invalid();
};
const finite = (value: unknown): number => {
  const amount = Number(value); return Number.isFinite(amount) ? amount : invalid();
};
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const evidence = (row: Record<string, unknown>): WealthSnapshot['evidence'] => ({ bucket: String(row.evidence_bucket), key: String(row.evidence_key),
  sha256: String(row.evidence_sha256), contentType: 'application/json' });
export const toNativeHolding = (row: Record<string, unknown>): WealthHolding => ({ id: String(row.id), symbol: String(row.symbol), name: String(row.name),
  quantity: finite(row.quantity), currency: String(row.currency), valueNativeMinor: minor(row.value_native_minor), valueMxnMinor: minor(row.value_mxn_minor) });
export const toNativeAssetSnapshot = (row: Record<string, unknown>, holdings: readonly WealthHolding[]): WealthSnapshot => ({
  accountId: row.account_id as WealthAccountId, day: String(row.capture_day), capturedAt: iso(row.captured_at),
  source: row.source as WealthSnapshot['source'], currency: 'MXN', totalMxnMinor: minor(row.total_mxn_minor), holdings, evidence: evidence(row),
  ...(row.fx_rate == null ? {} : { fxRate: finite(row.fx_rate) }), ...(row.fx_source == null ? {} : { fxSource: String(row.fx_source) }),
});
export const toNativeLiabilitySnapshot = (row: Record<string, unknown>): CardLiabilitySnapshot => ({ cardId: String(row.card_id), day: String(row.capture_day),
  capturedAt: iso(row.captured_at), source: 'manual', currency: 'MXN', totalMxnMinor: minor(row.amount_mxn_minor), evidence: evidence(row) });
