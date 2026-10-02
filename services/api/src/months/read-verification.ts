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
import { getMonthlyPlan, getMonthlyPlanFromReads } from './service.js';
import { planningReadMode, planReadStatement, payrollReadStatement, readSqlPlanRecord, readSqlAllPlanRecords, readSqlPayslipsForMonth, readSqlPayslipsForYear } from './sql-reads.js';
import { summarizeMonthFeed } from './summary.js';
import { getWealthOverview, getWealthOverviewAsOf } from '../wealth/service.js';
import { readSourceWealthInputs } from '../wealth/sql-reads.js';
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
  // Frozen month documents remain separately verified evidence. Native plans
  // supply every operational financial comparison, including after native edits.
  const nativePlans = await readSqlAllPlanRecords(owner, client);
  const parents = (await client.query('SELECT month,owner,updated_at FROM olbia.month_plans WHERE owner=$1 ORDER BY month', [owner])).rows;
  mismatches += Number(!samePublicResult(parents.map(row => ({ ...row, updated_at: new Date(row.updated_at as string | Date).toISOString() })),
    nativePlans.map(plan => ({ month: plan.month, owner, updated_at: plan.updatedAt }))));
  const children = (await client.query(`SELECT payment.* FROM olbia.planned_payments payment JOIN olbia.month_plans plan ON plan.month=payment.month
    WHERE plan.owner=$1 ORDER BY payment.month,payment.sort_order`, [owner])).rows;
  mismatches += Number(!samePublicResult(children.map(row => ({ ...row, amount_mxn_minor: Number(row.amount_mxn_minor) })),
    nativePlans.flatMap(plan => plan.upcomingPayments.map((payment, sort_order) => ({ month: plan.month, id: payment.id,
      name: payment.name, amount_mxn_minor: payment.amountMinor, due_day: payment.dueDay, sort_order })))));
  const invalidPlanReferences = Number((await client.query(`SELECT count(*) AS count FROM olbia.planned_payments payment
    LEFT JOIN olbia.month_plans plan ON plan.month=payment.month WHERE plan.month IS NULL`)).rows[0]?.count);
  mismatches += Number(invalidPlanReferences !== 0);
  const nativeConstraints = (await client.query(`SELECT conname,convalidated FROM pg_constraint WHERE
    conrelid IN ('olbia.month_plans'::regclass,'olbia.planned_payments'::regclass)
    AND conname IN ('month_plans_pkey','planned_payments_pkey','planned_payments_month_fk','planned_payments_order_key') ORDER BY conname`)).rows;
  mismatches += Number(!samePublicResult(nativeConstraints, ['month_plans_pkey','planned_payments_month_fk','planned_payments_order_key','planned_payments_pkey']
    .map(conname => ({ conname, convalidated: true }))));
  const records = [...source, ...projected.rows.map(row => row.source_item as JsonObject)];
  const months = new Set([...financialMonths, ...nativePlans.map(plan => plan.month), ...records.map(item => String(item.month))]);
  const ordered = [...months].sort();
  // Include gaps and inheritance after the last stored plan, plus empty boundaries.
  for (let month = addCalendarMonths(ordered[0]!, -1); month <= addCalendarMonths(ordered.at(-1)!, 1); month = addCalendarMonths(month, 1)) months.add(month);
  const sourceIncome: typeof incomeFieldsForMonth = (owner, month) => incomeFieldsForMonth(owner, month, now, listPayslipsForMonthDynamo);
  const sqlIncome: typeof incomeFieldsForMonth = (owner, month) => incomeFieldsForMonth(owner, month, now, readSqlPayslipsForMonth);
  let plans = 0, summaries = 0, compensation = 0, wealthCloses = 0;
  for (const month of [...months].sort()) {
    const sourcePlan = await getMonthlyPlanFromReads(owner, month, readSqlPlanRecord, sourceIncome);
    const sqlPlan = await getMonthlyPlanFromReads(owner, month, readSqlPlanRecord, sqlIncome);
    mismatches += Number(!samePublicResult(sourcePlan, sqlPlan)); plans++;
    const sourceMonthIncome = await sourceIncome(owner, month);
    const sqlMonthIncome = await sqlIncome(owner, month);
    mismatches += Number(!samePublicResult(sourceMonthIncome, sqlMonthIncome));
    mismatches += Number(!samePublicResult(deriveMonthCompensation(sourceMonthIncome), deriveMonthCompensation(sqlMonthIncome))); compensation++;
    mismatches += Number(!samePublicResult(summarizeMonthFeed(month, sourcePlan, feedFromPayloads([month], movementPayloads), now),
      summarizeMonthFeed(month, sqlPlan, await readSqlFeed([month], client), now))); summaries++;
    const day = monthCloseDay(month);
    mismatches += Number(!samePublicResult(await getWealthOverviewAsOf(owner, day, listPayslipsForYearDynamo, readSourceWealthInputs),
      await getWealthOverviewAsOf(owner, day, readSqlPayslipsForYear, readSourceWealthInputs))); wealthCloses++;
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
  mismatches += Number(!samePublicResult(await getWealthOverview(owner, now, listPayslipsForYearDynamo, readSourceWealthInputs), await getWealthOverview(owner, now, readSqlPayslipsForYear, readSourceWealthInputs)));
  // The configured path must also succeed; its guard cannot substitute for explicit comparisons above.
  mismatches += Number(!samePublicResult(await getMonthlyPlan(owner, monthKeyInZone(now)),
    await getMonthlyPlanFromReads(owner, monthKeyInZone(now), readSqlPlanRecord, sqlIncome)));
  const queryPlans = [];
  for (const [query, statement, values] of [
    ['plan', planReadStatement, [owner, monthKeyInZone(now)]],
    ['payroll', payrollReadStatement, [`USER#${owner}`, `PAYROLL#${monthKeyInZone(now).slice(0, 4)}-`, `PAYROLL#${monthKeyInZone(now).slice(0, 4)}.`]],
  ] as const) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, [...values]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line))
        .map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  return { mode: planningReadMode(), planAuthority: 'native-sql', storedPlans: nativePlans.length, plannedPayments: children.length,
    explicitEmptyPlans: nativePlans.filter(plan => plan.upcomingPayments.length === 0).length, invalidPlanReferences, validatedPlanConstraints: nativeConstraints.filter(row => row.convalidated).length,
    storedPayroll: details, plans, summaries, compensation, payrollYears, wealthCloses, wealthOverview: 1, details, evidenceFiles,
    missingLookups: 1, mismatches, elapsedMs: Date.now() - started, queryPlans };
};
