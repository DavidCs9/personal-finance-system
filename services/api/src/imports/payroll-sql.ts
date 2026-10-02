import { applicationStoreClient, withApplicationTransaction } from '@finance/ledger/dsql-store';
import { payslipLineGroup, type PayslipSummary, type PayslipLine } from '@finance/domain';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import type { JsonObject } from '../http/response.js';
import { InvalidCfdiNominaError } from './cfdi-nomina.js';

export const toPublicPayslip = (payslip: PayslipSummary, ingestedAt: string, source: JsonObject | PayrollEvidence): JsonObject => ({
  uuid: payslip.uuid,
  fechaPago: payslip.fechaPago,
  month: payslip.month,
  tipoNomina: payslip.tipoNomina,
  totalMinor: payslip.totalMinor,
  totalPercepcionesMinor: payslip.totalPercepcionesMinor,
  totalDeduccionesMinor: payslip.totalDeduccionesMinor,
  totalOtrosPagosMinor: payslip.totalOtrosPagosMinor,
  lines: payslip.lines,
  ...(payslip.employerName ? { employerName: payslip.employerName } : {}),
  ...(payslip.fechaInicialPago ? { fechaInicialPago: payslip.fechaInicialPago } : {}),
  ...(payslip.fechaFinalPago ? { fechaFinalPago: payslip.fechaFinalPago } : {}),
  ingestedAt,
  source,
});

export const MAX_PAYSLIP_LINES = 2998; // Header + application barrier leave 2 native mutation rows.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PayrollEvidence { readonly kind: 'cfdi_nomina'; readonly bucket: string; readonly key: string; readonly sha256: string; readonly contentType: string }
export interface PayrollRecord { readonly payslip: PayslipSummary; readonly ingestedAt: string; readonly source: PayrollEvidence }
export const payslipInsertColumns = `uuid,owner,paid_on,payroll_type,total_mxn_minor,perceptions_mxn_minor,deductions_mxn_minor,
  other_payments_mxn_minor,employer_name,pay_period_start,pay_period_end,ingested_at,evidence_bucket,evidence_key,evidence_sha256,evidence_content_type`;
const columns = `receipt.uuid,receipt.paid_on::text AS paid_on,receipt.payroll_type,receipt.total_mxn_minor,
  receipt.perceptions_mxn_minor,receipt.deductions_mxn_minor,receipt.other_payments_mxn_minor,receipt.employer_name,
  receipt.pay_period_start::text AS pay_period_start,receipt.pay_period_end::text AS pay_period_end,receipt.ingested_at,
  receipt.evidence_bucket,receipt.evidence_key,receipt.evidence_sha256,receipt.evidence_content_type,
  line.position,line.sat_kind,line.sat_type,line.code,line.concept,line.amount_mxn_minor`;
export const payrollReadStatement = `SELECT ${columns} FROM olbia.payslips receipt
  LEFT JOIN olbia.payslip_lines line ON line.payslip_uuid=receipt.uuid
  WHERE receipt.owner=$1 AND receipt.paid_on >= $2::date AND receipt.paid_on < $3::date
  ORDER BY receipt.paid_on,receipt.uuid,line.position`;
export const payrollFromRows = (rows: readonly JsonObject[]): PayrollRecord[] => {
  const grouped = new Map<string, JsonObject[]>();
  for (const row of rows) { const key = String(row.uuid); grouped.set(key,[...(grouped.get(key) ?? []),row]); }
  return [...grouped.values()].map(group => {
    const row = group[0]!;
    const lines: PayslipLine[] = group.filter(line => line.position !== null).map(line => {
      const kind = line.sat_kind as PayslipLine['kind'], tipo = String(line.sat_type);
      return { kind,tipo,clave: String(line.code),concepto: String(line.concept),amountMinor: Number(line.amount_mxn_minor),
        group: payslipLineGroup(kind,tipo),...(kind==='percepcion' && tipo==='005' ? { notCashInBank: true } : {}) };
    });
    const fechaPago = String(row.paid_on);
    return { payslip: { uuid: String(row.uuid).toUpperCase(),fechaPago,month: fechaPago.slice(0,7),tipoNomina: String(row.payroll_type),
      totalMinor: Number(row.total_mxn_minor),totalPercepcionesMinor: Number(row.perceptions_mxn_minor),
      totalDeduccionesMinor: Number(row.deductions_mxn_minor),totalOtrosPagosMinor: Number(row.other_payments_mxn_minor),lines,
      ...(row.employer_name ? { employerName: String(row.employer_name) } : {}),
      ...(row.pay_period_start ? { fechaInicialPago: String(row.pay_period_start) } : {}),
      ...(row.pay_period_end ? { fechaFinalPago: String(row.pay_period_end) } : {}) },
    ingestedAt: new Date(row.ingested_at as string | Date).toISOString(),source: { kind: 'cfdi_nomina',bucket: String(row.evidence_bucket),
      key: String(row.evidence_key),sha256: String(row.evidence_sha256),contentType: String(row.evidence_content_type) } };
  });
};
const nextMonth = (month: string) => `${String(Number(month.slice(0,4))+(month.endsWith('-12') ? 1 : 0)).padStart(4,'0')}-${month.endsWith('-12') ? '01' : String(Number(month.slice(5))+1).padStart(2,'0')}`;
export const readSqlPayslipsForMonth = async (owner: string, month: string, client: ReadSqlClient = readerPool()): Promise<readonly PayslipSummary[]> =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0,4))>0
    ? payrollFromRows((await client.query(payrollReadStatement,[owner,`${month}-01`,`${nextMonth(month)}-01`])).rows).map(record => record.payslip) : [];
export const readSqlPayslipsForYear = async (owner: string, year: string, client: ReadSqlClient = readerPool()): Promise<readonly PayslipSummary[]> =>
  /^\d{4}$/.test(year) && Number(year)>0
    ? payrollFromRows((await client.query(payrollReadStatement,[owner,`${year}-01-01`,`${String(Number(year)+1).padStart(4,'0')}-01-01`])).rows).map(record => record.payslip) : [];
export const readSqlPayslipRecord = async (owner: string, month: string, uuid: string, client: ReadSqlClient = readerPool()): Promise<PayrollRecord | undefined> =>
  uuidPattern.test(uuid) ? payrollFromRows((await client.query(`SELECT ${columns} FROM olbia.payslips receipt
    LEFT JOIN olbia.payslip_lines line ON line.payslip_uuid=receipt.uuid
    WHERE receipt.owner=$1 AND receipt.uuid=$2::uuid AND left(receipt.paid_on::text,7)=$3 ORDER BY line.position`,[owner,uuid,month])).rows)[0] : undefined;
export const readSqlAllPayrollRecords = async (owner: string, client: ReadSqlClient = readerPool()): Promise<readonly PayrollRecord[]> =>
  payrollFromRows((await client.query(`SELECT ${columns} FROM olbia.payslips receipt LEFT JOIN olbia.payslip_lines line
    ON line.payslip_uuid=receipt.uuid WHERE receipt.owner=$1 ORDER BY receipt.paid_on,receipt.uuid,line.position`,[owner])).rows);

export const payslipExists = async (uuid: string): Promise<boolean> =>
  (await applicationStoreClient().query('SELECT uuid FROM olbia.payslips WHERE uuid=$1::uuid',[uuid])).rows.length>0;
export const insertPayslip = async (owner: string, payslip: PayslipSummary, ingestedAt: string, source: PayrollEvidence): Promise<'created'|'duplicate'> => {
  if (payslip.lines.length>MAX_PAYSLIP_LINES) throw new InvalidCfdiNominaError('La nómina tiene demasiadas líneas para guardarse completa.');
  return withApplicationTransaction(async () => {
    const client = applicationStoreClient();
    const inserted = (await client.query(`INSERT INTO olbia.payslips (${payslipInsertColumns})
      VALUES (${Array.from({length:16},(_,i)=>`$${i+1}`).join(',')}) ON CONFLICT (uuid) DO NOTHING RETURNING uuid`,
    [payslip.uuid,owner,payslip.fechaPago,payslip.tipoNomina,payslip.totalMinor,payslip.totalPercepcionesMinor,
      payslip.totalDeduccionesMinor,payslip.totalOtrosPagosMinor,payslip.employerName ?? null,payslip.fechaInicialPago ?? null,
      payslip.fechaFinalPago ?? null,ingestedAt,source.bucket,source.key,source.sha256,source.contentType])).rows[0];
    if (!inserted) return 'duplicate';
    // One parameterized statement keeps even long receipts within the transaction lifetime.
    if (payslip.lines.length) await client.query(`INSERT INTO olbia.payslip_lines
      (payslip_uuid,position,sat_kind,sat_type,code,concept,amount_mxn_minor)
      SELECT $1::uuid,(line.position-1)::integer,line.item->>'kind',line.item->>'tipo',line.item->>'clave',line.item->>'concepto',
        (line.item->>'amountMinor')::bigint FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS line(item,position)`,
    [payslip.uuid,JSON.stringify(payslip.lines)]);
    return 'created';
  });
};
