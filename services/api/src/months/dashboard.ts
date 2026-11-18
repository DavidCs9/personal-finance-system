import { aggregateSpendByCategory, budgetMonth, cashBalanceCutoffDay, daysInCalendarMonth, monthCashLiquidity,
  monthDashboardLiquidity, monthDashboardSpending, payrollEmployerKey, payrollFundReconciliation, summarizePostedCredits } from '@finance/domain';
import { readBankCreditsForMonth } from '@finance/ledger/native-ledger';
import { deduplicateFeed } from '../analytics/events.js';
import { readerPool, readSqlFeed, withLedgerReadSnapshot } from '../events/sql-reads.js';
import { budgetStatusFromMonth } from '../financial-plans/budgets.js';
import { getMonthFutureIncome } from '../financial-plans/service.js';
import { incomeFieldsForMonth } from '../imports/cfdi-nomina-flow.js';
import { readPayrollClosures } from '../imports/payroll-closures.js';
import { readCashBalances } from '../wealth/native-reads.js';
import { getMonthlyPlanFromReads } from './service.js';
import { readSqlPlanRecord } from './sql-reads.js';
import { summarizeMonthFeed } from './summary.js';

/** One authenticated read snapshot for the web dashboard and the month_snapshot tool. */
export const getMonthDashboard = (owner: string, inputMonth: string, now = new Date()) => {
  const month = budgetMonth(inputMonth);
  return withLedgerReadSnapshot(async () => {
    const client = readerPool();
    const cutoffDay = cashBalanceCutoffDay(month, now);
    const [feed, record, credits, balances, payrollClosures] = await Promise.all([
      readSqlFeed([month], client), readSqlPlanRecord(owner, month, client),
      readBankCreditsForMonth(client, owner, `${month}-01`, `${month}-${daysInCalendarMonth(month)}`),
      readCashBalances(owner, cutoffDay, client), readPayrollClosures(owner, client),
    ]);
    const [plan, budget] = await Promise.all([
      getMonthlyPlanFromReads(owner, month, async () => record, () => incomeFieldsForMonth(owner, month, now)),
      budgetStatusFromMonth(client, owner, month, now, feed, record, true),
    ]);
    const summary = summarizeMonthFeed(month, plan, feed, now);
    const { uncategorizedMinor, uncategorizedEventCount } = aggregateSpendByCategory(deduplicateFeed(feed), month, new Map());
    const fundCredits = new Map(credits.filter(credit => credit.creditType === 'fund_release')
      .map(credit => [credit.fundEmployerKey, credit]));
    const fundClosures = payrollClosures.map(closure => ({ closure, key: payrollEmployerKey(closure.employerName) }))
      .filter(({ closure, key }) => closure.fundPaidOn.startsWith(`${month}-`) || fundCredits.has(key))
      .map(({ closure, key }) => payrollFundReconciliation(closure, key, fundCredits.get(key)));
    return {
      month,
      generatedAt: now.toISOString(),
      summary: { ...summary, remainingMinor: null, projectedRemainingMinor: null },
      budget,
      spending: monthDashboardSpending(summary, budget),
      liquidity: monthDashboardLiquidity(summary, plan, record !== undefined),
      cash: monthCashLiquidity(month, now, balances),
      postedCredits: summarizePostedCredits(credits),
      futureIncome: await getMonthFutureIncome(owner, month, now, credits.some(credit => credit.creditType === 'income' && credit.incomeType !== 'finiquito')),
      payrollFundClosures: fundClosures,
      knownMsiSchedulesOnly: true,
      uncategorizedMinor,
      uncategorizedEventCount,
    };
  });
};
