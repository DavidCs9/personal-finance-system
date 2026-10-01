import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { addCalendarMonths, monthKeyInZone, deriveMonthCompensation, runningFondoAhorroByDay, sumFondoAhorroDeduccionesMinor } from '@finance/domain';
import { database, s3, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { samePublicResult } from '../events/read-selection.js';
import { readerPool, readSqlFeed } from '../events/sql-reads.js';
import { feedFromPayloads } from '../events/month-feed.js';
import { getPayslip, getPayslipDynamo, getPayslipSql, incomeFieldsForMonth, listPayslipsForMonthDynamo, listPayslipsForYearDynamo } from '../imports/cfdi-nomina-flow.js';
import { getMonthlyPlan, getMonthlyPlanFromReads, readMonthlyPlanRecordDynamo } from './service.js';
import { planningReadMode, planReadStatement, payrollReadStatement, readSqlPlanRecord, readSqlPayslipsForMonth, readSqlPayslipsForYear } from './sql-reads.js';
import { summarizeMonthFeed } from './summary.js';
import { getWealthOverview, getWealthOverviewAsOf } from '../wealth/service.js';
import { monthCloseDay } from '../reports/monthly-close.js';

/** Explicit source/SQL reads prevent the freshness fallback from hiding a failed migration gate. */
export const verifyPlanningReads = async (owner: string, movementPayloads: JsonObject[], financialMonths: readonly string[], now: Date) => {
  const started = Date.now();
  const source: JsonObject[] = [];
  for (const prefix of ['MONTH#', 'PAYROLL#']) {
    for await (const page of paginateQuery({ client: database }, { TableName: tableName, ConsistentRead: true,
      KeyConditionExpression: 'PK=:pk AND begins_with(SK,:prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${owner}`, ':prefix': prefix } })) source.push(...(page.Items ?? []));
  }
  const client = readerPool();
  const projected = await client.query(`SELECT source_item FROM olbia.monthly_plans WHERE source_pk=$1
    UNION ALL SELECT source_item FROM olbia.payroll WHERE source_pk=$1`, [`USER#${owner}`]);
  const sorted = (items: JsonObject[]) => [...items].sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
  let mismatches = Number(!samePublicResult(sorted(source), sorted(projected.rows.map(row => row.source_item as JsonObject))));
  const records = [...source, ...projected.rows.map(row => row.source_item as JsonObject)];
  const months = new Set([...financialMonths, ...records.map(item => String(item.month))]);
  const ordered = [...months].sort();
  // Include gaps and inheritance after the last stored plan, plus empty boundaries.
  for (let month = addCalendarMonths(ordered[0]!, -1); month <= addCalendarMonths(ordered.at(-1)!, 1); month = addCalendarMonths(month, 1)) months.add(month);
  const sourceIncome: typeof incomeFieldsForMonth = (owner, month) => incomeFieldsForMonth(owner, month, now, listPayslipsForMonthDynamo);
  const sqlIncome: typeof incomeFieldsForMonth = (owner, month) => incomeFieldsForMonth(owner, month, now, readSqlPayslipsForMonth);
  let plans = 0, summaries = 0, compensation = 0, wealthCloses = 0;
  for (const month of [...months].sort()) {
    const sourcePlan = await getMonthlyPlanFromReads(owner, month, readMonthlyPlanRecordDynamo, sourceIncome);
    const sqlPlan = await getMonthlyPlanFromReads(owner, month, readSqlPlanRecord, sqlIncome);
    mismatches += Number(!samePublicResult(sourcePlan, sqlPlan)); plans++;
    const sourceMonthIncome = await sourceIncome(owner, month);
    const sqlMonthIncome = await sqlIncome(owner, month);
    mismatches += Number(!samePublicResult(sourceMonthIncome, sqlMonthIncome));
    mismatches += Number(!samePublicResult(deriveMonthCompensation(sourceMonthIncome), deriveMonthCompensation(sqlMonthIncome))); compensation++;
    mismatches += Number(!samePublicResult(summarizeMonthFeed(month, sourcePlan, feedFromPayloads([month], movementPayloads), now),
      summarizeMonthFeed(month, sqlPlan, await readSqlFeed([month], client), now))); summaries++;
    const day = monthCloseDay(month);
    mismatches += Number(!samePublicResult(await getWealthOverviewAsOf(owner, day, listPayslipsForYearDynamo),
      await getWealthOverviewAsOf(owner, day, readSqlPayslipsForYear))); wealthCloses++;
  }
  const years = new Set([...months].map(month => month.slice(0, 4)));
  let payrollYears = 0;
  for (const year of years) {
    const sourceSlips = await listPayslipsForYearDynamo(owner, year);
    const sqlSlips = await readSqlPayslipsForYear(owner, year);
    mismatches += Number(!samePublicResult(sourceSlips, sqlSlips));
    mismatches += Number(!samePublicResult(sumFondoAhorroDeduccionesMinor(sourceSlips), sumFondoAhorroDeduccionesMinor(sqlSlips)));
    mismatches += Number(!samePublicResult(runningFondoAhorroByDay(sourceSlips), runningFondoAhorroByDay(sqlSlips))); payrollYears++;
  }
  let details = 0, evidenceFiles = 0;
  for (const item of source.filter(item => String(item.SK).startsWith('PAYROLL#'))) {
    const month = String(item.month), uuid = String(item.uuid);
    const sourceDetail = await getPayslipDynamo(owner, month, uuid.toLowerCase());
    mismatches += Number(!samePublicResult(sourceDetail, await getPayslipSql(owner, month, uuid.toLowerCase())));
    mismatches += Number(!samePublicResult(sourceDetail, await getPayslip(owner, month, uuid))); details++;
    const evidence = item.source as { bucket: string; key: string; sha256: string };
    const object = await s3.send(new GetObjectCommand({ Bucket: evidence.bucket, Key: evidence.key }));
    const bytes = await object.Body!.transformToByteArray();
    mismatches += Number(createHash('sha256').update(bytes).digest('hex') !== evidence.sha256); evidenceFiles++;
  }
  const missing = '__dsql_missing_payroll__';
  mismatches += Number(!samePublicResult(await getPayslipDynamo(owner, '1900-01', missing), await getPayslipSql(owner, '1900-01', missing)));
  mismatches += Number(!samePublicResult(await getWealthOverview(owner, now, listPayslipsForYearDynamo), await getWealthOverview(owner, now, readSqlPayslipsForYear)));
  // The configured path must also succeed; its guard cannot substitute for explicit comparisons above.
  mismatches += Number(!samePublicResult(await getMonthlyPlan(owner, monthKeyInZone(now)),
    await getMonthlyPlanFromReads(owner, monthKeyInZone(now), readSqlPlanRecord, sqlIncome)));
  const queryPlans = [];
  for (const [query, statement, values] of [
    ['plan', planReadStatement, [`USER#${owner}`, `MONTH#${monthKeyInZone(now)}`]],
    ['payroll', payrollReadStatement, [`USER#${owner}`, `PAYROLL#${monthKeyInZone(now).slice(0, 4)}-`, `PAYROLL#${monthKeyInZone(now).slice(0, 4)}.`]],
  ] as const) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, [...values]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line))
        .map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  return { mode: planningReadMode(), storedPlans: source.filter(item => String(item.SK).startsWith('MONTH#')).length,
    storedPayroll: details, plans, summaries, compensation, payrollYears, wealthCloses, wealthOverview: 1, details, evidenceFiles,
    missingLookups: 1, mismatches, elapsedMs: Date.now() - started, queryPlans };
};
