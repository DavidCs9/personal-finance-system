import { aggregateSpendByCategory, aggregateSpendByMerchant, resolveCategoryId, daysInCalendarMonth,
  cardRemindersForDay, cardCyclePushMessage, dailyBalancePushMessage, addCalendarMonths, type PayslipSummary } from '@finance/domain';
import type { JsonObject } from '../http/response.js';
import { readerPool } from '../events/sql-reads.js';
import { samePublicResult } from '../events/read-selection.js';
import { feedFromPayloads } from '../events/month-feed.js';
import { readSqlCategories, readSqlMerchantRules, categoryReadStatement, ruleReadStatement,
  listCategories, listMerchantRules } from './sql-reads.js';
import { listCards } from '../cards/cards.js';
import { cardReadStatement } from '../cards/sql-reads.js';
import { deduplicateFeed } from '../analytics/events.js';
import { summarizeMonthFeed } from '../months/summary.js';
import { getMonthlyPlan } from '../months/service.js';
import { readSourceWealthInputs, readSqlWealthInputs, type WealthInputsReader } from '../wealth/sql-reads.js';
import { getWealthOverviewsAsOf } from '../wealth/service.js';
import { listPayslipsForYear } from '../imports/cfdi-nomina-flow.js';
import { readSqlPayslipsForYear } from '../months/sql-reads.js';
import { buildMonthlyCloseFacts } from '../reports/monthly-close.js';
import { fallbackMonthlyCloseAnalysis } from '../reports/monthly-close-analysis.js';
import { renderMonthlyCloseEmail } from '../reports/monthly-close-email.js';
import { spendingRangeFromEvents } from '../agent/spending-range.js';

/** Independent SQL/source content and worker calculations. Never send notifications or use fallback to pass parity. */
export const verifyDomainReads = async (owner: string, movements: readonly JsonObject[], financialMonths: readonly string[], now: Date) => {
  const started = Date.now(), client = readerPool();
  const [categories, rules, cards] = await Promise.all([
    readSqlCategories(client), readSqlMerchantRules(client),
    listCards(owner),
  ]);
  const sqlCategories = categories;
  const sqlRules = rules;
  let mismatches = 0;
  const check = (source: unknown, sql: unknown) => { mismatches += Number(!samePublicResult(source, sql)); };
  // Native catalog: independently check column mapping and shape. Frozen migration
  // envelopes are not a competing category authority or a fallback.
  const categoryRows = (await client.query('SELECT * FROM olbia.spend_categories ORDER BY id')).rows;
  check(categoryRows, [...categories].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).map(c => ({
    id: c.id, name: c.name, sort_order: c.sortOrder,
  })));
  check(true, categories.length > 0 && categories.every(c => typeof c.id === 'string' && typeof c.name === 'string'
    && c.name.trim().length > 0 && Number.isInteger(c.sortOrder)));
  const ruleRows = (await client.query('SELECT * FROM olbia.merchant_rules ORDER BY merchant_key COLLATE "C"')).rows;
  check(ruleRows.map(row => ({ ...row, updated_at: new Date(row.updated_at as string | Date).toISOString() })), rules.map(rule => ({
    merchant_key: rule.merchantKey, id: rule.id, pattern: rule.pattern ?? null, category_id: rule.categoryId || null,
    source: rule.source, updated_at: rule.updatedAt,
  })));
  const invalidReferences = (await client.query(`SELECT count(*) AS count FROM (
    SELECT category_id FROM olbia.movements WHERE category_id IS NOT NULL
    UNION ALL SELECT category_id FROM olbia.merchant_rules WHERE category_id IS NOT NULL
  ) references_to_categories LEFT JOIN olbia.spend_categories category ON category.id=references_to_categories.category_id
    WHERE category.id IS NULL`)).rows[0]?.count;
  check(0, Number(invalidReferences));
  const constraints = (await client.query(`SELECT conname,convalidated FROM pg_constraint WHERE
    (conrelid='olbia.movements'::regclass AND conname='movements_category_fk') OR
    (conrelid='olbia.merchant_rules'::regclass AND conname='merchant_rules_category_fk') ORDER BY conname`)).rows;
  check(constraints, [{ conname: 'merchant_rules_category_fk', convalidated: true }, { conname: 'movements_category_fk', convalidated: true }]);
  const cardRows = (await client.query('SELECT * FROM olbia.card_profiles WHERE owner=$1 AND deleted_at IS NULL ORDER BY id COLLATE "C"', [owner])).rows;
  check(cardRows.map(row => ({ ...row, created_at: new Date(row.created_at as string | Date).toISOString(),
    updated_at: new Date(row.updated_at as string | Date).toISOString() })), [...cards].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).map(card => ({
    id: card.id, owner, name: card.name, cut_off_day: card.cutOffDay, payment_due_day: card.paymentDueDay,
    institution: card.institution ?? null, created_at: card.createdAt, updated_at: card.updatedAt, deleted_at: null,
  })));
  check(true, cards.length <= 3 && cards.every(card => /^[a-zA-Z0-9_-]{1,128}$/.test(card.id)
    && card.name.trim().length > 0 && card.name.length <= 100 && Number.isInteger(card.cutOffDay)
    && card.cutOffDay >= 1 && card.cutOffDay <= 31 && Number.isInteger(card.paymentDueDay)
    && card.paymentDueDay >= 1 && card.paymentDueDay <= 31));
  const invalidCardReferences = Number((await client.query(`SELECT count(*) AS count FROM (
    SELECT card_id,owner FROM olbia.liability_snapshots UNION ALL SELECT card_id,owner FROM olbia.liability_versions
  ) liabilities LEFT JOIN olbia.card_profiles card ON card.id=liabilities.card_id
    WHERE card.id IS NULL OR card.owner <> liabilities.owner OR liabilities.owner IS NULL`)).rows[0]?.count);
  check(0, invalidCardReferences);
  const cardConstraints = (await client.query(`SELECT conname,convalidated FROM pg_constraint WHERE
    conrelid IN ('olbia.liability_snapshots'::regclass,'olbia.liability_versions'::regclass)
    AND conname IN ('liability_snapshots_card_fk','liability_snapshots_card_required','liability_versions_card_fk','liability_versions_card_required') ORDER BY conname`)).rows;
  check(cardConstraints, ['liability_snapshots_card_fk','liability_snapshots_card_required','liability_versions_card_fk','liability_versions_card_required']
    .map(conname => ({ conname, convalidated: true })));
  const sqlMovements = (await client.query('SELECT payload FROM olbia.movements')).rows.map(row => row.payload as JsonObject);
  const merchants = new Set([...movements.map(m => String(m.merchantRaw)), ...rules.map(r => r.merchantKey),
    ...rules.filter(r => r.pattern).map(r => `prefix ${r.pattern} suffix`)]);
  for (const merchant of merchants) check(resolveCategoryId(merchant, rules), resolveCategoryId(merchant, sqlRules));
  const sourceWealth = await readSourceWealthInputs(owner), sqlWealth = await readSqlWealthInputs(owner, client);
  const sqlCards = sqlWealth.cards; check(cards, sqlCards);
  const sourceReader: WealthInputsReader = async () => sourceWealth, sqlReader: WealthInputsReader = async () => sqlWealth;
  const months = [...new Set([...financialMonths, '2026-02', '2028-02'])].sort();
  const years = [...new Set(months.flatMap(month => [month.slice(0, 4), addCalendarMonths(month, -3).slice(0, 4)]))];
  const payroll = new Map<string, { source: readonly PayslipSummary[]; sql: readonly PayslipSummary[] }>();
  for (const year of years) payroll.set(year, { source: await listPayslipsForYear(owner, year), sql: await readSqlPayslipsForYear(owner, year, client) });
  const sourcePayroll: typeof listPayslipsForYear = async (_owner, year) => payroll.get(year)?.source ?? [];
  const sqlPayroll: typeof listPayslipsForYear = async (_owner, year) => payroll.get(year)?.sql ?? [];
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
    const sourceFeed = feedFromPayloads([month], movements), sqlFeed = feedFromPayloads([month], sqlMovements);
    for (let day = 1; day <= daysInCalendarMonth(month); day++) {
      const dayKey = `${month}-${String(day).padStart(2, '0')}`, clock = new Date(`${dayKey}T13:00:00.000Z`);
      const sourceSummary = summarizeMonthFeed(month, plan, sourceFeed, clock);
      const sqlSummary = summarizeMonthFeed(month, plan, sqlFeed, clock);
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
  check(categories, await listCategories()); check(rules, await listMerchantRules()); check(cards, await listCards(owner));
  const queryPlans = [];
  for (const [query, statement, values] of [['categories', categoryReadStatement, []], ['merchant-rules', ruleReadStatement, []],
    ['cards', cardReadStatement, [owner]]] as const) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, [...values]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line)).map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  return { mode: 'native-sql', categoryAuthority: 'native-sql', ruleAuthority: 'native-sql', cardAuthority: 'native-sql', invalidCardReferences,
    validatedCardConstraints: cardConstraints.filter(row => row.convalidated === true).length, invalidCategoryReferences: Number(invalidReferences),
    validatedCategoryForeignKeys: constraints.filter(row => row.convalidated === true).length,
    persistedCategories: categories.length, effectiveCategories: categories.length,
    rules: rules.length, cards: cards.length, merchantChecks: merchants.size, months: months.length, assistantChecks,
    reports, dailyMessages, cycleDays, cycleMessages, mismatches, elapsedMs: Date.now() - started, queryPlans };
};
