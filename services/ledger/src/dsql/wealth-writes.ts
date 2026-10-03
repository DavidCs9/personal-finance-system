import { type CardLiabilitySnapshot, type WealthHolding, type WealthSnapshot } from '@finance/domain';
import type { SqlClient } from './projection.js';
import { toNativeAssetSnapshot } from './wealth-reads.js';

export class InvalidWealthSnapshotError extends Error {}

const invalid = (message: string): never => { throw new InvalidWealthSnapshotError(message); };
const safeMoney = (value: number): boolean => Number.isSafeInteger(value);

/** Validate before uploading evidence; never round provider quantities or integer money. */
export const validateAssetHoldings = (holdings: readonly WealthHolding[]): number => {
  // Header, daily pointer, optional replacement and the shared barrier consume four mutations.
  if (holdings.length > 2_996) invalid('The capture exceeds the native transaction limit.');
  const identities = new Set<string>();
  let total = 0n;
  for (const holding of holdings) {
    if (!holding.id || identities.has(holding.id) || !holding.symbol || typeof holding.name !== 'string' || !holding.currency
      || !Number.isFinite(holding.quantity) || !safeMoney(holding.valueNativeMinor) || !safeMoney(holding.valueMxnMinor))
      invalid('Invalid wealth holding facts.');
    identities.add(holding.id); total += BigInt(holding.valueMxnMinor);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) invalid('Wealth total exceeds safe integer money.');
  if (Buffer.byteLength(JSON.stringify(holdings)) > 8 * 1024 * 1024) invalid('The capture exceeds the native transaction size.');
  return Number(total);
};

const advanceDailyCapture = async (client: SqlClient, kind: 'asset' | 'liability', identity: string, day: string, id: string, owner: string): Promise<void> => {
  const column = kind === 'asset' ? 'account_id' : 'card_id';
  const previous = (await client.query(`SELECT c.id,c.owner FROM olbia.${kind}_daily_captures d
    JOIN olbia.${kind}_captures c ON c.id=d.capture_id WHERE d.${column}=$1 AND d.day=$2`, [identity, day])).rows[0];
  if (previous && previous.owner !== owner) invalid('Capture not found.');
  if (previous) await client.query(`INSERT INTO olbia.${kind}_capture_replacements
    (${column},day,previous_capture_id,replacement_capture_id) VALUES ($1,$2,$3,$4)`, [identity, day, previous.id, id]);
  await client.query(`INSERT INTO olbia.${kind}_daily_captures (${column},day,capture_id) VALUES ($1,$2,$3)
    ON CONFLICT (${column},day) DO UPDATE SET capture_id=EXCLUDED.capture_id`, [identity, day, id]);
};

/** Caller supplies one native transaction and an identity allocated before connector retries. */
export const insertNativeAssetCapture = async (client: SqlClient, input: {
  readonly id: string; readonly owner: string; readonly snapshot: WealthSnapshot;
}): Promise<WealthSnapshot> => {
  const s = input.snapshot, evidence = s.evidence ?? invalid('A stored capture requires original evidence.');
  await client.query(`INSERT INTO olbia.asset_captures
    (id,account_id,owner,day,captured_at,source,fx_rate,fx_source,evidence_bucket,evidence_key,evidence_sha256,evidence_content_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [input.id, s.accountId, input.owner, s.day, s.capturedAt, s.source,
    s.fxRate ?? null, s.fxSource ?? null, evidence.bucket, evidence.key, evidence.sha256, evidence.contentType]);
  for (let start = 0; start < s.holdings.length; start += 50) {
    const values: unknown[] = [];
    const placeholders = s.holdings.slice(start, start + 50).map((h, offset) => {
      const row = [input.id, start + offset, h.id, h.symbol, h.name, h.quantity, h.currency, h.valueNativeMinor, h.valueMxnMinor];
      const result = `(${row.map((_, i) => `$${values.length + i + 1}`).join(',')})`; values.push(...row); return result;
    });
    await client.query(`INSERT INTO olbia.asset_holdings
      (capture_id,position,id,symbol,name,quantity,currency,value_native_minor,value_mxn_minor) VALUES ${placeholders.join(',')}`, values);
  }
  await advanceDailyCapture(client, 'asset', s.accountId, s.day, input.id, input.owner);
  const row = (await client.query(`SELECT c.*,c.day::text AS capture_day,
    (SELECT COALESCE(SUM(h.value_mxn_minor),0)::bigint FROM olbia.asset_holdings h WHERE h.capture_id=c.id) AS total_mxn_minor
    FROM olbia.asset_captures c WHERE c.id=$1`, [input.id])).rows[0];
  if (!row || Number(row.total_mxn_minor) !== s.totalMxnMinor) invalid('Native wealth total does not match captured holdings.');
  return toNativeAssetSnapshot(row, s.holdings);
};

export const insertNativeLiabilityCapture = async (client: SqlClient, input: {
  readonly id: string; readonly owner: string; readonly snapshot: CardLiabilitySnapshot;
}): Promise<CardLiabilitySnapshot> => {
  const s = input.snapshot, evidence = s.evidence ?? invalid('A stored capture requires original evidence.');
  if (!(await client.query('SELECT id FROM olbia.card_profiles WHERE id=$1 AND owner=$2 AND deleted_at IS NULL', [s.cardId, input.owner])).rows.length)
    invalid('Card not found. Add the card under Fechas de corte first.');
  await client.query(`INSERT INTO olbia.liability_captures
    (id,card_id,owner,day,captured_at,amount_mxn_minor,evidence_bucket,evidence_key,evidence_sha256,evidence_content_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.id, s.cardId, input.owner, s.day, s.capturedAt,
    s.totalMxnMinor, evidence.bucket, evidence.key, evidence.sha256, evidence.contentType]);
  await advanceDailyCapture(client, 'liability', s.cardId, s.day, input.id, input.owner);
  return s;
};
