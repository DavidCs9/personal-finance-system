import { randomUUID } from 'node:crypto';
import { dayKeyInZone, WEALTH_ACCOUNTS } from '@finance/domain';
import { canonicalJson, projectRows, TABLE_COLUMNS } from './model.js';
import type { SourceItem } from './model.js';
import type { SqlClient, TransactionPool } from './projection.js';
import { NATIVE_WEALTH_TABLES } from './wealth-schema.js';

type Row = Record<string, unknown>;
type Table = typeof NATIVE_WEALTH_TABLES[number];
export interface RetainedWealth {
  readonly assets: readonly Row[];
  readonly assetVersions: readonly Row[];
  readonly liabilities: readonly Row[];
  readonly liabilityVersions: readonly Row[];
  readonly cards: readonly Row[];
}
export interface WealthCopy {
  readonly rows: Record<Table, Row[]>;
  readonly mutationCount: number;
}
const invalid = (): never => { throw new Error('Retained wealth mapping is inconsistent'); };
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : invalid();
const text = (value: unknown): string => typeof value === 'string' ? value : invalid();
const known = (row: Row, fields: readonly string[]) => { if (Object.keys(row).some(k => !fields.includes(k))) invalid(); };
const nullable = (value: unknown) => value === undefined ? null : value;
const iso = (value: unknown): string => { const date = new Date(text(value)); return Number.isFinite(date.getTime()) ? date.toISOString() : invalid(); };
const uuid = (value: unknown): string => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text(value)) ? text(value) : invalid();
const sourceFields = ['PK', 'SK', 'entityType', 'owner', 'accountId', 'cardId', 'day', 'capturedAt', 'source', 'currency',
  'totalMxnMinor', 'holdings', 'evidence', 'fxRate', 'fxSource', 'versionId', 'supersededAt'];
const identity = (kind: string, id: unknown, day: unknown, at: unknown) => JSON.stringify([kind, id, day, at]);

/** Compatibility decoding is confined to this one-time conversion, never runtime wealth operations. */
export const prepareWealthCopy = (input: RetainedWealth, allocateId: () => string = randomUUID): WealthCopy => {
  const rows = Object.fromEntries(NATIVE_WEALTH_TABLES.map(table => [table, []])) as unknown as Record<Table, Row[]>;
  rows.asset_accounts = WEALTH_ACCOUNTS.filter(a => a.sync !== 'derived').map((account, position) => ({ ...account, position }));
  const originals: { kind: 'asset' | 'liability'; version: boolean; source: Row; id: string }[] = [];
  const captureIds = new Map<string, string>(), ids = new Set<string>(), owners = new Set<string>();
  for (const [table, group, kind, version] of [
    ['wealth_snapshots', input.assets, 'asset', false], ['wealth_versions', input.assetVersions, 'asset', true],
    ['liability_snapshots', input.liabilities, 'liability', false], ['liability_versions', input.liabilityVersions, 'liability', true],
  ] as const) {
    for (const retained of group) {
      const p = object(retained.source_item); known(p, sourceFields);
      const projected = projectRows({ PK: text(p.PK), SK: text(p.SK) }, p as SourceItem);
      if (projected.length !== 1 || projected[0].table !== table) invalid();
      const normalize = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([column, value]) => {
        const type = (TABLE_COLUMNS[table] as Record<string, string>)[column];
        return [column, value == null ? value : type === 'bigint' ? String(value)
          : type === 'timestamptz' ? new Date(value as string | Date).toISOString()
          : type === 'date' ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : value];
      }));
      if (canonicalJson(normalize(projected[0].values)) !== canonicalJson(normalize(retained))) invalid();
      const accountId = text(kind === 'asset' ? p.accountId : p.cardId);
      const owner = text(p.owner); owners.add(owner);
      const day = text(p.day), capturedAt = iso(p.capturedAt);
      if (day !== dayKeyInZone(new Date(capturedAt)) || p.currency !== 'MXN') invalid();
      if (kind === 'liability' && (p.source !== 'manual' || !input.cards.some(c => c.id === accountId && c.owner === owner))) invalid();
      if (kind === 'asset' && (!rows.asset_accounts.some(a => a.id === accountId) || !['manual', 'api', 'flex'].includes(text(p.source)))) invalid();
      const id = version ? uuid(p.versionId) : uuid(allocateId());
      const key = identity(kind, accountId, day, capturedAt);
      if (captureIds.has(key) || ids.has(id)) invalid(); captureIds.set(key, id); ids.add(id);
      const e = object(p.evidence); known(e, ['bucket', 'key', 'sha256', 'contentType']);
      if (!text(e.bucket) || !text(e.key) || !/^[a-f0-9]{64}$/.test(text(e.sha256)) || e.contentType !== 'application/json') invalid();
      const capture: Row = { id, [kind === 'asset' ? 'account_id' : 'card_id']: accountId, owner, day, captured_at: capturedAt,
        ...(kind === 'asset' ? { source: p.source, fx_rate: nullable(p.fxRate), fx_source: nullable(p.fxSource) } : { amount_mxn_minor: p.totalMxnMinor }),
        evidence_bucket: e.bucket, evidence_key: e.key, evidence_sha256: e.sha256, evidence_content_type: e.contentType };
      if (!Number.isSafeInteger(p.totalMxnMinor) || kind === 'liability' && Number(p.totalMxnMinor) < 0) invalid();
      if (kind === 'asset') {
        if (p.fxRate !== undefined && (typeof p.fxRate !== 'number' || !Number.isFinite(p.fxRate) || p.fxRate <= 0)) invalid();
        if (p.fxSource !== undefined && typeof p.fxSource !== 'string') invalid();
        const holdings: unknown[] = Array.isArray(p.holdings) ? p.holdings : invalid();
        const holdingIds = new Set<string>(); let total = 0n;
        holdings.forEach((value, position) => {
          const h = object(value); known(h, ['id', 'symbol', 'name', 'quantity', 'currency', 'valueNativeMinor', 'valueMxnMinor']);
          if (holdingIds.has(text(h.id)) || !text(h.id) || !text(h.symbol) || !text(h.currency)) invalid(); holdingIds.add(text(h.id));
          if (typeof h.quantity !== 'number' || !Number.isFinite(h.quantity) || !Number.isSafeInteger(h.valueNativeMinor) || !Number.isSafeInteger(h.valueMxnMinor)) invalid();
          total += BigInt(h.valueMxnMinor as number);
          rows.asset_holdings.push({ capture_id: id, position, id: h.id, symbol: h.symbol, name: text(h.name), quantity: h.quantity,
            currency: h.currency, value_native_minor: h.valueNativeMinor, value_mxn_minor: h.valueMxnMinor });
        });
        if (total !== BigInt(p.totalMxnMinor as number)) invalid();
      }
      rows[kind === 'asset' ? 'asset_captures' : 'liability_captures'].push(capture);
      if (!version) rows[kind === 'asset' ? 'asset_daily_captures' : 'liability_daily_captures']
        .push({ [kind === 'asset' ? 'account_id' : 'card_id']: accountId, day, capture_id: id });
      originals.push({ kind, version, source: p, id });
    }
  }
  if (owners.size > 1) invalid();
  const successors = new Set<string>();
  for (const original of originals.filter(o => o.version)) {
    const p = original.source, at = iso(p.supersededAt), key = identity(original.kind, p.accountId ?? p.cardId, p.day, at);
    const next = captureIds.get(key) ?? invalid();
    if (next === original.id || successors.has(next)) invalid(); successors.add(next);
    rows[original.kind === 'asset' ? 'asset_capture_replacements' : 'liability_capture_replacements'].push({
      [original.kind === 'asset' ? 'account_id' : 'card_id']: p.accountId ?? p.cardId, day: p.day,
      previous_capture_id: original.id, replacement_capture_id: next,
    });
  }
  const mutationCount = Object.values(rows).reduce((sum, group) => sum + group.length, 2);
  if (mutationCount > 3000 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 8 * 1024 * 1024) invalid();
  return { rows, mutationCount };
};

export const readRetainedWealth = async (client: SqlClient): Promise<RetainedWealth> => ({
  assets: (await client.query('SELECT * FROM olbia.wealth_snapshots')).rows,
  assetVersions: (await client.query('SELECT * FROM olbia.wealth_versions')).rows,
  liabilities: (await client.query('SELECT * FROM olbia.liability_snapshots')).rows,
  liabilityVersions: (await client.query('SELECT * FROM olbia.liability_versions')).rows,
  cards: (await client.query('SELECT id,owner FROM olbia.card_profiles')).rows,
});

/** DDL/grants and the deployed older-bundle guard must precede this atomic activation. */
export const migrateWealth = async (pool: TransactionPool): Promise<void> => {
  await pool.transaction(async client => {
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows.length) return;
    if ((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode !== 'sql' ||
      (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows.length !== 1) invalid();
    for (const table of NATIVE_WEALTH_TABLES) if ((await client.query(`SELECT 1 FROM olbia.${table} LIMIT 1`)).rows.length) invalid();
    const copy = prepareWealthCopy(await readRetainedWealth(client));
    for (const table of NATIVE_WEALTH_TABLES) {
      const group = copy.rows[table];
      for (let offset = 0; offset < group.length; offset += 50) {
        const batch = group.slice(offset, offset + 50), columns = Object.keys(batch[0]), values: unknown[] = [];
        const tuples = batch.map(row => {
          if (canonicalJson(columns) !== canonicalJson(Object.keys(row))) invalid();
          return `(${columns.map(column => { const value = row[column]; values.push(value && typeof value === 'object' ? JSON.stringify(value) : value); return `$${values.length}`; }).join(',')})`;
        });
        await client.query(`INSERT INTO olbia.${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
      }
    }
    await client.query('INSERT INTO olbia.schema_migrations VALUES (15,CURRENT_TIMESTAMP)');
  });
};
