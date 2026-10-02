import { verifyOperationalReads } from '../operational/verification.js';
import { addCalendarMonths, monthKeyInZone } from '@finance/domain';
import { feedFromMovements, spendMonthOf } from './month-feed.js';
import { verifyNativeLedgerState, verifyNativeMonthSummary } from './native-verification.js';
import { monthReadStatement, readerPool, readSqlDetail, readSqlFeed, withLedgerVerificationSnapshot } from './sql-reads.js';
import { allStoredEvents, listEventsForMonths, getEventDetail } from './queries.js';
import { samePublicResult } from './read-selection.js';
import { getMonthlyPlan } from '../months/service.js';
import { summarizeMonthFeed } from '../months/summary.js';
import type { JsonObject } from '../http/response.js';
import { verifyDomainReads } from '../categories/read-verification.js';
import { verifyWealthReads } from '../wealth/read-verification.js';
import { verifyPlanningReads } from '../months/read-verification.js';
import { verifyNativeLedgerProvenance } from './provenance-verification.js';
import { collectLedgerEvidence, verifyLedgerEvidence } from './evidence-verification.js';

/** One internally consistent financial phase; later domains use their own bounded snapshot. */
export const verifyNativeFinancialReads = (owner: string, now: Date) => withLedgerVerificationSnapshot(async () => {
  const started = Date.now();
  const source = [...await allStoredEvents()];
  const nativeReadMs = Date.now() - started;
  const pool = readerPool();
  const native = await verifyNativeLedgerState(pool, source, id => readSqlDetail(id, pool));
  let mismatches = native.mismatches;
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
  mismatches += Number(!samePublicResult(feedFromMovements(orderedMonths, source), await readSqlFeed(orderedMonths, pool)));
  for (const month of [...months].sort()) {
    const sourceFeed = feedFromMovements([month], source);
    const sqlStarted = Date.now();
    const sqlFeed = await readSqlFeed([month], pool);
    sqlFeedMs += Date.now() - sqlStarted;
    mismatches += Number(!samePublicResult(sourceFeed, sqlFeed));
    feeds++;
    const plan = await getMonthlyPlan(owner, month);
    const summary = summarizeMonthFeed(month, plan, sqlFeed, now);
    mismatches += Number(!samePublicResult(summarizeMonthFeed(month, plan, sourceFeed, now), summary));
    mismatches += (await verifyNativeMonthSummary(pool, month, sqlFeed, summary)).mismatches;
    summaries++;
  }
  // Each adjacent pair verifies range ordering and MSI deduplication, beyond single-month membership.
  let ranges = 1;
  for (let i = 1; i < orderedMonths.length; i++) {
    const range = orderedMonths.slice(i - 1, i + 1);
    mismatches += Number(!samePublicResult(feedFromMovements(range, source), await readSqlFeed(range, pool)));
    ranges++;
  }
  const missing = '00000000-0000-0000-0000-000000000000';
  mismatches += Number(await readSqlDetail(missing, pool) !== undefined);
  mismatches += Number(await readSqlDetail('invalid-id', pool) !== undefined);
  const configuredStarted = Date.now();
  const configuredFeed = await listEventsForMonths([current]);
  mismatches += Number(!samePublicResult(configuredFeed, await readSqlFeed([current], pool)));
  if (source.length) mismatches += Number(!samePublicResult(await getEventDetail(String(source[0].id)), await readSqlDetail(String(source[0].id), pool)));
  const configuredReadsMs = Date.now() - configuredStarted;
  const plan = await pool.query(`EXPLAIN ANALYZE VERBOSE ${monthReadStatement}`, [null, [current]]);
  // Plans can contain predicates/identifiers. Return only native scan node kinds and numeric cost/timing lines.
  const lines = plan.rows.map(row => String(row['QUERY PLAN']));
  const queryPlan = lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line))
    .map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line));
  const scanTypes = [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))];
  return { native, orderedMonths, movements: source.length, feeds, summaries, ranges, details: native.details,
    missingLookups: 2, mismatches, elapsedMs: Date.now() - started, nativeReadMs, configuredReadsMs,
    sqlFeedTotalMs: sqlFeedMs, sqlFeedAverageMs: feeds ? Math.round(sqlFeedMs / feeds) : 0, queryPlan, scanTypes };
});

/** Read-only deployed capability. Public results contain no source payloads, IDs or financial aggregates. */
export const verifyLedgerReads = async () => {
  const started = Date.now(), now = new Date(), owner = process.env.AGENT_OWNER_SUB;
  if (!owner) throw new Error('Missing verification owner');
  const { orderedMonths, ...financial } = await verifyNativeFinancialReads(owner, now);
  let mismatches = financial.mismatches;
  const { provenance, evidenceAssertions } = await withLedgerVerificationSnapshot(async () => ({
    provenance: await verifyNativeLedgerProvenance(readerPool()), evidenceAssertions: await collectLedgerEvidence(readerPool()),
  }));
  mismatches += provenance.mismatches;
  const evidence = await verifyLedgerEvidence(evidenceAssertions);
  mismatches += evidence.mismatches;
  // Refresh current movement input in the same snapshot as each phase's SQL comparisons.
  const planning = await withLedgerVerificationSnapshot(async () => verifyPlanningReads(owner, [...await allStoredEvents()], orderedMonths, now));
  mismatches += planning.mismatches;
  const wealth = await withLedgerVerificationSnapshot(() => verifyWealthReads(owner, orderedMonths, now));
  mismatches += wealth.mismatches;
  const domain = await withLedgerVerificationSnapshot(async () => verifyDomainReads(owner, await allStoredEvents(), orderedMonths, now));
  mismatches += domain.mismatches;
  const operational = await withLedgerVerificationSnapshot(() => verifyOperationalReads(owner, now));
  mismatches += operational.mismatches;
  return { ...financial, provenance, evidence, operational, verified: mismatches === 0, mode: 'native-sql', planning, wealth, domain,
    mismatches, elapsedMs: Date.now() - started, phaseDurationsMs: { financial: financial.elapsedMs,
      provenance: provenance.elapsedMs, evidence: evidence.elapsedMs,
      planning: planning.elapsedMs, wealth: wealth.elapsedMs, domain: domain.elapsedMs, operational: operational.elapsedMs } };
};

export const handler = async () => {
  try { return await verifyLedgerReads(); }
  catch { throw new Error('DSQL read verification failed; inspect native metrics and retained deployment state'); }
};
