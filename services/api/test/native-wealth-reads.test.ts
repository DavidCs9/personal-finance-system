import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../../ledger/src/dsql/connection.js';
import { SCHEMA_STATEMENTS } from '../../ledger/test/helpers/migration-schema.js';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS, NATIVE_WEALTH_TABLES } from '../../ledger/src/dsql/wealth-schema.js';
import { projectRows, type SourceItem } from '../../ledger/src/dsql/model.js';
import { migrateWealth } from '../../ledger/src/dsql/wealth-copy.js';
import { currentSqlClient, withSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import { readNativeWealthInputs, readNativeWealthAudit } from '../src/wealth/native-reads.js';

let sql: PGlite;
const day = '2026-10-02', before = `${day}T12:00:00.000Z`, after = `${day}T12:00:00.001Z`;
const versionId = '10000000-0000-4000-8000-000000000001';
const priorLiabilityId = '10000000-0000-4000-8000-000000000002';
const evi = (key: string) => ({ bucket: 'test-evidence', key, sha256: '1'.repeat(64), contentType: 'application/json' });
const holdings = (prior = false) => [{ id: 'cash', symbol: 'USD', name: 'Cash', quantity: -0.12345678912345678,
  currency: 'USD', valueNativeMinor: -100, valueMxnMinor: prior ? -100 : 200 }];
const asset = (prior = false): SourceItem => ({ PK: 'USER#owner',
  SK: prior ? `WEALTH_VER#ibkr#${day}#${before}` : `WEALTH_SNAP#ibkr#${day}`,
  owner: 'owner', accountId: 'ibkr', day, capturedAt: prior ? before : after, source: 'flex', currency: 'MXN',
  totalMxnMinor: prior ? -100 : 200, holdings: holdings(prior), fxRate: 17.123456789123456,
  fxSource: 'banxico_sf43718', evidence: evi(prior ? 'prior-asset' : 'current-asset'),
  ...(prior ? { versionId, supersededAt: after } : {}) });
const liability = (prior = false): SourceItem => ({ PK: 'USER#owner',
  SK: prior ? `LIAB_VER#amex#${day}#${before}` : `LIAB_SNAP#amex#${day}`,
  owner: 'owner', cardId: 'amex', day, capturedAt: prior ? before : after, source: 'manual', currency: 'MXN',
  totalMxnMinor: prior ? 100 : 0, evidence: evi(prior ? 'prior-liability' : 'current-liability'),
  ...(prior ? { versionId: priorLiabilityId, supersededAt: after } : {}) });
const seed = async () => {
  for (const item of [asset(), asset(true), liability(), liability(true)]) {
    for (const row of projectRows({ PK: item.PK, SK: item.SK }, item)) {
      const columns = Object.keys(row.values);
      await sql.query(`INSERT INTO olbia.${row.table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
        columns.map(c => { const v = row.values[c]; return v && typeof v === 'object' ? JSON.stringify(v) : v; }));
    }
  }
  await migrateWealth({ transaction: fn => sql.transaction(c => fn(c as unknown as SqlClient)) });
};
beforeAll(async () => {
  sql = new PGlite(); for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_WEALTH_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query("INSERT INTO olbia.card_profiles VALUES ('amex','owner','Amex',25,15,'american_express_mx',$1,$1,NULL)", [before]);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
}, 30_000);
afterAll(() => sql.close());
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${[...NATIVE_WEALTH_TABLES, 'wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions'].map(t => `olbia.${t}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=15');
  await sql.query("UPDATE olbia.card_profiles SET deleted_at=NULL");
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(new Error('Unexpected document read'));
});

describe('typed native Patrimonio reads', () => {
  it('reads canonical captures and exact prior relationships without envelopes, keeping signed/fractional facts and paid zero', async () => {
    await seed();
    const inputs = await readNativeWealthInputs('owner', sql);
    expect(inputs.accounts.map(a => a.id)).toEqual(['nu_cajita_emergencia', 'fondo_ahorro', 'bitso', 'ibkr']);
    expect(inputs.snapshots).toEqual([{ accountId: 'ibkr', day, capturedAt: after, source: 'flex', currency: 'MXN',
      totalMxnMinor: 200, holdings: holdings(), fxRate: 17.123456789123456, fxSource: 'banxico_sf43718', evidence: evi('current-asset') }]);
    expect(inputs.liabilitySnapshots).toEqual([{ cardId: 'amex', day, capturedAt: after, source: 'manual', currency: 'MXN', totalMxnMinor: 0, evidence: evi('current-liability') }]);
    const audit = await readNativeWealthAudit('owner', sql);
    expect(audit).toHaveLength(2);
    expect(audit.find(a => a.kind === 'asset')).toMatchObject({ captureId: versionId, replacedAt: after,
      snapshot: { capturedAt: before, totalMxnMinor: -100, holdings: holdings(true), evidence: evi('prior-asset') } });
    expect(audit.find(a => a.kind === 'liability')).toMatchObject({ captureId: priorLiabilityId, replacedAt: after,
      snapshot: { capturedAt: before, totalMxnMinor: 100 } });
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });
  it('uses the native catalog, filters capture access and active cards, and refuses partial readiness or unsafe derived totals', async () => {
    await expect(readNativeWealthInputs('owner', sql)).rejects.toThrow('Invalid native wealth facts');
    await seed();
    await sql.query("UPDATE olbia.asset_accounts SET name='Bitso personal' WHERE id='bitso'");
    expect((await readNativeWealthInputs('owner', sql)).accounts.find(a => a.id === 'bitso')?.name).toBe('Bitso personal');
    expect(await readNativeWealthInputs('unrelated', sql)).toMatchObject({ snapshots: [], liabilitySnapshots: [], cards: [] });
    expect(await readNativeWealthAudit('unrelated', sql)).toEqual([]);
    await sql.query("UPDATE olbia.card_profiles SET deleted_at=CURRENT_TIMESTAMP");
    expect((await readNativeWealthInputs('owner', sql)).cards).toEqual([]);
    const id = (await sql.query<{ capture_id: string }>('SELECT capture_id FROM olbia.asset_daily_captures')).rows[0]!.capture_id;
    await sql.query("INSERT INTO olbia.asset_holdings VALUES ($1,1,'large','USD','Large',1,'USD',0,9007199254740991)", [id]);
    await expect(readNativeWealthInputs('owner', sql)).rejects.toThrow('Invalid native wealth facts');
  });
  it('reuses the established provider snapshot and current transaction context without an outside query or write barrier', async () => {
    await seed();
    const outside = vi.fn(async () => { throw new Error('Outside snapshot'); });
    const transaction = vi.fn(fn => sql.transaction(c => fn(c)));
    vi.spyOn(connection, 'createPool').mockReturnValue({ query: outside, transaction } as never);
    const generation = (await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    expect((await readNativeWealthInputs('owner')).snapshots).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(1); expect(outside).not.toHaveBeenCalled();
    await sql.transaction(c => withSqlClient(c as unknown as SqlClient, async () => {
      expect(currentSqlClient()).toBe(c);
      expect(await readNativeWealthAudit('owner')).toHaveLength(2);
    }));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(currentSqlClient()).toBeUndefined();
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(generation);
  });
  it('sanitizes driver failures and never retries against document authority', async () => {
    const failure = { query: vi.fn(async () => { throw Object.assign(new Error('Private query and parameters'), { code: '08006' }); }) };
    await expect(readNativeWealthInputs('owner', failure)).rejects.toMatchObject({ name: 'StorageUnavailableException', message: 'Olbia storage is unavailable.' });
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });
});
