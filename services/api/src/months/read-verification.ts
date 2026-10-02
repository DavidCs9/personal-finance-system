import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { addCalendarMonths, monthKeyInZone, deriveMonthCompensation, runningFondoAhorroByDay, sumFondoAhorroDeduccionesMinor, type PayslipSummary } from '@finance/domain';
import { database, s3, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { samePublicResult } from '../events/read-selection.js';
import { readerPool, readSqlFeed } from '../events/sql-reads.js';
import { feedFromPayloads } from '../events/month-feed.js';
import { getPayslip,getPayslipSql,incomeFieldsForMonth,listPayslipsForYear,toPublicPayslip } from '../imports/cfdi-nomina-flow.js';
import { readSqlAllPayrollRecords } from '../imports/payroll-sql.js';
import { getMonthlyPlan, getMonthlyPlanFromReads } from './service.js';
import { planReadStatement, payrollReadStatement, readSqlPlanRecord, readSqlAllPlanRecords, readSqlPayslipsForMonth, readSqlPayslipsForYear } from './sql-reads.js';
import { summarizeMonthFeed } from './summary.js';
import { getWealthOverview, getWealthOverviewAsOf } from '../wealth/service.js';
import { readSourceWealthInputs } from '../wealth/sql-reads.js';
import { monthCloseDay } from '../reports/monthly-close.js';

/** Frozen evidence parity and native typed/domain/financial verification are independent gates. */
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
  const nativePayroll = await readSqlAllPayrollRecords(owner,client);
  const receipts = (await client.query(`SELECT uuid::text AS uuid,owner,paid_on::text AS paid_on,payroll_type,total_mxn_minor,
    perceptions_mxn_minor,deductions_mxn_minor,other_payments_mxn_minor,employer_name,pay_period_start::text AS pay_period_start,
    pay_period_end::text AS pay_period_end,ingested_at,evidence_bucket,evidence_key,evidence_sha256,evidence_content_type
    FROM olbia.payslips WHERE owner=$1 ORDER BY uuid`,[owner])).rows;
  const nativeByUuid = [...nativePayroll].sort((a,b)=>a.payslip.uuid.localeCompare(b.payslip.uuid));
  mismatches += Number(!samePublicResult(receipts.map(row=>({ ...row,ingested_at:new Date(row.ingested_at as string | Date).toISOString(),
    total_mxn_minor:Number(row.total_mxn_minor),perceptions_mxn_minor:Number(row.perceptions_mxn_minor),deductions_mxn_minor:Number(row.deductions_mxn_minor),other_payments_mxn_minor:Number(row.other_payments_mxn_minor) })),
    nativeByUuid.map(({payslip:p,ingestedAt,source:s})=>({uuid:p.uuid.toLowerCase(),owner,paid_on:p.fechaPago,payroll_type:p.tipoNomina,
      total_mxn_minor:p.totalMinor,perceptions_mxn_minor:p.totalPercepcionesMinor,deductions_mxn_minor:p.totalDeduccionesMinor,
      other_payments_mxn_minor:p.totalOtrosPagosMinor,employer_name:p.employerName ?? null,pay_period_start:p.fechaInicialPago ?? null,
      pay_period_end:p.fechaFinalPago ?? null,ingested_at:ingestedAt,evidence_bucket:s.bucket,evidence_key:s.key,evidence_sha256:s.sha256,evidence_content_type:s.contentType}))));
  const payrollLines = (await client.query(`SELECT line.payslip_uuid::text AS payslip_uuid,line.position,line.sat_kind,line.sat_type,line.code,line.concept,line.amount_mxn_minor
    FROM olbia.payslip_lines line JOIN olbia.payslips receipt ON receipt.uuid=line.payslip_uuid WHERE receipt.owner=$1 ORDER BY line.payslip_uuid,line.position`,[owner])).rows;
  mismatches += Number(!samePublicResult(payrollLines.map(row=>({...row,amount_mxn_minor:Number(row.amount_mxn_minor)})),nativeByUuid.flatMap(({payslip:p})=>p.lines.map((l,position)=>({payslip_uuid:p.uuid.toLowerCase(),position,sat_kind:l.kind,sat_type:l.tipo,code:l.clave,concept:l.concepto,amount_mxn_minor:l.amountMinor})))));
  const invalidPayrollReferences = Number((await client.query(`SELECT count(*) AS count FROM olbia.payslip_lines line LEFT JOIN olbia.payslips receipt ON receipt.uuid=line.payslip_uuid WHERE receipt.uuid IS NULL`)).rows[0]?.count);
  mismatches += Number(invalidPayrollReferences!==0);
  const payrollConstraints = (await client.query(`SELECT conname,convalidated FROM pg_constraint WHERE conrelid IN ('olbia.payslips'::regclass,'olbia.payslip_lines'::regclass)
    AND conname IN ('payslips_pkey','payslip_lines_pkey','payslip_lines_receipt_fk') ORDER BY conname`)).rows;
  mismatches += Number(!samePublicResult(payrollConstraints,['payslip_lines_pkey','payslip_lines_receipt_fk','payslips_pkey'].map(conname=>({conname,convalidated:true}))));
  const records = [...source, ...projected.rows.map(row => row.source_item as JsonObject)];
  const months = new Set([...financialMonths, ...nativePlans.map(plan => plan.month), ...nativePayroll.map(record=>record.payslip.month), ...records.map(item => String(item.month))]);
  const ordered = [...months].sort();
  // Include gaps and inheritance after the last stored plan, plus empty boundaries.
  for (let month = addCalendarMonths(ordered[0]!, -1); month <= addCalendarMonths(ordered.at(-1)!, 1); month = addCalendarMonths(month, 1)) months.add(month);
  const sourceIncome: typeof incomeFieldsForMonth = (owner, month) => incomeFieldsForMonth(owner, month, now, readSqlPayslipsForMonth);
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
    mismatches += Number(!samePublicResult(await getWealthOverviewAsOf(owner, day, listPayslipsForYear, readSourceWealthInputs),
      await getWealthOverviewAsOf(owner, day, readSqlPayslipsForYear, readSourceWealthInputs))); wealthCloses++;
  }
  const years = new Set([...months].map(month => month.slice(0, 4)));
  let payrollYears = 0;
  for (const year of years) {
    const sourceSlips = await listPayslipsForYear(owner, year);
    const sqlSlips = await readSqlPayslipsForYear(owner, year);
    mismatches += Number(!samePublicResult(sourceSlips, sqlSlips));
    mismatches += Number(!samePublicResult(sumFondoAhorroDeduccionesMinor(sourceSlips), sumFondoAhorroDeduccionesMinor(sqlSlips)));
    mismatches += Number(!samePublicResult(runningFondoAhorroByDay(sourceSlips), runningFondoAhorroByDay(sqlSlips))); payrollYears++;
  }
  let details = 0, evidenceFiles = 0;
  for (const item of source.filter(item => String(item.SK).startsWith('PAYROLL#'))) {
    const month = String(item.month), uuid = String(item.uuid);
    const sourceDetail = toPublicPayslip(item.payload as unknown as PayslipSummary,String(item.ingestedAt),item.source as JsonObject);
    mismatches += Number(!samePublicResult(sourceDetail, await getPayslipSql(owner, month, uuid.toLowerCase())));
    mismatches += Number(!samePublicResult(sourceDetail, await getPayslip(owner, month, uuid))); details++;
  }
  for (const record of nativePayroll) {
    const evidence = record.source;
    mismatches += Number(!samePublicResult(await getPayslip(owner,record.payslip.month,record.payslip.uuid),
      { ...record.payslip,ingestedAt:record.ingestedAt,source:record.source }));
    const object = await s3.send(new GetObjectCommand({ Bucket: evidence.bucket, Key: evidence.key }));
    const bytes = await object.Body!.transformToByteArray();
    mismatches += Number(createHash('sha256').update(bytes).digest('hex') !== evidence.sha256); evidenceFiles++;
  }
  const missing = '__dsql_missing_payroll__';
  mismatches += Number(await getPayslipSql(owner,'1900-01',missing)!==undefined);
  mismatches += Number(!samePublicResult(await getWealthOverview(owner, now, listPayslipsForYear, readSourceWealthInputs), await getWealthOverview(owner, now, readSqlPayslipsForYear, readSourceWealthInputs)));
  // The actual public path must succeed with the current native authority.
  mismatches += Number(!samePublicResult(await getMonthlyPlan(owner, monthKeyInZone(now)),
    await getMonthlyPlanFromReads(owner, monthKeyInZone(now), readSqlPlanRecord, sqlIncome)));
  const queryPlans = [];
  for (const [query, statement, values] of [
    ['plan', planReadStatement, [owner, monthKeyInZone(now)]],
    ['payroll', payrollReadStatement, [owner, `${monthKeyInZone(now).slice(0,4)}-01-01`, `${Number(monthKeyInZone(now).slice(0,4))+1}-01-01`]],
  ] as const) {
    const result = await client.query(`EXPLAIN ANALYZE VERBOSE ${statement}`, [...values]);
    const lines = result.rows.map(row => String(row['QUERY PLAN']));
    queryPlans.push({ query, scanTypes: [...new Set(lines.flatMap(line => line.match(/(?:Index Only Scan|Index Scan|Seq Scan|Bitmap Heap Scan)/g) ?? []))],
      metrics: lines.filter(line => /(?:DPU|Planning Time|Execution Time)/i.test(line))
        .map(line => line.trim()).filter(line => /^[\w\s():.=,+-]+$/.test(line)) });
  }
  return { mode: 'native-sql', payrollAuthority: 'native-sql', planAuthority: 'native-sql', storedPlans: nativePlans.length, plannedPayments: children.length,
    explicitEmptyPlans: nativePlans.filter(plan => plan.upcomingPayments.length === 0).length, invalidPlanReferences, validatedPlanConstraints: nativeConstraints.filter(row => row.convalidated).length,
    storedPayroll: nativePayroll.length, payrollLines: payrollLines.length, invalidPayrollReferences, validatedPayrollConstraints: payrollConstraints.filter(row=>row.convalidated).length, frozenPayroll: details, plans, summaries, compensation, payrollYears, wealthCloses, wealthOverview: 1, details, evidenceFiles,
    missingLookups: 1, mismatches, elapsedMs: Date.now() - started, queryPlans };
};
