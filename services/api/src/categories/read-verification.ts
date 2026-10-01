import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { aggregateSpendByCategory, aggregateSpendByMerchant, resolveCategoryId, daysInCalendarMonth,
  cardRemindersForDay, cardCyclePushMessage, dailyBalancePushMessage, addCalendarMonths, type PayslipSummary } from '@finance/domain';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { readerPool } from '../events/sql-reads.js';
import { samePublicResult } from '../events/read-selection.js';
import { feedFromPayloads } from '../events/month-feed.js';
import { listCategoriesDynamo, listMerchantRulesDynamo, readCategoryRecordsDynamo } from './source-reads.js';
import { readSqlCategories, readSqlMerchantRules, domainReadMode, categoryReadStatement, ruleReadStatement,
  listCategories, listMerchantRules } from './sql-reads.js';
import { listCards, listCardsDynamo } from '../cards/cards.js';
import { readSqlCards, cardReadStatement } from '../cards/sql-reads.js';
import { deduplicateFeed } from '../analytics/events.js';
import { summarizeMonthFeed } from '../months/summary.js';
import { getMonthlyPlan } from '../months/service.js';
import { readSourceWealthInputs, readSqlWealthInputs, type WealthInputsReader } from '../wealth/sql-reads.js';
import { getWealthOverviewsAsOf } from '../wealth/service.js';
import { listPayslipsForYearDynamo } from '../imports/cfdi-nomina-flow.js';
import { readSqlPayslipsForYear } from '../months/sql-reads.js';
import { buildMonthlyCloseFacts } from '../reports/monthly-close.js';
import { fallbackMonthlyCloseAnalysis } from '../reports/monthly-close-analysis.js';
import { renderMonthlyCloseEmail } from '../reports/monthly-close-email.js';
import { spendingRangeFromEvents } from '../agent/spending-range.js';

/** Independent SQL/source content and worker calculations. Never send notifications or use fallback to pass parity. */
export const verifyDomainReads = async (owner: string, movements: readonly JsonObject[], financialMonths: readonly string[], now: Date) => {
  const started = Date.now(), client = readerPool();
  const [categories, rules, sqlCategories, sqlRules, cards, sqlCards, categoryRecords, ruleRecords] = await Promise.all([
    listCategoriesDynamo(), listMerchantRulesDynamo(), readSqlCategories(client), readSqlMerchantRules(client),
    listCardsDynamo({ database, tableName, owner }), readSqlCards(owner, client), readCategoryRecordsDynamo(), readCategoryRecordsDynamo(true),
  ]);
  let mismatches = 0;
  const check = (source: unknown, sql: unknown) => { mismatches += Number(!samePublicResult(source, sql)); };
  check(categories, sqlCategories); check(rules, sqlRules); check(cards, sqlCards);
  // Independent promoted columns and original rule envelope; not the projector's own transformation as oracle.
  const categoryRows = (await client.query("SELECT * FROM olbia.categories WHERE source_pk='CATEGORY_CATALOG' ORDER BY source_sk")).rows;
  check(categoryRows, [...categories].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).map(c => ({
    source_pk: 'CATEGORY_CATALOG', source_sk: `CAT#${c.id}`, row_id: c.id, id: c.id, name: c.name, sort_order: c.sortOrder, payload: c,
  })));
  const ruleRows = (await client.query("SELECT * FROM olbia.merchant_category_rules WHERE source_pk='CATEGORY_RULES' ORDER BY source_sk")).rows;
  check(ruleRows, ruleRecords.map(item => ({ source_pk: item.PK, source_sk: item.SK, row_id: item.id,
    id: item.id, merchant_key: item.merchantKey, category_id: item.categoryId ?? null, payload: item })));
  const sourceCards: JsonObject[] = [];
  for await (const page of paginateQuery({ client: database }, { TableName: tableName, ConsistentRead: true,
    KeyConditionExpression: 'PK=:pk AND begins_with(SK,:prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${owner}`, ':prefix': 'CARD#' } })) sourceCards.push(...page.Items ?? []);
  const cardRows = (await client.query('SELECT * FROM olbia.cards WHERE source_pk=$1 ORDER BY source_sk', [`USER#${owner}`])).rows;
  check(cardRows, sourceCards.map(item => { const p = item.payload as JsonObject; return {
    source_pk: item.PK, source_sk: item.SK, row_id: p.id, id: p.id, owner: item.owner, name: p.name,
    cut_off_day: p.cutOffDay, payment_due_day: p.paymentDueDay, payload: p, source_item: item,
  }; }));
  const sqlMovements = (await client.query('SELECT payload FROM olbia.movements')).rows.map(row => row.payload as JsonObject);
  const merchants = new Set([...movements.map(m => String(m.merchantRaw)), ...rules.map(r => r.merchantKey),
    ...rules.filter(r => r.pattern).map(r => `prefix ${r.pattern} suffix`)]);
  for (const merchant of merchants) check(resolveCategoryId(merchant, rules), resolveCategoryId(merchant, sqlRules));
  const sourceWealth = await readSourceWealthInputs(owner), sqlWealth = await readSqlWealthInputs(owner, client);
  const sourceReader: WealthInputsReader = async () => sourceWealth, sqlReader: WealthInputsReader = async () => sqlWealth;
  const months = [...new Set([...financialMonths, '2026-02', '2028-02'])].sort();
  const years = [...new Set(months.flatMap(month => [month.slice(0, 4), addCalendarMonths(month, -3).slice(0, 4)]))];
  const payroll = new Map<string, { source: readonly PayslipSummary[]; sql: readonly PayslipSummary[] }>();
  for (const year of years) payroll.set(year, { source: await listPayslipsForYearDynamo(owner, year), sql: await readSqlPayslipsForYear(owner, year, client) });
  const sourcePayroll: typeof listPayslipsForYearDynamo = async (_owner, year) => payroll.get(year)?.source ?? [];
  const sqlPayroll: typeof listPayslipsForYearDynamo = async (_owner, year) => payroll.get(year)?.sql ?? [];
  let reports = 0, dailyMessages = 0, cycleDays = 0, cycleMessages = 0, assistantChecks = 0;
  const url = 'https://finance.castrodavid.dev/';
  for (const month of months) {
    const requested = [month, ...[1, 2, 3].map(offset => addCalendarMonths(month, -offset))];
    const sourceEvents = deduplicateFeed(feedFromPayloads(requested, movements));
    const sqlEvents = deduplicateFeed(feedFromPayloads(requested, sqlMovements));
    check(sourceEvents, sqlEvents);
    const names = new Map(categories.map(c => [c.id, c.name])), sqlNames = new Map(sqlCategories.map(c => [c.id, c.name]));
    check(aggregateSpendByCategory(sourceEvents, month, names), aggregateSpendByCategory(sqlEvents, month, sqlNames));
    check(aggregateSpendByMerchant(sourceEvents, month), aggregateSpendByMerchant(sqlEvents, month));
    check(spendingRangeFromEvents(sourceEvents, { range: 'custom', fromDay: `${month}-01`, toDay: `${month}-${String(daysInCalendarMonth(month)).padStart(2, '0')}` }, now),
      spendingRangeFromEvents(sqlEvents, { range: 'custom', fromDay: `${month}-01`, toDay: `${month}-${String(daysInCalendarMonth(month)).padStart(2, '0')}` }, now)); assistantChecks += 3;
    const build = (events: typeof sourceEvents, catalog: typeof categories, reader: WealthInputsReader, slips: typeof sourcePayroll) =>
      buildMonthlyCloseFacts(owner, month, now, { loadEvents: async () => events, loadCategories: async () => catalog,
        loadWealthAsOf: async (_owner, day) => (await getWealthOverviewsAsOf(owner, [day], slips, reader))[0]!,
        loadWealthAsOfDays: (_owner, days) => getWealthOverviewsAsOf(owner, days, slips, reader) });
    const sourceFacts = await build(sourceEvents, categories, sourceReader, sourcePayroll);
    const sqlFacts = await build(sqlEvents, sqlCategories, sqlReader, sqlPayroll);
    check(sourceFacts, sqlFacts);
    check(renderMonthlyCloseEmail(sourceFacts, fallbackMonthlyCloseAnalysis(sourceFacts), url),
      renderMonthlyCloseEmail(sqlFacts, fallbackMonthlyCloseAnalysis(sqlFacts), url)); reports++;
    // Planning has its own independent gate; share the selected plan so only this phase's movement input varies.
    const plan = await getMonthlyPlan(owner, month);
    for (let day = 1; day <= daysInCalendarMonth(month); day++) {
      const dayKey = `${month}-${String(day).padStart(2, '0')}`, clock = new Date(`${dayKey}T13:00:00.000Z`);
      const sourceSummary = summarizeMonthFeed(month, plan, feedFromPayloads([month], movements), clock);
      const sqlSummary = summarizeMonthFeed(month, plan, feedFromPayloads([month], sqlMovements), clock);
      check(sourceSummary, sqlSummary);
      for (const mode of ['amounts', 'private'] as const) {
        check(dailyBalancePushMessage(sourceSummary, mode, url, dayKey), dailyBalancePushMessage(sqlSummary, mode, url, dayKey)); dailyMessages++;
      }
      const due = cardRemindersForDay(cards, month, day), sqlDue = cardRemindersForDay(sqlCards, month, day);
      check(due, sqlDue); cycleDays++;
      for (const mode of ['amounts', 'private'] as const) {
        check(due.map(reminder => cardCyclePushMessage(reminder, mode, url, dayKey)), sqlDue.map(reminder => cardCyclePushMessage(reminder, mode, url, dayKey)));
        cycleMessages += due.length;
      }
    }
  }
  // Configured readers checked after independent comparisons; fallback never conceals corrupt SQL above.
  check(categories, await listCategories()); check(rules, await listMerchantRules()); check(cards, await listCards({ database, tableName, owner }));
  const queryPlans = [];
  for (const [query, statement, values] of [['categories', categoryReadStatement, []], ['merchant-rules', ruleReadStatement, []],
    ['cards', cardReadStatement, [`USER#${owner}`]]] as const) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, [...values]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line)).map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  return { mode: domainReadMode(), persistedCategories: categoryRecords.length, effectiveCategories: categories.length,
    rules: rules.length, cards: cards.length, merchantChecks: merchants.size, months: months.length, assistantChecks,
    reports, dailyMessages, cycleDays, cycleMessages, mismatches, elapsedMs: Date.now() - started, queryPlans };
};
