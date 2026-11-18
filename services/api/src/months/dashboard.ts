import { aggregateSpendByCategory, budgetMonth, monthDashboardLiquidity } from '@finance/domain';
import { deduplicateFeed } from '../analytics/events.js';
import { readerPool, readSqlFeed, withLedgerReadSnapshot } from '../events/sql-reads.js';
import { budgetStatusFromMonth } from '../financial-plans/budgets.js';
import { incomeFieldsForMonth } from '../imports/cfdi-nomina-flow.js';
import { getMonthlyPlanFromReads } from './service.js';
import { readSqlPlanRecord } from './sql-reads.js';
import { summarizeMonthFeed } from './summary.js';

/** One authenticated read snapshot for the web dashboard and the month_snapshot tool. */
export const getMonthDashboard = (owner: string, inputMonth: string, now = new Date()) => {
  const month = budgetMonth(inputMonth);
  return withLedgerReadSnapshot(async () => {
    const client = readerPool();
    const [feed, record] = await Promise.all([readSqlFeed([month], client), readSqlPlanRecord(owner, month, client)]);
    const [plan, budget] = await Promise.all([
      getMonthlyPlanFromReads(owner, month, async () => record, () => incomeFieldsForMonth(owner, month, now)),
      budgetStatusFromMonth(client, owner, month, now, feed, record, true),
    ]);
    const summary = summarizeMonthFeed(month, plan, feed, now);
    const { uncategorizedMinor, uncategorizedEventCount } = aggregateSpendByCategory(deduplicateFeed(feed), month, new Map());
    return {
      month,
      generatedAt: now.toISOString(),
      summary,
      budget,
      liquidity: monthDashboardLiquidity(summary, plan, record !== undefined),
      knownMsiSchedulesOnly: true,
      uncategorizedMinor,
      uncategorizedEventCount,
    };
  });
};
