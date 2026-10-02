import { createHash } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { deriveMonthIncome, isOrdinaryNomina, previousCalendarMonth, type PayslipSummary } from "@finance/domain";
import { rawSourceBucketName, s3 } from "../http/clients.js";
import type { JsonObject } from "../http/response.js";
import { InvalidCfdiNominaError, parseCfdiNominaXml } from "./cfdi-nomina.js";

import { readSqlPayslipsForMonth,readSqlPayslipsForYear,readSqlPayslipRecord,payslipExists,insertPayslip,MAX_PAYSLIP_LINES,toPublicPayslip,type PayrollEvidence } from './payroll-sql.js';
export { toPublicPayslip } from './payroll-sql.js';

export { InvalidCfdiNominaError };

const MAX_BULK_DOCUMENTS = 40;

export interface NominaUploadDocument {
  readonly filename: string;
  readonly xml: string;
}

export interface NominaUploadResultItem {
  readonly filename: string;
  readonly status: "created" | "duplicate" | "failed";
  readonly uuid?: string;
  readonly month?: string;
  readonly totalMinor?: number;
  readonly error?: string;
}

const sourceKey = (owner: string, sha256: string): string =>
  `manual-imports/cfdi-nomina/${owner}/${sha256}.xml`;

export const listPayslipsForMonth = readSqlPayslipsForMonth;
export const listPayslipsForYear = readSqlPayslipsForYear;
export const getPayslipSql = async (owner: string, month: string, uuid: string): Promise<JsonObject | undefined> => {
  const record = await readSqlPayslipRecord(owner,month,uuid);
  return record ? toPublicPayslip(record.payslip,record.ingestedAt,record.source) : undefined;
};
export const getPayslip = getPayslipSql;

export type MonthPayslipReader = (owner: string, month: string) => Promise<readonly PayslipSummary[]>;

export const listPriorOrdinaryPayslips = async (
  owner: string,
  beforeMonth: string,
  limit = 2,
  readMonth: MonthPayslipReader = listPayslipsForMonth,
): Promise<readonly PayslipSummary[]> => {
  const collected: PayslipSummary[] = [];
  let cursor: string | undefined = previousCalendarMonth(beforeMonth);
  let guard = 0;
  while (cursor && collected.length < limit && guard < 24) {
    const monthSlips = await readMonth(owner, cursor);
    for (const slip of [...monthSlips].reverse()) {
      if (!isOrdinaryNomina(slip.tipoNomina)) continue;
      collected.push(slip);
      if (collected.length >= limit) break;
    }
    cursor = previousCalendarMonth(cursor);
    guard += 1;
  }
  return collected;
};

const incomeFieldsForMonthFromReads = async (
  owner: string,
  month: string,
  now: Date = new Date(),
  readMonth: MonthPayslipReader = listPayslipsForMonth,
): Promise<{
  readonly configured: boolean;
  readonly incomeMinor: number;
  readonly depositedMinor: number;
  readonly estimatedMinor: number;
  readonly estimateActive: boolean;
  readonly provisionalActive: boolean;
  readonly provisionalMinor: number;
  readonly payslips: readonly PayslipSummary[];
}> => {
  const payslips = await readMonth(owner, month);
  const priorOrdinaryPayslips =
    payslips.length === 0 ? await listPriorOrdinaryPayslips(owner, month, 2, readMonth) : [];
  const derived = deriveMonthIncome({ payslips, month, now, priorOrdinaryPayslips });
  return {
    configured: derived.configured,
    incomeMinor: derived.incomeMinor,
    depositedMinor: derived.depositedMinor,
    estimatedMinor: derived.estimatedMinor,
    estimateActive: derived.estimateActive,
    provisionalActive: derived.provisionalActive,
    provisionalMinor: derived.provisionalMinor,
    payslips,
  };
};

export const incomeFieldsForMonth = (owner: string, month: string, now: Date = new Date(),
  readMonth: MonthPayslipReader = listPayslipsForMonth): ReturnType<typeof incomeFieldsForMonthFromReads> =>
  incomeFieldsForMonthFromReads(owner,month,now,readMonth);

const persistPayslip = async (
  owner: string,
  payslip: PayslipSummary,
  xml: string,
): Promise<"created" | "duplicate"> => {
  const sha256 = createHash("sha256").update(xml, "utf8").digest("hex");
  const key = sourceKey(owner, sha256);
  const ingestedAt = new Date().toISOString();
  const source: PayrollEvidence = {
    kind: "cfdi_nomina",
    bucket: rawSourceBucketName,
    key,
    sha256,
    contentType: "application/xml",
  };

  if (await payslipExists(payslip.uuid)) return 'duplicate';
  if (payslip.lines.length>MAX_PAYSLIP_LINES) throw new InvalidCfdiNominaError('La nómina tiene demasiadas líneas para guardarse completa.');

  await s3.send(
    new PutObjectCommand({
      Bucket: rawSourceBucketName,
      Key: key,
      Body: xml,
      ContentType: "application/xml; charset=utf-8",
    }),
  );

  return insertPayslip(owner,payslip,ingestedAt,source);
};

export const ingestNominaXml = async (
  owner: string,
  filename: string,
  xml: string,
): Promise<NominaUploadResultItem> => {
  try {
    const payslip = parseCfdiNominaXml(xml);
    const status = await persistPayslip(owner, payslip, xml);
    return {
      filename,
      status,
      uuid: payslip.uuid,
      month: payslip.month,
      totalMinor: payslip.totalMinor,
    };
  } catch (error) {
    return {
      filename,
      status: "failed",
      error: error instanceof Error ? error.message : "Unable to ingest nómina.",
    };
  }
};

export const parseBulkNominaBody = (body: string | undefined): readonly NominaUploadDocument[] => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(body ?? "");
  } catch {
    throw new InvalidCfdiNominaError("A JSON body with documents[] is required.");
  }
  if (!candidate || typeof candidate !== "object") {
    throw new InvalidCfdiNominaError("A JSON body with documents[] is required.");
  }
  const documents = (candidate as { documents?: unknown }).documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new InvalidCfdiNominaError("documents must be a non-empty array.");
  }
  if (documents.length > MAX_BULK_DOCUMENTS) {
    throw new InvalidCfdiNominaError(`At most ${MAX_BULK_DOCUMENTS} documents per request.`);
  }
  return documents.map((document, index) => {
    if (!document || typeof document !== "object") {
      throw new InvalidCfdiNominaError(`documents[${index}] must be an object.`);
    }
    const row = document as { filename?: unknown; xml?: unknown };
    if (typeof row.filename !== "string" || row.filename.trim().length < 1 || row.filename.length > 260) {
      throw new InvalidCfdiNominaError(`documents[${index}].filename is invalid.`);
    }
    if (typeof row.xml !== "string" || row.xml.trim().length < 32) {
      throw new InvalidCfdiNominaError(`documents[${index}].xml is required.`);
    }
    return { filename: row.filename.trim(), xml: row.xml };
  });
};

export const ingestNominaBulk = async (
  owner: string,
  documents: readonly NominaUploadDocument[],
): Promise<{
  readonly results: readonly NominaUploadResultItem[];
  readonly created: number;
  readonly duplicates: number;
  readonly failed: number;
}> => {
  const results: NominaUploadResultItem[] = [];
  for (const document of documents) {
    results.push(await ingestNominaXml(owner, document.filename, document.xml));
  }
  return {
    results,
    created: results.filter((item) => item.status === "created").length,
    duplicates: results.filter((item) => item.status === "duplicate").length,
    failed: results.filter((item) => item.status === "failed").length,
  };
};

export const publicPayslipsForMonth = async (owner: string, month: string): Promise<JsonObject[]> => {
  const payslips = await listPayslipsForMonth(owner, month);
  return payslips.map((payslip) => ({
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
  }));
};
