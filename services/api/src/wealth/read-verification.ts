import { addCalendarMonths, dayKeyInZone, type WealthSnapshot } from '@finance/domain';
import { readerPool, withLedgerVerificationSnapshot } from '../events/sql-reads.js';
import { verifyWealthEvidence } from './evidence-verification.js';
import { samePublicResult } from '../events/read-selection.js';
import { listPayslipsForYear } from '../imports/cfdi-nomina-flow.js';
import { readSqlPayslipsForYear } from '../months/sql-reads.js';
import { listCategories } from '../categories/service.js';
import { loadCategorizedMonthsEvents } from '../analytics/events.js';
import { buildMonthlyCloseFacts, monthCloseDay } from '../reports/monthly-close.js';
import { renderMonthEndBalanceReminder } from '../reports/month-end-balance-reminder.js';
import { investmentHistoryFromSnapshots, portfolioSnapshotsFromAccounts } from '../agent/investment-history.js';
import { getWealthOverview, getWealthOverviewAsOf, getWealthOverviewsAsOf } from './service.js';
import { readNativeWealthInputs, readNativeWealthAudit, nativeAssetReadStatement, nativeLiabilityReadStatement, nativeAssetAuditReadStatement, nativeLiabilityAuditReadStatement, type NativeWealthInputsReader } from './native-reads.js';
import { readIndependentWealthState, verifyWealthRecovery } from './native-verification.js';

/** Independent complete content, finances, investment series and original evidence gate.
 * No guard may replace these explicit SQL reads. No report/notification is sent. */
const verifyWealthSnapshot = async (owner: string, financialMonths: readonly string[], now: Date) => {
  const started = Date.now(), client = readerPool();
  const state = await readIndependentWealthState(owner, client), recovery = await verifyWealthRecovery(owner, client, state);
  const source = state.inputs, sql = await readNativeWealthInputs(owner, client);
  let mismatches = state.mismatches + recovery.mismatches;
  mismatches += Number(!samePublicResult(source, sql));
  mismatches += Number(!samePublicResult(state.audit, await readNativeWealthAudit(owner, client)));
  const sourceReader: NativeWealthInputsReader = async () => source, sqlReader: NativeWealthInputsReader = async () => sql;
  const days = new Set([...state.assetFacts.values(), ...state.liabilityFacts.values()].map(item => item.day));
  const months = new Set([...financialMonths, ...[...days].map(day => day.slice(0, 7)), dayKeyInZone(now).slice(0, 7)]);
  const firstMonth = [...months].sort()[0]!, lastMonth = [...months].sort().at(-1)!;
  for (let month = addCalendarMonths(firstMonth, -1); month <= addCalendarMonths(lastMonth, 1); month = addCalendarMonths(month, 1)) months.add(month);
  for (const month of months) { days.add(`${month}-01`); days.add(monthCloseDay(month)); }
  const yearPayroll = new Map(await Promise.all([...new Set([...days].map(day => day.slice(0, 4)))].map(async year => {
    const sourceSlips = await listPayslipsForYear(owner, year), sqlSlips = await readSqlPayslipsForYear(owner, year);
    mismatches += Number(!samePublicResult(sourceSlips, sqlSlips));
    return [year, { source: sourceSlips, sql: sqlSlips }] as const;
  })));
  const sourcePayroll: typeof listPayslipsForYear = async (_owner, year) => yearPayroll.get(year)?.source ?? [];
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
    const build = (reader: NativeWealthInputsReader, payroll: typeof sourcePayroll) => buildMonthlyCloseFacts(owner, month, now, {
      loadEvents: async () => events, loadCategories: async () => categories,
      loadWealthAsOf: (_owner, day) => getWealthOverviewAsOf(owner, day, payroll, reader),
      loadWealthAsOfDays: (_owner, days) => getWealthOverviewsAsOf(owner, days, payroll, reader),
    });
    mismatches += Number(!samePublicResult(await build(sourceReader, sourcePayroll), await build(sqlReader, sqlPayroll))); reports++;
  }
  mismatches += Number(!samePublicResult(await getWealthOverview(owner, now), await getWealthOverview(owner, now, sqlPayroll, sqlReader)));
  const queryPlans = [];
  for (const [query, statement] of [['asset-captures', nativeAssetReadStatement], ['liability-captures', nativeLiabilityReadStatement], ['asset-history', nativeAssetAuditReadStatement], ['liability-history', nativeLiabilityAuditReadStatement]]) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, [owner]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line)).map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  return { mode: 'native-sql', storedSnapshots: sql.snapshots.length, storedVersions: state.audit.filter(r => r.kind === 'asset').length,
    storedLiabilities: sql.liabilitySnapshots.length, storedLiabilityVersions: state.audit.filter(r => r.kind === 'liability').length, cards: sql.cards.length,
    captures: state.captures, holdings: state.holdings, replacements: state.replacements, validatedConstraints: state.validatedConstraints,
    recoveryAssertions: recovery.assertions, recoveryMismatches: recovery.mismatches,
    asOfDays, dailyOverviews, months: months.size, investmentChecks, reports, reminders,
    mismatches, elapsedMs: Date.now() - started, queryPlans,
    evidenceAssertions: [...state.assetFacts.values(), ...state.liabilityFacts.values()].map(snapshot => ({ owner, snapshot })) };
};

/** Close the SQL snapshot before original object IO; public verification returns aggregate proofs only. */
export const verifyWealthReads = async (owner: string, financialMonths: readonly string[], now: Date) => {
  const started = Date.now();
  const { evidenceAssertions, ...facts } = await withLedgerVerificationSnapshot(() => verifyWealthSnapshot(owner, financialMonths, now));
  const evidence = await verifyWealthEvidence(evidenceAssertions);
  return { ...facts, evidence, evidenceFiles: evidence.evidenceFiles, mismatches: facts.mismatches + evidence.mismatches, elapsedMs: Date.now() - started };
};
