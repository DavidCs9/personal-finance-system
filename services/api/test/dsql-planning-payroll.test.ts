import { prepareNativeWealthFixture } from './fixtures/native-wealth.js';
import { NATIVE_WEALTH_TABLES } from '../../ledger/src/dsql/wealth-schema.js';
import { prepareNativeLedgerFixture } from './fixtures/native-ledger.js';
import { NATIVE_LEDGER_TABLES } from '../../ledger/src/dsql/ledger-schema.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as connection from '../../ledger/src/dsql/connection.js';
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
const { readSqlPlanRecord, readSqlPayslipsForMonth, readSqlPayslipsForYear, readSqlPayslipRecord } = await import('../src/months/sql-reads.js');
const { getMonthlyPlan, saveMonthlyPlan, getMonthlyPlanFromReads } = await import('../src/months/service.js');
const { incomeFieldsForMonth, listPayslipsForMonth, listPayslipsForYear, getPayslip, ingestNominaXml } = await import('../src/imports/cfdi-nomina-flow.js');
const { insertPayslip } = await import('../src/imports/payroll-sql.js');
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
const listFrozenPayslips = async (owner:string,month:string) => [...records.values()].filter(item=>item.PK===`USER#${owner}` && item.SK.startsWith(`PAYROLL#${month}#`)).map(item=>item.payload as unknown as typeof baseline).sort((a,b)=>a.fechaPago.localeCompare(b.fechaPago)||a.uuid.localeCompare(b.uuid));
const recordId = (key: SourceKey) => `${key.PK}|${key.SK}`;
const put = (item: SourceItem) => records.set(recordId(item), item);
const payment = { id: 'same-id', name: 'Fixed bill', amountMinor: 12345, dueDay: 31 };
const plan = (month: string, upcomingPayments = [payment]): SourceItem => ({ PK: `USER#${owner}`, SK: `MONTH#${month}`,
  owner, month, entityType: 'monthly_plan', payload: { upcomingPayments, currency: 'MXN', incomeMinor: 4000000, updatedAt: '2026-09-20T20:01:02.123Z' } });
const uid = (label: string) => /^[0-9A-F-]{36}$/.test(label) ? label : `00000000-0000-0000-0000-${String(label.charCodeAt(0)).padStart(12,'0')}`;
const payroll = (month: string, uuid: string, day = '15', tipoNomina = 'O'): SourceItem => ({ PK: `USER#${owner}`, SK: `PAYROLL#${month}#${uid(uuid)}`,
  owner, month, uuid: uid(uuid), ingestedAt: '2026-09-20T20:01:02.456Z', source: { kind: 'cfdi_nomina',bucket: 'test-evidence', key: uid(uuid), sha256: createHash('sha256').update(fixture).digest('hex'), contentType: 'application/xml' },
  payload: { ...baseline, month, uuid: uid(uuid), fechaPago: `${month}-${day}`, tipoNomina } });
const sync = async (item: SourceKey) => {
  await reconcileKey(pool, async key => records.get(recordId(key)), item);
  // Seed the native fixture once; frozen reconciliation never overwrites native edits.
  const source = records.get(recordId(item));
  if (source && item.SK.startsWith('PAYROLL#')) {
    await insertPayslip(owner,source.payload as unknown as typeof baseline,String(source.ingestedAt),source.source as never); return;
  }
  if (!source || !item.SK.startsWith('MONTH#') || (await sql.query('SELECT month FROM olbia.month_plans WHERE month=$1',[source.month])).rows.length) return;
  const payload = source.payload as any;
  await sql.query('INSERT INTO olbia.month_plans VALUES ($1,$2,$3)',[source.month,source.owner,payload.updatedAt]);
  for (const [order,payment] of payload.upcomingPayments.entries()) await sql.query('INSERT INTO olbia.planned_payments VALUES ($1,$2,$3,$4,$5,$6)',
    [source.month,payment.id,payment.name,payment.amountMinor,payment.dueDay,order]);
};

beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await prepareNativeLedgerFixture(sql);
  await prepareNativeWealthFixture(sql);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) };
}, 30_000);
afterAll(async () => { await sql.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
beforeEach(async () => {
  records = new Map();
  await sql.exec(`TRUNCATE olbia.projection_state,olbia.month_plans,olbia.planned_payments,olbia.payslips,olbia.payslip_lines,${[...TABLE_NAMES,...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts',...NATIVE_WEALTH_TABLES,'bank_imports','bank_import_rows','bank_import_candidates'].map(table => `olbia.${table}`).join(',')}`);
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  await prepareNativeWealthFixture(sql);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.spyOn(connection,'createPool').mockReturnValue({ query: (s: string,v?: unknown[])=>sql.query(s,v),transaction: (fn: (c:SqlClient)=>Promise<unknown>)=>sql.transaction(c=>fn(c as unknown as SqlClient)) } as never);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.spyOn(application, 'applicationStoreClient').mockImplementation(()=>application.currentStoreTransaction() ?? sql);
  vi.spyOn(sqlReaders, 'readerPool').mockImplementation(()=>application.currentStoreTransaction() ?? sql);
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
    const native = (await readSqlPayslipRecord(owner,'2026-07',baseline.uuid,sql))!;
    put({ ...key,owner,month:'2026-07',uuid:baseline.uuid,payload:native.payslip,ingestedAt:native.ingestedAt,source:native.source });
    const planned = plan('2026-07'); put(planned); await sync(planned); await sync(key);
    vi.mocked(S3Client.prototype.send).mockResolvedValue({ Body: { transformToByteArray: async () => Buffer.from(fixture) } } as never);
    const verified = await verifyPlanningReads(owner, [], ['2026-07', '2026-10'], now);
    expect(verified).toMatchObject({ storedPlans: 1, storedPayroll: 1, details: 1, evidenceFiles: 1, mismatches: 0 });
    const extraXml = fixture.replace(baseline.uuid,'22222222-2222-2222-2222-222222222222');
    expect((await ingestNominaXml(owner,'native-only.xml',extraXml)).status).toBe('created');
    const extraHash = createHash('sha256').update(extraXml).digest('hex');
    vi.mocked(S3Client.prototype.send).mockImplementation(async (command:any)=>({Body:{transformToByteArray:async()=>
      Buffer.from(String(command.input.Key).endsWith(`${extraHash}.xml`) ? extraXml : fixture)}}) as never);
    expect(await verifyPlanningReads(owner,[],['2026-07','2026-10'],now)).toMatchObject({storedPayroll:2,frozenPayroll:1,
      payrollLines:baseline.lines.length*2,evidenceFiles:2,mismatches:0});
    const corrupt = { ...records.get(recordId(key))!, payload: { ...baseline, totalMinor: baseline.totalMinor + 1 } };
    await sql.query('UPDATE olbia.payroll SET source_item=$1 WHERE source_pk=$2 AND source_sk=$3', [JSON.stringify(corrupt), key.PK, key.SK]);
    expect((await verifyPlanningReads(owner, [], ['2026-07', '2026-10'], now)).mismatches).toBeGreaterThan(0);
    expect(await getPayslip(owner, '2026-07', baseline.uuid)).toMatchObject({ totalMinor: baseline.totalMinor });
  });
  it('keeps native history and XML identity through duplicate or stale frozen backfill/replay', async () => {
    const items = [plan('2026-09'), payroll('2026-09', 'B'), payroll('2026-09', 'A', '30')];
    for (const item of items) { put(item); await sync(item); await sync(item); }
    expect((await sql.query('SELECT source_item FROM olbia.monthly_plans')).rows).toEqual([{ source_item: items[0] }]);
    expect((await sql.query('SELECT count(*) AS count FROM olbia.payroll')).rows).toEqual([{ count: 2 }]);
    expect(await getPayslip(owner, '2026-09', uid('A').toLowerCase())).toMatchObject({ uuid: uid('A'), source: items[2].source, ingestedAt: items[2].ingestedAt, lines: baseline.lines });
    for (const item of items) expect(await verifyKey(pool, async key => records.get(recordId(key)), item)).toBe('equal');
    const updated = { ...items[2], source: { ...items[2].source as object, key: 'corrected-evidence' } };
    put(updated);
    expect(await getPayslip(owner, '2026-09', uid('A'))).toMatchObject({ source: items[2].source });
    await sync(updated);
    expect(await verifyKey(pool, async key => records.get(recordId(key)), updated)).toBe('equal');
    records.delete(recordId(updated)); await sync(updated); await sync(updated);
    expect(await getPayslip(owner, '2026-09', uid('A'))).toMatchObject({ source: items[2].source });
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
    expect((await listPayslipsForMonth(owner, '2026-09')).map(slip => slip.uuid)).toEqual(['B','A','C'].map(uid));
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ provisionalActive: true, incomeMinor: baseline.totalMinor * 2 });
    expect(await incomeFieldsForMonth(owner, '2026-08', now)).toMatchObject({ configured: false, incomeMinor: 0 });
    const first = payroll('2026-10', 'D'); put(first);
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ provisionalActive: true, incomeMinor: baseline.totalMinor * 2 });
    await sync(first);
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ estimateActive: true, provisionalActive: false, incomeMinor: baseline.totalMinor * 2 });
    const extra = payroll('2026-10', 'E', '16', 'E'); put(extra); await sync(extra);
    const fields = await incomeFieldsForMonth(owner, '2026-10', now);
    expect(fields).toMatchObject({ estimateActive: true, incomeMinor: baseline.totalMinor * 3 });
    expect(deriveMonthCompensation(fields)).toMatchObject({ fondoMinor: 1141800, estimatedFondoMinor: 570900, compensationMinor: baseline.totalMinor * 3 + 1712700 });
    const second = payroll('2026-10', 'F', '30'); put(second); await sync(second);
    expect(await incomeFieldsForMonth(owner, '2026-10', now)).toMatchObject({ estimateActive: false, incomeMinor: baseline.totalMinor * 3 });
    const sourcePlan = await getMonthlyPlanFromReads(owner, '2026-10', readSqlPlanRecord,
      (owner, month) => incomeFieldsForMonth(owner, month, now, listFrozenPayslips));
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

  it('makes imports immediately authoritative and duplicate receipts immutable without document claims or fallback', async () => {
    expect((await ingestNominaXml(owner,'source.xml',fixture)).status).toBe('created');
    expect(await readSqlPayslipsForMonth(owner,'2026-07',sql)).toEqual([baseline]);
    const before = await getPayslip(owner,'2026-07',baseline.uuid);
    expect((await ingestNominaXml(owner,'again.xml',fixture)).status).toBe('duplicate');
    expect(await getPayslip(owner,'2026-07',baseline.uuid.toLowerCase())).toEqual(before);
    expect([...records.values()].filter(item=>item.SK.startsWith('PAYROLL#') || item.PK.startsWith('DEDUPE#CFDI_NOMINA#'))).toHaveLength(0);
    expect(vi.mocked(S3Client.prototype.send).mock.calls).toHaveLength(1);
    vi.spyOn(sqlReaders,'readerPool').mockImplementation(()=>{throw new Error('SQL down');});
    // The writer identity remains available for duplicate preflight; a product read failure cannot substitute frozen records.
    expect((await ingestNominaXml(owner,'again.xml',fixture)).status).toBe('duplicate');
    await expect(getPayslip(owner,'2026-07',baseline.uuid)).rejects.toThrow('SQL down');
    vi.mocked(sqlReaders.readerPool).mockClear();
    await expect(incomeFieldsForMonth(owner,'2026-10',now)).rejects.toThrow('SQL down');
    expect(sqlReaders.readerPool).toHaveBeenCalledTimes(1);
  });

  it('preserves native receipts through failed frozen replay and propagates SQL errors across obsolete modes', async () => {
    const item = payroll('2026-09', 'A'); put(item); await sync(item);
    put({ ...item, payload: { ...item.payload as object, totalMinor: 1.5 } });
    await expect(sync(item)).rejects.toThrow('Invalid projection integer');
    expect((await readSqlPayslipsForMonth(owner, '2026-09', sql))[0].totalMinor).toBe(baseline.totalMinor);
    const fresh = plan('2026-10'); put(fresh);
    const interrupted: TransactionPool = { transaction: callback => sql.transaction(async client => { await callback(client as unknown as SqlClient); throw new Error('before commit'); }) };
    await expect(reconcileKey(interrupted, async () => fresh, fresh)).rejects.toThrow('before commit');
    expect(await readSqlPlanRecord(owner, '2026-10', sql)).toBeUndefined();
    for (const mode of ['dynamodb','invalid','shadow','guarded-sql']) {
      vi.stubEnv('DSQL_PLANNING_READ_MODE',mode);
      expect((await readSqlPayslipsForMonth(owner,'2026-09',sql))[0].totalMinor).toBe(baseline.totalMinor);
    }
    vi.mocked(sqlReaders.readerPool).mockImplementation(()=>{throw new Error('SQL unavailable');});
    await expect(listPayslipsForMonth(owner,'2026-09')).rejects.toThrow('SQL unavailable');
  });

  it('verifies frozen evidence across empty paginated pages while operational payroll uses native SQL', async () => {
    const item=payroll('2026-07',baseline.uuid,'31');put(item);await sync(item);
    vi.mocked(S3Client.prototype.send).mockResolvedValue({Body:{transformToByteArray:async()=>Buffer.from(fixture)}} as never);
    const send=vi.mocked(DynamoDBDocumentClient.prototype.send);
    send.mockResolvedValueOnce({Items:[]} as never)
      .mockResolvedValueOnce({Items:[],LastEvaluatedKey:{PK:item.PK,SK:item.SK}} as never)
      .mockResolvedValueOnce({Items:[item]} as never);
    expect(await verifyPlanningReads(owner,[],['2026-07','2026-10'],now)).toMatchObject({storedPayroll:1,frozenPayroll:1,mismatches:0});
    expect(send.mock.calls.slice(0,3).map(([command])=>command.input)).toMatchObject([
      {ConsistentRead:true},{ConsistentRead:true},{ConsistentRead:true,ExclusiveStartKey:{PK:item.PK,SK:item.SK}},
    ]);
  });
});
