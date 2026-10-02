import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveMonthCompensation, runningFondoAhorroByDay, sumFondoAhorroDeduccionesMinor } from '@finance/domain';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { TABLE_NAMES, type SourceItem, type SourceKey } from '../../ledger/src/dsql/model.js';
import { reconcileKey, type TransactionPool, type SqlClient } from '../../ledger/src/dsql/projection.js';
import { verifyKey } from '../../ledger/src/dsql/verification.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const application = await import('../../ledger/src/dsql/store.js');
const sqlReaders = await import('../src/events/sql-reads.js');
const { readSqlPlanRecord, readSqlPayslipsForMonth, readSqlPayslipsForYear, planningReadMode, readConfiguredPlanning } = await import('../src/months/sql-reads.js');
const { getMonthlyPlan, saveMonthlyPlan, getMonthlyPlanFromReads } = await import('../src/months/service.js');
const { incomeFieldsForMonth, listPayslipsForMonth, listPayslipsForMonthDynamo, listPayslipsForYear, getPayslip, ingestNominaXml } = await import('../src/imports/cfdi-nomina-flow.js');
const { getWealthOverview, getWealthOverviewAsOf } = await import('../src/wealth/service.js');
const { summarizeMonthFeed } = await import('../src/months/summary.js');
const { parseCfdiNominaXml } = await import('../src/imports/cfdi-nomina.js');
const { verifyPlanningReads } = await import('../src/months/read-verification.js');
const fixture = readFileSync(new URL('./fixtures/cfdi-nomina-sample.xml', import.meta.url), 'utf8');
const baseline = parseCfdiNominaXml(fixture);
const now = new Date('2026-10-01T13:00:00.123Z');
const owner = 'owner';
let sql: PGlite;
let pool: TransactionPool;
let records: Map<string, SourceItem>;
const recordId = (key: SourceKey) => `${key.PK}|${key.SK}`;
const put = (item: SourceItem) => records.set(recordId(item), item);
const payment = { id: 'same-id', name: 'Fixed bill', amountMinor: 12345, dueDay: 31 };
const plan = (month: string, upcomingPayments = [payment]): SourceItem => ({ PK: `USER#${owner}`, SK: `MONTH#${month}`,
  owner, month, entityType: 'monthly_plan', payload: { upcomingPayments, currency: 'MXN', incomeMinor: 4000000, updatedAt: '2026-09-20T20:01:02.123Z' } });
const payroll = (month: string, uuid: string, day = '15', tipoNomina = 'O'): SourceItem => ({ PK: `USER#${owner}`, SK: `PAYROLL#${month}#${uuid}`,
  owner, month, uuid, ingestedAt: '2026-09-20T20:01:02.456Z', source: { bucket: 'test-evidence', key: uuid, sha256: 'hash', contentType: 'application/xml' },
  payload: { ...baseline, month, uuid, fechaPago: `${month}-${day}`, tipoNomina } });
const sync = async (item: SourceKey) => {
  await reconcileKey(pool, async key => records.get(recordId(key)), item);
  // Seed the native fixture once; frozen reconciliation never overwrites native edits.
  const source = records.get(recordId(item));
  if (!source || !item.SK.startsWith('MONTH#') || (await sql.query('SELECT month FROM olbia.month_plans WHERE month=$1',[source.month])).rows.length) return;
  const payload = source.payload as any;
  await sql.query('INSERT INTO olbia.month_plans VALUES ($1,$2,$3)',[source.month,source.owner,payload.updatedAt]);
  for (const [order,payment] of payload.upcomingPayments.entries()) await sql.query('INSERT INTO olbia.planned_payments VALUES ($1,$2,$3,$4,$5,$6)',
    [source.month,payment.id,payment.name,payment.amountMinor,payment.dueDay,order]);
};

beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) };
}, 30_000);
afterAll(async () => { await sql.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
beforeEach(async () => {
  records = new Map();
  await sql.exec(`TRUNCATE olbia.projection_state,olbia.month_plans,olbia.planned_payments,${TABLE_NAMES.map(table => `olbia.${table}`).join(',')}`);
  vi.stubEnv('DSQL_PLANNING_READ_MODE', 'guarded-sql');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.spyOn(application, 'applicationStoreClient').mockReturnValue(sql);
  vi.spyOn(sqlReaders, 'readerPool').mockReturnValue(sql);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command: any) => {
    const input = command.input;
    if (command.constructor.name === 'GetCommand') return { Item: records.get(recordId(input.Key)) };
    if (command.constructor.name === 'PutCommand') { put(input.Item); return {}; }
    if (command.constructor.name === 'TransactWriteCommand') {
      if (input.TransactItems.some((operation: any) => records.has(recordId(operation.Put.Item)))) throw Object.assign(new Error('Duplicate'), { name: 'TransactionCanceledException' });
      for (const operation of input.TransactItems) put(operation.Put.Item);
      return {};
    }
    if (command.constructor.name === 'QueryCommand') {
      const values = input.ExpressionAttributeValues;
      let items = [...records.values()].filter(item => item.PK === values[':pk']);
      items = values[':monthPrefix'] ? items.filter(item => item.SK >= values[':monthPrefix'] && item.SK <= values[':month'])
        : items.filter(item => item.SK.startsWith(values[':sk'] ?? values[':prefix'] ?? ''));
      items.sort((a, b) => input.ScanIndexForward === false ? b.SK.localeCompare(a.SK) : a.SK.localeCompare(b.SK));
      return { Items: items.slice(0, input.Limit ?? items.length) };
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  });
});

describe('DSQL planning and payroll contracts', () => {
  it('verifies independent real SQL/source financial results and XML hashes, and cannot hide a mismatch behind guard fallback', async () => {
    await ingestNominaXml(owner, 'original.xml', fixture);
    const key = { PK: `USER#${owner}`, SK: `PAYROLL#2026-07#${baseline.uuid}` };
    const planned = plan('2026-07'); put(planned); await sync(planned); await sync(key);
    vi.mocked(S3Client.prototype.send).mockResolvedValue({ Body: { transformToByteArray: async () => Buffer.from(fixture) } } as never);
    const verified = await verifyPlanningReads(owner, [], ['2026-07', '2026-10'], now);
    expect(verified).toMatchObject({ storedPlans: 1, storedPayroll: 1, details: 1, evidenceFiles: 1, mismatches: 0 });
    const corrupt = { ...records.get(recordId(key))!, payload: { ...baseline, totalMinor: baseline.totalMinor + 1 } };
    await sql.query('UPDATE olbia.payroll SET source_item=$1 WHERE source_pk=$2 AND source_sk=$3', [JSON.stringify(corrupt), key.PK, key.SK]);
    expect((await verifyPlanningReads(owner, [], ['2026-07', '2026-10'], now)).mismatches).toBeGreaterThan(0);
    expect(await getPayslip(owner, '2026-07', baseline.uuid)).toMatchObject({ totalMinor: baseline.totalMinor });
  });
  it('retains full history, envelope evidence and IDs through duplicate backfill/replay and confirmed updates', async () => {
    const items = [plan('2026-09'), payroll('2026-09', 'B'), payroll('2026-09', 'A', '30')];
    for (const item of items) { put(item); await sync(item); await sync(item); }
    expect((await sql.query('SELECT source_item FROM olbia.monthly_plans')).rows).toEqual([{ source_item: items[0] }]);
    expect((await sql.query('SELECT count(*) AS count FROM olbia.payroll')).rows).toEqual([{ count: 2 }]);
    expect(await getPayslip(owner, '2026-09', 'a')).toMatchObject({ uuid: 'A', source: items[2].source, ingestedAt: items[2].ingestedAt, lines: baseline.lines });
    for (const item of items) expect(await verifyKey(pool, async key => records.get(recordId(key)), item)).toBe('equal');
    const updated = { ...items[2], source: { ...items[2].source as object, key: 'corrected-evidence' } };
    put(updated);
    expect(await getPayslip(owner, '2026-09', 'A')).toMatchObject({ source: { key: 'corrected-evidence' } });
    await sync(updated);
    expect(await verifyKey(pool, async key => records.get(recordId(key)), updated)).toBe('equal');
    records.delete(recordId(updated)); await sync(updated); await sync(updated);
    expect(await getPayslip(owner, '2026-09', 'A')).toBeUndefined();
    expect((await sql.query('SELECT deleted FROM olbia.projection_state WHERE source_sk=$1', [updated.SK])).rows).toEqual([{ deleted: true }]);
  });

  it('carries the last complete list across gaps/year boundaries, stops on explicit empty lists and preserves history after saves', async () => {
    for (const item of [plan('2026-09'), plan('2026-11', []), plan('2027-02')]) { put(item); await sync(item); }
    expect(await getMonthlyPlan(owner, '2026-08')).toMatchObject({ upcomingPayments: [] });
    expect(await getMonthlyPlan(owner, '2026-10')).toMatchObject({ inheritedFromMonth: '2026-09', upcomingPayments: [payment] });
    expect(await getMonthlyPlan(owner, '2027-01')).toMatchObject({ inheritedFromMonth: '2026-11', upcomingPayments: [] });
    const saved = await saveMonthlyPlan(owner, '2027-01', { currency: 'MXN', upcomingPayments: [{ ...payment, amountMinor: 23456 }] });
    expect(saved).toMatchObject({ upcomingPayments: [{ ...payment, amountMinor: 23456 }] });
    expect(saved.inheritedFromMonth).toBeUndefined(); // The selected month is now native authority.
    expect(await readSqlPlanRecord(owner, '2027-01', sql)).toMatchObject({ month: '2027-01', upcomingPayments: [{ ...payment, amountMinor: 23456 }] });
    await sync({ PK: `USER#${owner}`, SK: 'MONTH#2027-01' });
    expect(await readSqlPlanRecord(owner, '2027-01', sql)).toMatchObject({ month: '2027-01' });
    expect(await getMonthlyPlan(owner, '2026-09')).toMatchObject({ upcomingPayments: [payment] });
    expect(await readSqlPlanRecord("owner' OR '1'='1", '2027-01', sql)).toBeUndefined();
  });

  it('preserves provisional income, twin estimates, extraordinary payroll, sort order and monthly compensation/calculations', async () => {
    const items = [plan('2026-09'), payroll('2026-09', 'B'), payroll('2026-09', 'A', '30'), payroll('2026-09', 'C', '30', 'E')];
    for (const item of items) { put(item); await sync(item); }
    expect((await listPayslipsForMonth(owner, '2026-09')).map(slip => slip.uuid)).toEqual(['B', 'A', 'C']);
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ provisionalActive: true, incomeMinor: baseline.totalMinor * 2 });
    expect(await incomeFieldsForMonth(owner, '2026-08', now)).toMatchObject({ configured: false, incomeMinor: 0 });
    const first = payroll('2026-10', 'D'); put(first);
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ estimateActive: true, provisionalActive: false, incomeMinor: baseline.totalMinor * 2 });
    await sync(first);
    const extra = payroll('2026-10', 'E', '16', 'E'); put(extra); await sync(extra);
    const fields = await incomeFieldsForMonth(owner, '2026-10', now);
    expect(fields).toMatchObject({ estimateActive: true, incomeMinor: baseline.totalMinor * 3 });
    expect(deriveMonthCompensation(fields)).toMatchObject({ fondoMinor: 1141800, estimatedFondoMinor: 570900, compensationMinor: baseline.totalMinor * 3 + 1712700 });
    const second = payroll('2026-10', 'F', '30'); put(second); await sync(second);
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ estimateActive: false, incomeMinor: baseline.totalMinor * 3 });
    const sourcePlan = await getMonthlyPlanFromReads(owner, '2026-10', readSqlPlanRecord,
      (owner, month) => incomeFieldsForMonth(owner, month, now, listPayslipsForMonthDynamo));
    const sqlPlan = await getMonthlyPlanFromReads(owner, '2026-10', readSqlPlanRecord,
      (owner, month) => incomeFieldsForMonth(owner, month, now, readSqlPayslipsForMonth));
    expect(sqlPlan).toEqual(sourcePlan);
    const feed = { events: [{ id: 'zero-share', amount: { amountMinor: 120000 }, personalAmountMinor: 0, status: 'accepted', receivedAt: '2026-10-01T12:00:00Z' }], msiRelated: [] };
    expect(summarizeMonthFeed('2026-10', sqlPlan, feed, now)).toEqual(summarizeMonthFeed('2026-10', sourcePlan, feed, now));
    expect(summarizeMonthFeed('2026-10', sqlPlan, feed, now).spentMinor).toBe(0);
  });

  it('keeps payroll-derived Patrimonio YTD and same-day/as-of history correct, excluding prior/next years', async () => {
    const items = [payroll('2025-12', 'OLD'), payroll('2026-09', 'A'), payroll('2026-09', 'B'), payroll('2026-10', 'C'), payroll('2027-01', 'FUTURE')];
    for (const item of items) { put(item); await sync(item); }
    const year = await listPayslipsForYear(owner, '2026');
    expect(year).toHaveLength(3);
    expect(sumFondoAhorroDeduccionesMinor(year)).toBe(1712700);
    expect(runningFondoAhorroByDay(year)).toEqual([{ day: '2026-09-15', totalMxnMinor: 1141800 }, { day: '2026-10-15', totalMxnMinor: 1712700 }]);
    expect(await getWealthOverviewAsOf(owner, '2026-09-30')).toMatchObject({ assetsMxnMinor: 1141800, netMxnMinor: 1141800 });
    const sqlWealth = await getWealthOverview(owner, now, readSqlPayslipsForYear);
    expect(sqlWealth).toMatchObject({ assetsMxnMinor: 1712700 });
    expect(await readSqlPayslipsForYear(owner, '2025', sql)).toHaveLength(1);
    expect(await readSqlPayslipsForYear(owner, "2026' OR '1'='1", sql)).toEqual([]);
  });

  it('keeps duplicate imports on authoritative claims when SQL lags or fails, without multiplying evidence/payroll', async () => {
    const first = await ingestNominaXml(owner, 'source.xml', fixture);
    expect(first.status).toBe('created');
    expect(await readSqlPayslipsForMonth(owner, '2026-07', sql)).toEqual([]);
    expect((await ingestNominaXml(owner, 'again.xml', fixture)).status).toBe('duplicate');
    expect((await listPayslipsForMonth(owner, '2026-07')).map(slip => slip.uuid)).toEqual([baseline.uuid]);
    const key = { PK: `USER#${owner}`, SK: `PAYROLL#2026-07#${baseline.uuid}` }; await sync(key); await sync(key);
    vi.spyOn(sqlReaders, 'readerPool').mockImplementation(() => { throw new Error('SQL down'); });
    expect((await ingestNominaXml(owner, 'during-outage.xml', fixture)).status).toBe('duplicate');
    expect(await getPayslip(owner, '2026-07', baseline.uuid.toLowerCase())).toMatchObject({ uuid: baseline.uuid, source: { contentType: 'application/xml' } });
    expect(vi.mocked(S3Client.prototype.send).mock.calls).toHaveLength(1);
    expect([...records.values()].filter(item => item.SK.startsWith('PAYROLL#'))).toHaveLength(1);
    vi.mocked(sqlReaders.readerPool).mockClear();
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ provisionalActive: true, incomeMinor: baseline.totalMinor * 2 });
    expect(sqlReaders.readerPool).toHaveBeenCalledTimes(1); // No timeout amplification across prior months.
  });

  it('rolls back failed projections and uses safe fallback/rollback modes without leaking driver errors', async () => {
    const item = payroll('2026-09', 'A'); put(item); await sync(item);
    put({ ...item, payload: { ...item.payload as object, totalMinor: 1.5 } });
    await expect(sync(item)).rejects.toThrow('Invalid projection integer');
    expect((await readSqlPayslipsForMonth(owner, '2026-09', sql))[0].totalMinor).toBe(baseline.totalMinor);
    const fresh = plan('2026-10'); put(fresh);
    const interrupted: TransactionPool = { transaction: callback => sql.transaction(async client => { await callback(client as unknown as SqlClient); throw new Error('before commit'); }) };
    await expect(reconcileKey(interrupted, async () => fresh, fresh)).rejects.toThrow('before commit');
    expect(await readSqlPlanRecord(owner, '2026-10', sql)).toBeUndefined();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await readConfiguredPlanning('payroll-month', async () => { throw new Error('private row/token'); }, async () => fresh)).toEqual(fresh);
    expect(logs.mock.calls.flat().join()).toContain('sql-error');
    expect(logs.mock.calls.flat().join()).not.toContain('private');
    await expect(readConfiguredPlanning('payroll-month', async () => fresh, async () => { throw new Error('source down'); })).rejects.toThrow('source down');
    for (const mode of ['dynamodb', 'invalid']) {
      vi.stubEnv('DSQL_PLANNING_READ_MODE', mode);
      const sqlRead = vi.fn(async () => fresh);
      expect(planningReadMode()).toBe('dynamodb');
      expect(await readConfiguredPlanning('payroll-month', sqlRead, async () => fresh)).toEqual(fresh);
      expect(sqlRead).not.toHaveBeenCalled();
    }
    vi.stubEnv('DSQL_PLANNING_READ_MODE', 'shadow');
    await readConfiguredPlanning('payroll-month', async () => fresh, async () => fresh);
    expect(logs.mock.calls.at(-1)?.[0]).toContain('"SourceSelected":1');
  });

  it('paginates strongly consistent payroll queries through empty pages', async () => {
    const send = vi.mocked(DynamoDBDocumentClient.prototype.send); send.mockReset();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { PK: `USER#${owner}`, SK: 'PAYROLL#2026-09#A' } } as never)
      .mockResolvedValueOnce({ Items: [payroll('2026-09', 'B')] } as never);
    expect(await listPayslipsForMonthDynamo(owner, '2026-09')).toHaveLength(1);
    expect(send.mock.calls.map(([command]) => command.input)).toMatchObject([
      { ConsistentRead: true }, { ConsistentRead: true, ExclusiveStartKey: { PK: `USER#${owner}`, SK: 'PAYROLL#2026-09#A' } },
    ]);
  });
});
