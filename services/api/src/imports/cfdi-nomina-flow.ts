import { createHash } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { deriveMonthIncome, isOrdinaryNomina, previousCalendarMonth, type PayslipSummary } from "@finance/domain";
import { database, rawSourceBucketName, s3, tableName } from "../http/clients.js";
import type { JsonObject } from "../http/response.js";
import { InvalidCfdiNominaError, parseCfdiNominaXml } from "./cfdi-nomina.js";

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

const payrollKey = (owner: string, month: string, uuid: string) => ({
  PK: `USER#${owner}`,
  SK: `PAYROLL#${month}#${uuid}`,
});

const dedupeKey = (uuid: string) => ({
  PK: `DEDUPE#CFDI_NOMINA#${uuid}`,
  SK: "CLAIM",
});

const sourceKey = (owner: string, sha256: string): string =>
  `manual-imports/cfdi-nomina/${owner}/${sha256}.xml`;

const toPublicPayslip = (payslip: PayslipSummary, ingestedAt: string, source: JsonObject): JsonObject => ({
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

export const listPayslipsForMonth = async (
  owner: string,
  month: string,
): Promise<readonly PayslipSummary[]> => {
  const items: PayslipSummary[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await database.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${owner}`,
          ":sk": `PAYROLL#${month}#`,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }),
    );
    for (const item of result.Items ?? []) {
      const payload = item.payload as PayslipSummary | undefined;
      if (payload?.uuid && typeof payload.totalMinor === "number") {
        items.push(payload);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.sort((a, b) => a.fechaPago.localeCompare(b.fechaPago) || a.uuid.localeCompare(b.uuid));
};

export const listPayslipsForYear = async (
  owner: string,
  year: string,
): Promise<readonly PayslipSummary[]> => {
  if (!/^\d{4}$/.test(year)) return [];
  const items: PayslipSummary[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await database.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${owner}`,
          ":sk": `PAYROLL#${year}-`,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }),
    );
    for (const item of result.Items ?? []) {
      const payload = item.payload as PayslipSummary | undefined;
      if (payload?.uuid && typeof payload.totalMinor === "number") {
        items.push(payload);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.sort((a, b) => a.fechaPago.localeCompare(b.fechaPago) || a.uuid.localeCompare(b.uuid));
};

export const getPayslip = async (
  owner: string,
  month: string,
  uuid: string,
): Promise<JsonObject | undefined> => {
  const result = await database.send(
    new GetCommand({
      TableName: tableName,
      Key: payrollKey(owner, month, uuid.toUpperCase()),
      ConsistentRead: true,
    }),
  );
  if (!result.Item?.payload) return undefined;
  return toPublicPayslip(
    result.Item.payload as PayslipSummary,
    String(result.Item.ingestedAt ?? ""),
    (result.Item.source as JsonObject) ?? {},
  );
};

export const listPriorOrdinaryPayslips = async (
  owner: string,
  beforeMonth: string,
  limit = 2,
): Promise<readonly PayslipSummary[]> => {
  const collected: PayslipSummary[] = [];
  let cursor: string | undefined = previousCalendarMonth(beforeMonth);
  let guard = 0;
  while (cursor && collected.length < limit && guard < 24) {
    const monthSlips = await listPayslipsForMonth(owner, cursor);
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

export const incomeFieldsForMonth = async (
  owner: string,
  month: string,
  now: Date = new Date(),
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
  const payslips = await listPayslipsForMonth(owner, month);
  const priorOrdinaryPayslips =
    payslips.length === 0 ? await listPriorOrdinaryPayslips(owner, month) : [];
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

const persistPayslip = async (
  owner: string,
  payslip: PayslipSummary,
  xml: string,
): Promise<"created" | "duplicate"> => {
  const sha256 = createHash("sha256").update(xml, "utf8").digest("hex");
  const key = sourceKey(owner, sha256);
  const ingestedAt = new Date().toISOString();
  const source = {
    kind: "cfdi_nomina",
    bucket: rawSourceBucketName,
    key,
    sha256,
    contentType: "application/xml",
  };

  const existing = await database.send(
    new GetCommand({
      TableName: tableName,
      Key: dedupeKey(payslip.uuid),
      ConsistentRead: true,
    }),
  );
  if (existing.Item) return "duplicate";

  await s3.send(
    new PutObjectCommand({
      Bucket: rawSourceBucketName,
      Key: key,
      Body: xml,
      ContentType: "application/xml; charset=utf-8",
    }),
  );

  try {
    await database.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                ...dedupeKey(payslip.uuid),
                entityType: "cfdi_nomina_dedupe",
                owner,
                uuid: payslip.uuid,
                month: payslip.month,
                claimedAt: ingestedAt,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                ...payrollKey(owner, payslip.month, payslip.uuid),
                entityType: "cfdi_nomina",
                owner,
                month: payslip.month,
                uuid: payslip.uuid,
                ingestedAt,
                source,
                payload: payslip,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "TransactionCanceledException" || name === "ConditionalCheckFailedException") {
      return "duplicate";
    }
    throw error;
  }
  return "created";
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
