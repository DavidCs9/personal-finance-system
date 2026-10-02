import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { TABLE_NAMES, projectRows, type SourceItem, type SourceKey } from '../../ledger/src/dsql/model.js';
import { reconcileKey, type TransactionPool, type SqlClient } from '../../ledger/src/dsql/projection.js';
import { verifyKey } from '../../ledger/src/dsql/verification.js';

process.env.METADATA_TABLE_NAME ??= 'test';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const sqlReaders = await import('../src/events/sql-reads.js');
const wealth = await import('../src/wealth/service.js');
const reads = await import('../src/wealth/sql-reads.js');
const { verifyWealthReads } = await import('../src/wealth/read-verification.js');
const { investmentHistory } = await import('../src/agent/aggregates.js');
const { buildMonthlyCloseFacts } = await import('../src/reports/monthly-close.js');
const { syncBitsoAccount } = await import('../src/wealth/bitso-sync.js');
const { syncIbkrAccount } = await import('../src/wealth/ibkr-sync.js');
const now = new Date('2026-10-01T05:59:59.123Z'); // still September 30 in Chihuahua
const owner = 'owner';
let sql: PGlite, pool: TransactionPool, records: Map<string, SourceItem>, evidence: Map<string, string>;
const identity = (key: SourceKey) => `${key.PK}|${key.SK}`;
const put = (item: SourceItem) => records.set(identity(item), item);
const sync = (key: SourceKey) => reconcileKey(pool, async key => records.get(identity(key)), key);
const card = (id = 'amex'): SourceItem => ({ PK: `USER#${owner}`, SK: `CARD#${id}`, owner,
  createdAt: '2026-08-01T12:00:00.123Z', updatedAt: '2026-09-01T12:00:00.456Z',
  payload: { id, name: id, cutOffDay: 10, paymentDueDay: 28, institution: 'amex' } });
const snapshot = (accountId: string, day: string, total = 10000): SourceItem => ({ PK: `USER#${owner}`, SK: `WEALTH_SNAP#${accountId}#${day}`,
  owner, accountId, day, capturedAt: `${day}T12:00:00.123Z`, source: accountId === 'ibkr' ? 'flex' : 'api', currency: 'MXN', totalMxnMinor: total,
  holdings: [{ id: `${accountId}:same-symbol`, symbol: 'SAME', name: 'Position', currency: accountId === 'ibkr' ? 'USD' : 'SOL',
    quantity: 1.2345, valueNativeMinor: 567, valueMxnMinor: total, extraMetadata: { preserved: true } }],
  ...(accountId === 'ibkr' ? { fxRate: 17.1234, fxSource: 'banxico_sf43718' } : { fxSource: 'bitso_ticker' }),
  originalOptionalField: { retained: [null, 0, false] } });
const liability = (day: string, total = 5000): SourceItem => ({ PK: `USER#${owner}`, SK: `LIAB_SNAP#amex#${day}`,
  owner, cardId: 'amex', day, capturedAt: `${day}T12:00:00.456Z`, source: 'manual', currency: 'MXN', totalMxnMinor: total });
const seed = async () => {
  for (const item of [card(), snapshot('bitso', '2026-08-06'), snapshot('ibkr', '2026-08-07', 20000),
    snapshot('bitso', '2026-09-30', 15000), snapshot('ibkr', '2026-10-01', 999999), liability('2026-08-06'), liability('2026-09-30', 0)]) {
    const body = JSON.stringify({ originalEvidence: item });
    const sha256 = createHash('sha256').update(body).digest('hex'); evidence.set(sha256, body);
    put({ ...item, ...(item.day ? { evidence: { bucket: 'test-evidence', key: sha256, sha256 } } : {}) });
  }
  for (const item of records.values()) { await sync(item); await sync(item); }
};
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement.includes('CREATE TABLE IF NOT EXISTS olbia.cards (') ? statement.replace(',source_item jsonb', '') : statement);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) };
}, 30_000);
afterAll(async () => { await sql.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
beforeEach(async () => {
  records = new Map(); evidence = new Map();
  await sql.exec(`TRUNCATE olbia.projection_state,${TABLE_NAMES.map(table => `olbia.${table}`).join(',')}`);
  vi.stubEnv('DSQL_WEALTH_READ_MODE', 'guarded-sql'); vi.stubEnv('DSQL_PLANNING_READ_MODE', 'dynamodb');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.spyOn(sqlReaders, 'readerPool').mockReturnValue(sql); vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => {
    if (command.constructor.name === 'PutObjectCommand') { evidence.set(command.input.Key, command.input.Body); return {}; }
    return { Body: { transformToByteArray: async () => Buffer.from(evidence.get(command.input.Key)!) } };
  });
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command: any) => {
    const input = command.input;
    if (command.constructor.name === 'GetCommand') return { Item: records.get(identity(input.Key)) };
    if (command.constructor.name === 'PutCommand') { put(input.Item); return {}; }
    if (command.constructor.name === 'QueryCommand') {
      const values = input.ExpressionAttributeValues;
      return { Items: [...records.values()].filter(item => item.PK === values[':pk'] && item.SK.startsWith(values[':sk'] ?? values[':prefix'] ?? 'NO-MATCH')) };
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  });
});
describe('Patrimonio SQL migration', () => {
  it('independently verifies every source envelope, promoted column, account/day/month/holding/report and evidence; detects corruption despite fallback', async () => {
    await seed();
    expect(await verifyWealthReads(owner, ['2026-08', '2026-10'], now)).toMatchObject({ storedSnapshots: 4, storedLiabilities: 2,
      cards: 1, mismatches: 0, months: 5, evidenceFiles: 6 });
    await sql.query('UPDATE olbia.wealth_snapshots SET total_mxn_minor=total_mxn_minor+1 WHERE account_id=$1', ['bitso']);
    expect((await verifyWealthReads(owner, ['2026-08', '2026-10'], now)).mismatches).toBeGreaterThan(0);
    for (const item of records.values()) await sync(item);
    await sql.query("UPDATE olbia.wealth_snapshots SET source_item=jsonb_set(source_item,'{totalMxnMinor}','999') WHERE account_id=$1", ['bitso']);
    expect((await wealth.getWealthOverview(owner, now)).assetsMxnMinor).toBe(35000); // stale/corrupt SQL must fall back
    expect((await verifyWealthReads(owner, ['2026-08', '2026-10'], now)).mismatches).toBeGreaterThan(0);
  });
  it('preserves daily replacement, original audit versions, FX/native holdings/evidence and full envelopes under repeated reconciliation and deletes', async () => {
    await seed();
    const original = snapshot('ibkr', '2026-09-30'); put(original); await sync(original);
    const audit = { ...original, SK: `WEALTH_VER#ibkr#${original.day}#${original.capturedAt}`, versionId: 'original-audit-id', supersededAt: '2026-09-30T13:00:00.456Z' };
    put(audit); put({ ...original, totalMxnMinor: 15000, holdings: [] });
    expect((await reads.readConfiguredWealthInputs(owner)).snapshots.find(item => item.accountId === 'ibkr' && item.day === original.day)?.totalMxnMinor).toBe(15000);
    for (const key of [original, audit]) { await sync(key); await sync(key); expect(await verifyKey(pool, async key => records.get(identity(key)), key)).toBe('equal'); }
    expect(await reads.readWealthAudit(owner)).toEqual([audit]);
    expect((await reads.readSqlWealthInputs(owner)).snapshots.filter(item => item.day === original.day)).toHaveLength(2);
    records.delete(identity(original)); await sync(original); await sync(original);
    expect(await reads.readSqlWealthAudit(owner)).toEqual([audit]);
    expect((await sql.query('SELECT deleted FROM olbia.projection_state WHERE source_sk=$1', [original.SK])).rows).toEqual([{ deleted: true }]);
  });
  it('keeps paid-zero liabilities, carry-forward, Chihuahua day, August history start and month-close exclusion of day-one syncs', async () => {
    await seed();
    expect(await wealth.getWealthOverviewAsOf(owner, '2026-08-31')).toMatchObject({ assetsMxnMinor: 30000, liabilitiesMxnMinor: 5000, netMxnMinor: 25000 });
    expect(await wealth.getWealthOverviewAsOf(owner, '2026-09-30')).toMatchObject({ assetsMxnMinor: 35000, liabilitiesMxnMinor: 0, netMxnMinor: 35000 });
    expect(await wealth.getWealthOverview(owner, now)).toMatchObject({ asOfDay: '2026-09-30', netMxnMinor: 35000 });
    expect(await wealth.getWealthOverview(owner, new Date('2026-10-02T12:00:00Z'))).toMatchObject({
      history: { all: [{ day: '2026-08-01', totalMxnMinor: 25000 }, { day: '2026-09-01', totalMxnMinor: 35000 }, { day: '2026-10-01', totalMxnMinor: 1014999 }] } });
    const facts = await buildMonthlyCloseFacts(owner, '2026-09', now);
    expect(facts.wealth).toMatchObject({ assetsMxnMinor: 35000, liabilitiesMxnMinor: 0, netMxnMinor: 35000, priorNetMxnMinor: 25000, netDeltaMinor: 10000 });
    records.delete(identity(card()));
    expect((await wealth.getWealthOverview(owner, now)).liabilities).toEqual([]); // deleted profile wins during lag
    await sync(card());
    expect((await reads.readSqlWealthInputs(owner)).cards).toEqual([]);
  });
  it('uses one bounded SQL attempt per complete report/history read, propagates source failures and supports shadow/rollback', async () => {
    await seed();
    // Failure is scoped to wealth reads: the native catalog remains required
    // even when a different domain exercises its temporary source fallback.
    const attempts = vi.fn(async () => { throw new Error('private driver error'); });
    vi.mocked(sqlReaders.readerPool).mockReturnValue({ query: (statement, values) =>
      statement === reads.wealthReadStatement ? attempts() : sql.query(statement, values),
    });
    expect((await buildMonthlyCloseFacts(owner, '2026-09', now)).wealth.netMxnMinor).toBe(35000);
    expect(attempts).toHaveBeenCalledTimes(1); attempts.mockClear();
    expect(await investmentHistory(owner, { range: 'all' }, now)).toMatchObject({ scope: 'market_investments' });
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls.flat().join()).not.toContain('private');
    const sqlRead = vi.fn(async () => 1);
    vi.stubEnv('DSQL_WEALTH_READ_MODE', 'dynamodb');
    expect(await reads.readConfiguredWealth('wealth-inputs', sqlRead, async () => 2)).toBe(2); expect(sqlRead).not.toHaveBeenCalled();
    vi.stubEnv('DSQL_WEALTH_READ_MODE', 'shadow'); expect(await reads.readConfiguredWealth('wealth-inputs', sqlRead, async () => 1)).toBe(1);
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain('"SourceSelected":1');
    await expect(reads.readConfiguredWealth('wealth-inputs', sqlRead, async () => { throw new Error('source down'); })).rejects.toThrow('source down');
    vi.stubEnv('DSQL_WEALTH_READ_MODE', 'guarded-sql'); await reads.readConfiguredWealth('wealth-inputs', sqlRead, async () => 1);
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain('"SqlSelected":1');
  });
  it('preserves source manual writes, same-day prior audit snapshots and zero captures while projection lags', async () => {
    put(card()); await sync(card());
    await wealth.createCajitaSnapshot('{"amountMinor":10000}', owner);
    await wealth.createCardLiabilitySnapshot('amex', '{"amountMinor":10000}', owner);
    vi.setSystemTime(new Date('2026-10-01T05:59:59.456Z'));
    await wealth.createCajitaSnapshot('{"amountMinor":20000}', owner);
    await wealth.createCardLiabilitySnapshot('amex', '{"amountMinor":0}', owner);
    const overview = await wealth.getWealthOverview(owner);
    expect(overview).toMatchObject({ assetsMxnMinor: 20000, liabilitiesMxnMinor: 0, netMxnMinor: 20000 });
    expect([...records.values()].filter(item => item.SK.startsWith('WEALTH_SNAP#'))).toHaveLength(1);
    expect([...records.values()].filter(item => item.SK.startsWith('LIAB_SNAP#'))).toHaveLength(1);
    const audits = [...records.values()].filter(item => /^(WEALTH|LIAB)_VER#/.test(item.SK)); expect(audits).toHaveLength(2);
    for (const item of records.values()) { await sync(item); await sync(item); }
    expect(await reads.readSqlWealthAudit(owner)).toEqual(audits.sort((a, b) => a.SK.localeCompare(b.SK)));
    for (const item of records.values()) expect(await verifyKey(pool, async key => records.get(identity(key)), item)).toBe('equal');
  });
  it('keeps repeated Bitso/IBKR successful captures canonical once per day with prior versions retained for audit', async () => {
    for (const accountId of ['bitso', 'ibkr'] as const) {
      for (const [index, instant] of ['2026-09-30T12:00:00.123Z', '2026-09-30T12:00:01.456Z', '2026-09-30T12:00:02.789Z'].entries()) {
        vi.setSystemTime(new Date(instant));
        await wealth.persistWealthSnapshot({ owner, accountId, source: accountId === 'bitso' ? 'api' : 'flex',
          holdings: snapshot(accountId, '2026-09-30', 10000 + index).holdings as any,
          evidenceKind: 'api', evidenceBody: JSON.stringify({ provider: accountId, index }), fxRate: accountId === 'ibkr' ? 17.1234 : undefined });
      }
    }
    for (const item of records.values()) { await sync(item); await sync(item); }
    expect((await reads.readSqlWealthInputs(owner)).snapshots).toHaveLength(2);
    expect(await reads.readSqlWealthAudit(owner)).toHaveLength(4);
    expect((await wealth.getWealthOverview(owner)).assetsMxnMinor).toBe(20004);
    for (const item of records.values()) expect(await verifyKey(pool, async key => records.get(identity(key)), item)).toBe('equal');
  });
  it('retains last good snapshots and evidence when Bitso or IBKR sync fails before persistence', async () => {
    await seed(); const before = [...records.values()];
    const failure = vi.fn(async () => { throw new Error('provider unavailable'); }) as unknown as typeof fetch;
    await expect(syncBitsoAccount({ owner, credentials: { apiKey: 'test', apiSecret: 'test' }, fetchImpl: failure })).rejects.toThrow('provider unavailable');
    await expect(syncIbkrAccount({ owner, credentials: { flexToken: 'test', flexQueryId: 'test' }, banxicoToken: 'test', fetchImpl: failure })).rejects.toThrow('provider unavailable');
    expect([...records.values()]).toEqual(before);
    expect(vi.mocked(S3Client.prototype.send)).not.toHaveBeenCalled();
    expect((await wealth.getWealthOverview(owner, now)).netMxnMinor).toBe(35000);
  });
  it('rolls back failed/invalid projections, rejects persisted fund rows and never leaks another owner through parameters', async () => {
    await seed(); const item = snapshot('ibkr', '2026-09-30'); put(item); await sync(item);
    const interrupted: TransactionPool = { transaction: callback => sql.transaction(async client => { await callback(client as unknown as SqlClient); throw new Error('before commit'); }) };
    put({ ...item, holdings: [] }); await expect(reconcileKey(interrupted, async key => records.get(identity(key)), item)).rejects.toThrow('before commit');
    expect(await verifyKey(pool, async key => records.get(identity(key)), item)).toBe('lag');
    expect(() => projectRows({ ...item, SK: 'WEALTH_SNAP#fondo_ahorro#2026-09-30' }, { ...item, accountId: 'fondo_ahorro', SK: 'WEALTH_SNAP#fondo_ahorro#2026-09-30' })).toThrow('Invalid persisted wealth account');
    expect(await reads.readSqlWealthInputs("owner' OR '1'='1")).toEqual({ snapshots: [], liabilitySnapshots: [], cards: [] });
    expect(await reads.readSqlWealthAudit("owner' OR '1'='1")).toEqual([]);
  });
  it('paginates canonical and audit source queries through empty pages with strong consistency', async () => {
    const send = vi.mocked(DynamoDBDocumentClient.prototype.send); send.mockReset();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { PK: 'USER#owner', SK: 'WEALTH_SNAP#bitso#2026-08-06' } } as never)
      .mockResolvedValueOnce({ Items: [snapshot('bitso', '2026-08-07')] } as never);
    expect(await wealth.listCanonicalSnapshotsDynamo(owner)).toHaveLength(1);
    expect(send.mock.calls.map(([command]) => command.input)).toMatchObject([{ ConsistentRead: true }, { ConsistentRead: true, ExclusiveStartKey: { PK: 'USER#owner', SK: 'WEALTH_SNAP#bitso#2026-08-06' } }]);
  });
});
