import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../../ledger/src/dsql/connection.js';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS, NATIVE_WEALTH_TABLES } from '../../ledger/src/dsql/wealth-schema.js';
import { migrateWealth } from '../../ledger/src/dsql/wealth-copy.js';
import { projectRows, type SourceItem } from '../../ledger/src/dsql/model.js';
import { currentStoreTransaction } from '../../ledger/src/dsql/store.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { readIndependentWealthState, verifyWealthRecovery } from '../src/wealth/native-verification.js';

process.env.METADATA_TABLE_NAME ??= 'test'; process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const wealth = await import('../src/wealth/service.js');
const { verifyWealthReads } = await import('../src/wealth/read-verification.js');
const { investmentHistory } = await import('../src/agent/aggregates.js');
const { buildMonthlyCloseFacts } = await import('../src/reports/monthly-close.js');
let sql: PGlite;
const evidence = new Map<string, string>();
const before = '2026-09-30T12:00:00.123Z', after = '2026-09-30T13:00:00.456Z';
const now = new Date('2026-10-01T05:59:59.999Z');
const pool: TransactionPool = { transaction: fn => sql.transaction(c => fn(c as unknown as SqlClient)) };
const item = (kind: 'asset' | 'liability', identity: string, day: string, amount: number, prior = false): SourceItem => ({
  PK: 'USER#owner', SK: `${kind === 'asset' ? 'WEALTH' : 'LIAB'}_${prior ? 'VER' : 'SNAP'}#${identity}#${day}${prior ? `#${before}` : ''}`,
  owner: 'owner', ...(kind === 'asset' ? { accountId: identity,
    holdings: [{ id: `${identity}:cash`, symbol: 'MXN', name: 'Cash', quantity: 1.1234567891234568, currency: 'MXN', valueNativeMinor: amount, valueMxnMinor: amount }] } : { cardId: identity }),
  day, capturedAt: day === '2026-09-30' ? prior ? before : after : `${day}T12:00:00.123Z`,
  source: kind === 'asset' ? identity === 'ibkr' ? 'flex' : 'api' : 'manual', currency: 'MXN', totalMxnMinor: amount,
  ...(prior ? { versionId: kind === 'asset' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002', supersededAt: after } : {}),
});
const seed = async () => {
  const originals = [item('asset', 'bitso', '2026-08-06', 10000), item('asset', 'ibkr', '2026-08-07', 20000),
    item('asset', 'bitso', '2026-09-30', 15000), item('asset', 'bitso', '2026-09-30', 10000, true),
    item('asset', 'ibkr', '2026-10-01', 999999), item('liability', 'amex', '2026-08-06', 5000),
    item('liability', 'amex', '2026-09-30', 0), item('liability', 'amex', '2026-09-30', 5000, true)];
  for (const original of originals) {
    const body = JSON.stringify({ owner: original.owner, day: original.day,
      ...(original.accountId ? { kind: original.source === 'flex' ? 'wealth_ibkr_snapshot' : 'wealth_bitso_snapshot', accountId: original.accountId, holdings: original.holdings }
        : { kind: 'wealth_liability_manual_snapshot', cardId: original.cardId, amountMinor: original.totalMxnMinor }) });
    const hash = createHash('sha256').update(body).digest('hex'); evidence.set(hash, body);
    original.evidence = { bucket: 'test-evidence', key: hash, sha256: hash, contentType: 'application/json' };
    for (const row of projectRows(original, original)) {
      const columns = Object.keys(row.values);
      await sql.query(`INSERT INTO olbia.${row.table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row.values).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v));
    }
  }
  await migrateWealth(pool);
};
beforeAll(async () => {
  sql = new PGlite(); for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_WEALTH_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query("INSERT INTO olbia.card_profiles VALUES ('amex','owner','Amex',25,15,'american_express_mx',$1,$1,NULL)", [before]);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
}, 30_000);
afterAll(() => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${[...NATIVE_WEALTH_TABLES, 'wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions'].map(t => `olbia.${t}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=15');
  await sql.query('UPDATE olbia.card_profiles SET deleted_at=NULL'); evidence.clear();
  vi.spyOn(connection, 'createPool').mockReturnValue({ query: sql.query.bind(sql), ...pool } as never);
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(new Error('Unexpected document authority'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => {
    if (command.constructor.name === 'PutObjectCommand') { evidence.set(command.input.Key, command.input.Body); return {}; }
    expect(currentStoreTransaction()).toBeUndefined();
    const body = evidence.get(command.input.Key); if (!body) throw new Error('Missing evidence');
    return { Body: { transformToByteArray: async () => Buffer.from(body) } };
  });
  await seed();
});

describe('native wealth public contracts and independent acceptance', () => {
  it('verifies every immutable original, current/history relationship, report and evidence outside the snapshot', async () => {
    expect(await verifyWealthReads('owner', ['2026-08', '2026-10'], now)).toMatchObject({ mode: 'native-sql', storedSnapshots: 4,
      storedLiabilities: 2, storedVersions: 1, storedLiabilityVersions: 1, captures: 8, holdings: 5, replacements: 2,
      recoveryAssertions: 8, validatedConstraints: 24, evidenceFiles: 8, mismatches: 0 });
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });
  it('preserves month-end carry forward, paid zero, Chihuahua boundaries, monthly trend and actual assistant/report paths', async () => {
    expect(await wealth.getWealthOverviewAsOf('owner', '2026-08-31')).toMatchObject({ assetsMxnMinor: 30000, liabilitiesMxnMinor: 5000, netMxnMinor: 25000 });
    expect(await wealth.getWealthOverviewAsOf('owner', '2026-09-30')).toMatchObject({ assetsMxnMinor: 35000, liabilitiesMxnMinor: 0, netMxnMinor: 35000 });
    expect(await wealth.getWealthOverview('owner', now)).toMatchObject({ asOfDay: '2026-09-30', netMxnMinor: 35000 });
    expect(await wealth.getWealthOverview('owner', new Date('2026-10-02T12:00:00Z'))).toMatchObject({ history: {
      all: [{ day: '2026-08-01', totalMxnMinor: 25000 }, { day: '2026-09-01', totalMxnMinor: 35000 }, { day: '2026-10-01', totalMxnMinor: 1014999 }] } });
    expect((await buildMonthlyCloseFacts('owner', '2026-09', now)).wealth).toMatchObject({ netMxnMinor: 35000, priorNetMxnMinor: 25000, netDeltaMinor: 10000 });
    expect(await investmentHistory('owner', { range: 'all' }, now)).toMatchObject({ scope: 'market_investments' });
    await sql.query("UPDATE olbia.asset_accounts SET name='My Bitso' WHERE id='bitso'");
    expect((await wealth.getWealthOverviewAsOf('owner', '2026-09-30')).accounts.find(a => a.id === 'bitso')?.name).toBe('My Bitso');
    await sql.query('UPDATE olbia.card_profiles SET deleted_at=CURRENT_TIMESTAMP');
    expect((await wealth.getWealthOverviewAsOf('owner', '2026-09-30')).liabilities).toEqual([]);
  });
  it('detects corrupted holdings and current pointers independently; frozen former daily facts cannot restore product authority', async () => {
    const first = await readIndependentWealthState('owner', sql);
    const id = [...first.assetFacts].find(([, s]) => s.accountId === 'bitso' && s.day === '2026-09-30' && s.totalMxnMinor === 15000)![0];
    await sql.query('UPDATE olbia.asset_holdings SET value_mxn_minor=value_mxn_minor+1 WHERE capture_id=$1', [id]);
    expect((await wealth.getWealthOverviewAsOf('owner', '2026-09-30')).assetsMxnMinor).toBe(35001);
    expect((await verifyWealthReads('owner', ['2026-09'], now)).recoveryMismatches).toBeGreaterThan(0);
    await sql.query('UPDATE olbia.asset_holdings SET value_mxn_minor=value_mxn_minor-1 WHERE capture_id=$1', [id]);
    await sql.query("UPDATE olbia.asset_daily_captures SET capture_id='10000000-0000-4000-8000-000000000001' WHERE account_id='bitso' AND day='2026-09-30'");
    expect((await readIndependentWealthState('owner', sql)).mismatches).toBeGreaterThan(0);
  });
  it('retains frozen originals after legitimate later captures while detecting changed recovery assertions and original bytes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    const holdings = [{ id: 'mxn', symbol: 'MXN', name: 'Cash', quantity: 1, currency: 'MXN', valueNativeMinor: 222, valueMxnMinor: 222 }];
    await wealth.persistWealthSnapshot({ owner: 'owner', accountId: 'bitso', source: 'api', holdings, evidenceKind: 'api',
      evidenceBody: JSON.stringify({ kind: 'wealth_bitso_snapshot', owner: 'owner', day: '2026-09-30', accountId: 'bitso', holdings }) });
    expect(await verifyWealthReads('owner', ['2026-09'], now)).toMatchObject({ captures: 9, replacements: 3, recoveryAssertions: 8, recoveryMismatches: 0, mismatches: 0 });
    await sql.query("UPDATE olbia.asset_holdings SET value_mxn_minor=223 WHERE id='mxn'");
    expect(await verifyWealthReads('owner', ['2026-09'], now)).toMatchObject({ recoveryMismatches: 0, evidence: { factMismatches: 1 }, mismatches: 1 });
    await sql.query("UPDATE olbia.asset_holdings SET value_mxn_minor=222 WHERE id='mxn'");
    await sql.query("UPDATE olbia.wealth_versions SET source_item=jsonb_set(source_item,'{totalMxnMinor}','999')");
    const state = await readIndependentWealthState('owner', sql);
    expect((await verifyWealthRecovery('owner', sql, state)).mismatches).toBeGreaterThan(0);
    evidence.set([...evidence.keys()][0]!, 'Corrupted original bytes');
    expect((await verifyWealthReads('owner', ['2026-09'], now)).evidence.mismatches).toBeGreaterThan(0);
  });
});
