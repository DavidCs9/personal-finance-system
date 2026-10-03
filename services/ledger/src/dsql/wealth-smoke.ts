import { randomUUID } from 'node:crypto';
import { dayKeyInZone, FINANCE_TIME_ZONE, type WealthSnapshot, type CardLiabilitySnapshot } from '@finance/domain';
import type { SqlClient } from './projection.js';
import { toNativeAssetSnapshot, toNativeHolding } from './wealth-reads.js';
import { insertNativeAssetCapture, insertNativeLiabilityCapture, validateAssetHoldings } from './wealth-writes.js';

/** Caller guarantees complete rollback. Same primitive as actual manual and provider writers; no external IO. */
export const smokeNativeWealth = async (client: SqlClient, owner: string, cardId: string): Promise<void> => {
  if (!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows.length) throw new Error('Native wealth is not active');
  const capture = (await client.query(`SELECT c.*,c.day::text AS capture_day,
    (SELECT COALESCE(SUM(h.value_mxn_minor),0)::bigint FROM olbia.asset_holdings h WHERE h.capture_id=c.id) AS total_mxn_minor
    FROM olbia.asset_daily_captures d JOIN olbia.asset_captures c ON c.id=d.capture_id
    WHERE c.owner=$1 ORDER BY c.captured_at DESC,c.id LIMIT 1`, [owner])).rows[0];
  if (!capture) throw new Error('No native asset capture for smoke');
  const holdings = (await client.query('SELECT * FROM olbia.asset_holdings WHERE capture_id=$1 ORDER BY position', [capture.id])).rows.map(toNativeHolding);
  const original = toNativeAssetSnapshot(capture, holdings);
  const first = randomUUID(), second = randomUUID();
  await insertNativeAssetCapture(client, { id: first, owner, snapshot: original });
  await insertNativeAssetCapture(client, { id: second, owner, snapshot: original });
  const edge = (await client.query('SELECT replacement_capture_id FROM olbia.asset_capture_replacements WHERE previous_capture_id=$1', [first])).rows[0];
  if (edge?.replacement_capture_id !== second) throw new Error('Equal-time native wealth replacement failed');
  const signed = [{ id: 'verification-cash', symbol: 'USD', name: 'SQL verification', quantity: -0.12345678912345678,
    currency: 'USD', valueNativeMinor: -1, valueMxnMinor: -1 }];
  const signedId = randomUUID();
  const signedSnapshot: WealthSnapshot = { ...original, holdings: signed, totalMxnMinor: validateAssetHoldings(signed), fxRate: 17.123456789123456 };
  await insertNativeAssetCapture(client, { id: signedId, owner, snapshot: signedSnapshot });
  const saved = (await client.query('SELECT quantity,value_native_minor,value_mxn_minor FROM olbia.asset_holdings WHERE capture_id=$1', [signedId])).rows[0];
  if (Number(saved?.quantity) !== signed[0]!.quantity || Number(saved?.value_native_minor) !== -1 || Number(saved?.value_mxn_minor) !== -1)
    throw new Error('Native signed wealth precision failed');
  const emptyId = randomUUID();
  const empty = await insertNativeAssetCapture(client, { id: emptyId, owner, snapshot: { ...original, holdings: [], totalMxnMinor: 0 } });
  if (empty.totalMxnMinor !== 0 || (await client.query('SELECT capture_id FROM olbia.asset_holdings WHERE capture_id=$1', [emptyId])).rows.length)
    throw new Error('Empty native wealth capture failed');
  const at = new Date().toISOString(), day = dayKeyInZone(new Date(at), FINANCE_TIME_ZONE);
  const liability: CardLiabilitySnapshot = { cardId, day, capturedAt: at, source: 'manual', currency: 'MXN', totalMxnMinor: 1, evidence: original.evidence };
  const liabilityId = randomUUID(), zeroId = randomUUID();
  await insertNativeLiabilityCapture(client, { id: liabilityId, owner, snapshot: liability });
  await insertNativeLiabilityCapture(client, { id: zeroId, owner, snapshot: { ...liability, totalMxnMinor: 0 } });
  const current = (await client.query(`SELECT c.amount_mxn_minor,c.id FROM olbia.liability_daily_captures d
    JOIN olbia.liability_captures c ON c.id=d.capture_id WHERE d.card_id=$1 AND d.day=$2`, [cardId, day])).rows[0];
  if (current?.id !== zeroId || Number(current.amount_mxn_minor) !== 0) throw new Error('Native paid-zero liability failed');
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
};
