import { addCalendarMonths, monthKeyInZone } from '@finance/domain';
import { feedFromPayloads, spendMonthOf } from './month-feed.js';
import { readCurrentMovementPayloads, readSourceDetail } from './source-reads.js';
import { monthReadStatement, readerPool, readSqlDetail, readSqlFeed } from './sql-reads.js';
import { listEventsForMonthsDynamo, listEventsForMonths, getEventDetail } from './queries.js';
import { ledgerReadMode, samePublicResult } from './read-selection.js';
import { getMonthlyPlan } from '../months/service.js';
import { summarizeMonthFeed } from '../months/summary.js';
import type { JsonObject } from '../http/response.js';

/** Read-only deployed capability. Public results contain no source payloads, IDs or financial aggregates. */
export const verifyLedgerReads = async () => {
  const started = Date.now();
  const now = new Date();
  const owner = process.env.AGENT_OWNER_SUB;
  if (!owner) throw new Error('Missing verification owner');
  const source = await readCurrentMovementPayloads();
  const sourceScanMs = Date.now() - started;
  const pool = readerPool();
  const sql = await pool.query('SELECT payload FROM olbia.movements');
  const sort = (items: JsonObject[]) => [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let mismatches = Number(!samePublicResult(sort(source), sort(sql.rows.map(row => row.payload as JsonObject))));
  const months = new Set<string>();
  for (const event of source) {
    months.add(spendMonthOf(event));
    for (const installment of ((event.msi as JsonObject | undefined)?.installments ?? []) as JsonObject[])
      if (typeof installment.month === 'string') months.add(installment.month);
  }
  const current = monthKeyInZone(now);
  for (const offset of [-1, 0, 1]) months.add(addCalendarMonths(current, offset));
  const orderedMonths = [...months].sort();
  // Empty boundary cases and ranges spanning real month boundaries exercise the public query contract.
  for (const month of [addCalendarMonths(orderedMonths[0], -25), addCalendarMonths(orderedMonths.at(-1)!, 25)]) months.add(month);
  let feeds = 0;
  let summaries = 0;
  let sqlFeedMs = 0;
  const legacyStarted = Date.now();
  const legacyRange = await listEventsForMonthsDynamo(orderedMonths);
  const legacyMs = Date.now() - legacyStarted;
  mismatches += Number(!samePublicResult(legacyRange, feedFromPayloads(orderedMonths, source)));
  mismatches += Number(!samePublicResult(legacyRange, await readSqlFeed(orderedMonths, pool)));
  for (const month of [...months].sort()) {
    const sourceFeed = feedFromPayloads([month], source);
    const sqlStarted = Date.now();
    const sqlFeed = await readSqlFeed([month], pool);
    sqlFeedMs += Date.now() - sqlStarted;
    mismatches += Number(!samePublicResult(sourceFeed, sqlFeed));
    feeds++;
    const plan = await getMonthlyPlan(owner, month);
    mismatches += Number(!samePublicResult(summarizeMonthFeed(month, plan, sourceFeed, now), summarizeMonthFeed(month, plan, sqlFeed, now)));
    summaries++;
  }
  // Each adjacent pair verifies range ordering and MSI deduplication, beyond single-month membership.
  let ranges = 1;
  for (let i = 1; i < orderedMonths.length; i++) {
    const range = orderedMonths.slice(i - 1, i + 1);
    mismatches += Number(!samePublicResult(feedFromPayloads(range, source), await readSqlFeed(range, pool)));
    ranges++;
  }
  let details = 0;
  for (const event of source) {
    const id = String(event.id);
    mismatches += Number(!samePublicResult(await readSqlDetail(id, pool), await readSourceDetail(id)));
    details++;
  }
  const missing = '__dsql_missing_read_verification__';
  mismatches += Number(!samePublicResult(await readSqlDetail(missing, pool), await readSourceDetail(missing)));
  const configuredStarted = Date.now();
  const configuredFeed = await listEventsForMonths([current]);
  mismatches += Number(!samePublicResult(configuredFeed, await readSqlFeed([current], pool)));
  if (source.length) mismatches += Number(!samePublicResult(await getEventDetail(String(source[0].id)), await readSqlDetail(String(source[0].id), pool)));
  const configuredReadsMs = Date.now() - configuredStarted;
  const plan = await pool.query(`EXPLAIN ANALYZE VERBOSE ${monthReadStatement}`, [[current],
    [current, ...Array.from({ length: 24 }, (_, index) => addCalendarMonths(current, -index - 1)),
      ...Array.from({ length: 24 }, (_, index) => addCalendarMonths(current, index + 1))]]);
  // Plans can contain predicates/identifiers. Return only native scan node kinds and numeric cost/timing lines.
  const lines = plan.rows.map(row => String(row['QUERY PLAN']));
  const queryPlan = lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line))
    .map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line));
  const scanTypes = [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))];
  return { verified: mismatches === 0, mode: ledgerReadMode(), movements: source.length, feeds, summaries, ranges, details,
    missingLookups: 1, mismatches, elapsedMs: Date.now() - started, sourceScanMs, configuredReadsMs, legacyRangeMs: legacyMs,
    sqlFeedTotalMs: sqlFeedMs, sqlFeedAverageMs: feeds ? Math.round(sqlFeedMs / feeds) : 0, queryPlan, scanTypes };
};

export const handler = async () => {
  try { return await verifyLedgerReads(); }
  catch { throw new Error('DSQL read verification failed; inspect native metrics and retained deployment state'); }
};
