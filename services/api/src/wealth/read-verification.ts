import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { addCalendarMonths, dayKeyInZone, type WealthSnapshot } from '@finance/domain';
import { s3 } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { readerPool } from '../events/sql-reads.js';
import { samePublicResult } from '../events/read-selection.js';
import { listPayslipsForYearDynamo } from '../imports/cfdi-nomina-flow.js';
import { readSqlPayslipsForYear } from '../months/sql-reads.js';
import { listCategories } from '../categories/service.js';
import { loadCategorizedMonthsEvents } from '../analytics/events.js';
import { buildMonthlyCloseFacts, monthCloseDay } from '../reports/monthly-close.js';
import { renderMonthEndBalanceReminder } from '../reports/month-end-balance-reminder.js';
import { investmentHistoryFromSnapshots, portfolioSnapshotsFromAccounts } from '../agent/investment-history.js';
import { getWealthOverview, getWealthOverviewAsOf, getWealthOverviewsAsOf } from './service.js';
import { readSourceWealthInputs, readSqlWealthInputs, readSourceWealthRecords, readSqlWealthAudit,
  readWealthAudit, wealthReadMode, wealthReadStatement, wealthAuditStatement, type WealthInputsReader } from './sql-reads.js';

const normalizedDate = (value: unknown): unknown => value instanceof Date ? value.toISOString() : value;
const storedSnapshotMatches = (row: JsonObject, item: JsonObject, version: boolean, wealth: boolean): boolean => {
  const expected: JsonObject = { owner: item.owner, day: item.day, captured_at: item.capturedAt,
    source: item.source, currency: item.currency, total_mxn_minor: String(item.totalMxnMinor),
    evidence: item.evidence ?? null, payload: item, source_item: item,
    row_id: version ? item.versionId : item.SK, source_pk: item.PK, source_sk: item.SK,
    ...(wealth ? { account_id: item.accountId, holdings: item.holdings, fx_rate: item.fxRate ?? null, fx_source: item.fxSource ?? null } : { card_id: item.cardId }),
    ...(version ? { version_id: item.versionId, superseded_at: item.supersededAt } : {}) };
  const actual = { ...row, captured_at: normalizedDate(row.captured_at),
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : row.day,
    total_mxn_minor: String(row.total_mxn_minor),
    ...(wealth ? { fx_rate: row.fx_rate == null ? null : Number(row.fx_rate) } : {}),
    ...(version ? { superseded_at: normalizedDate(row.superseded_at) } : {}) };
  return samePublicResult(actual, expected);
};

/** Independent complete content, finances, investment series and original evidence gate.
 * No guard may replace these explicit SQL reads. No report/notification is sent. */
export const verifyWealthReads = async (owner: string, financialMonths: readonly string[], now: Date) => {
  const started = Date.now(), client = readerPool();
  const sourceRecords = await readSourceWealthRecords(owner);
  const projected: JsonObject[] = [];
  let mismatches = 0;
  const tables = ['wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions', 'cards'];
  for (const table of tables) {
    const rows = (await client.query(`SELECT * FROM olbia.${table} WHERE source_pk=$1`, [`USER#${owner}`])).rows;
    for (const row of rows) {
      const item = sourceRecords.find(item => item.PK === row.source_pk && item.SK === row.source_sk);
      projected.push(row.source_item as JsonObject);
      if (!item) { mismatches++; continue; }
      mismatches += Number(table === 'cards' ? !samePublicResult(row.payload, item.payload)
        || row.id !== (item.payload as JsonObject).id || row.owner !== item.owner
        || row.name !== (item.payload as JsonObject).name || row.cut_off_day !== (item.payload as JsonObject).cutOffDay
        || row.payment_due_day !== (item.payload as JsonObject).paymentDueDay
        : !storedSnapshotMatches(row, item, table.endsWith('_versions'), table.startsWith('wealth_')));
    }
  }
  const sorted = (records: JsonObject[]) => [...records].sort((a, b) => String(a?.SK).localeCompare(String(b?.SK)));
  mismatches += Number(!samePublicResult(sorted(sourceRecords), sorted(projected)));
  const source = await readSourceWealthInputs(owner), sql = await readSqlWealthInputs(owner, client);
  mismatches += Number(!samePublicResult(source, sql));
  const sourceReader: WealthInputsReader = async () => source, sqlReader: WealthInputsReader = async () => sql;
  const sourceAudit = sourceRecords.filter(item => /^(WEALTH|LIAB)_VER#/.test(String(item.SK)));
  mismatches += Number(!samePublicResult(sourceAudit, await readSqlWealthAudit(owner, client)));
  mismatches += Number(!samePublicResult(sourceAudit, await readWealthAudit(owner)));
  const dayOf = (item: JsonObject) => typeof item.day === 'string' ? item.day : undefined;
  const days = new Set(sourceRecords.map(dayOf).filter((day): day is string => !!day));
  const months = new Set([...financialMonths, ...[...days].map(day => day.slice(0, 7)), dayKeyInZone(now).slice(0, 7)]);
  const firstMonth = [...months].sort()[0]!, lastMonth = [...months].sort().at(-1)!;
  for (let month = addCalendarMonths(firstMonth, -1); month <= addCalendarMonths(lastMonth, 1); month = addCalendarMonths(month, 1)) months.add(month);
  for (const month of months) { days.add(`${month}-01`); days.add(monthCloseDay(month)); }
  const yearPayroll = new Map(await Promise.all([...new Set([...days].map(day => day.slice(0, 4)))].map(async year => {
    const sourceSlips = await listPayslipsForYearDynamo(owner, year), sqlSlips = await readSqlPayslipsForYear(owner, year);
    mismatches += Number(!samePublicResult(sourceSlips, sqlSlips));
    return [year, { source: sourceSlips, sql: sqlSlips }] as const;
  })));
  const sourcePayroll: typeof listPayslipsForYearDynamo = async (_owner, year) => yearPayroll.get(year)?.source ?? [];
  const sqlPayroll: typeof readSqlPayslipsForYear = async (_owner, year) => yearPayroll.get(year)?.sql ?? [];
  let asOfDays = 0, dailyOverviews = 0, reminders = 0;
  for (const day of [...days].sort()) {
    const sourceBalance = await getWealthOverviewAsOf(owner, day, sourcePayroll, sourceReader);
    const sqlBalance = await getWealthOverviewAsOf(owner, day, sqlPayroll, sqlReader);
    mismatches += Number(!samePublicResult(sourceBalance, sqlBalance)); asOfDays++;
    // Includes per-account daily series and total monthly series under the existing algorithm.
    const clock = new Date(`${day}T18:00:00.000Z`);
    mismatches += Number(!samePublicResult(await getWealthOverview(owner, clock, sourcePayroll, sourceReader),
      await getWealthOverview(owner, clock, sqlPayroll, sqlReader))); dailyOverviews++;
    mismatches += Number(!samePublicResult(renderMonthEndBalanceReminder(sourceBalance, day.slice(0, 7), day, 'https://finance.castrodavid.dev'),
      renderMonthEndBalanceReminder(sqlBalance, day.slice(0, 7), day, 'https://finance.castrodavid.dev'))); reminders++;
  }
  let investmentChecks = 0;
  for (const account of ['bitso', 'ibkr', 'all'] as const) {
    const select = (snapshots: readonly WealthSnapshot[]) => account === 'all'
      ? portfolioSnapshotsFromAccounts(snapshots.filter(snapshot => snapshot.accountId === 'bitso' || snapshot.accountId === 'ibkr'))
      : snapshots.filter(snapshot => snapshot.accountId === account);
    const sourceSeries = select(source.snapshots), sqlSeries = select(sql.snapshots);
    mismatches += Number(!samePublicResult(sourceSeries, sqlSeries));
    if (!sourceSeries.length || !sqlSeries.length) continue;
    const queries = [ { range: 'all' as const, granularity: 'daily' as const, limit: 366 },
      { range: 'all' as const, granularity: 'monthly' as const, limit: 366 },
      ...sourceSeries.map(snapshot => ({ asOfDay: snapshot.day })),
      ...[...new Set(sourceSeries.flatMap(snapshot => snapshot.holdings.map(holding => holding.id)))].map(holdingId => ({ holdingId, range: 'all' as const, limit: 366 })),
    ];
    for (const query of queries) {
      mismatches += Number(!samePublicResult(investmentHistoryFromSnapshots(account, sourceSeries, query, now),
        investmentHistoryFromSnapshots(account, sqlSeries, query, now))); investmentChecks++;
    }
  }
  const categories = await listCategories();
  let reports = 0;
  // The report's month/day filters and staleness/zero balances are exercised with real deterministic facts.
  for (const month of [...months].sort()) {
    const before = [1, 2, 3].map(offset => addCalendarMonths(month, -offset));
    const events = await loadCategorizedMonthsEvents([month, ...before]);
    const build = (reader: WealthInputsReader, payroll: typeof sourcePayroll) => buildMonthlyCloseFacts(owner, month, now, {
      loadEvents: async () => events, loadCategories: async () => categories,
      loadWealthAsOf: (_owner, day) => getWealthOverviewAsOf(owner, day, payroll, reader),
      loadWealthAsOfDays: (_owner, days) => getWealthOverviewsAsOf(owner, days, payroll, reader),
    });
    mismatches += Number(!samePublicResult(await build(sourceReader, sourcePayroll), await build(sqlReader, sqlPayroll))); reports++;
  }
  let evidenceFiles = 0;
  const evidenceSeen = new Set<string>();
  for (const item of sourceRecords) {
    if (!item.evidence) continue;
    const evidence = item.evidence as { bucket: string; key: string; sha256: string };
    const signature = `${evidence.bucket}/${evidence.key}/${evidence.sha256}`;
    if (evidenceSeen.has(signature)) continue;
    evidenceSeen.add(signature);
    const object = await s3.send(new GetObjectCommand({ Bucket: evidence.bucket, Key: evidence.key }));
    const bytes = await object.Body!.transformToByteArray();
    mismatches += Number(createHash('sha256').update(bytes).digest('hex') !== evidence.sha256); evidenceFiles++;
  }
  // Configured freshness fallback is checked only after explicit independent comparisons.
  mismatches += Number(!samePublicResult(await getWealthOverview(owner, now), await getWealthOverview(owner, now, sqlPayroll, sqlReader)));
  const queryPlans = [];
  for (const [query, statement] of [['wealth-inputs', wealthReadStatement], ['wealth-audit', wealthAuditStatement]]) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, query === 'wealth-inputs' ? [`USER#${owner}`, owner] : [`USER#${owner}`]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line)).map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  const count = (prefix: string) => sourceRecords.filter(item => String(item.SK).startsWith(prefix)).length;
  return { mode: wealthReadMode(), storedSnapshots: count('WEALTH_SNAP#'), storedVersions: count('WEALTH_VER#'),
    storedLiabilities: count('LIAB_SNAP#'), storedLiabilityVersions: count('LIAB_VER#'), cards: count('CARD#'),
    asOfDays, dailyOverviews, months: months.size, investmentChecks, reports, reminders, evidenceFiles,
    mismatches, elapsedMs: Date.now() - started, queryPlans };
};
