import { createHash } from "node:crypto";

export class InvalidSantanderCsvError extends Error {}

export interface SantanderCsvRow {
  readonly rowNumber: number;
  readonly occurredOn: string;
  readonly transactionId?: string;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly occurrence: number;
  readonly identity: string;
}

export interface SantanderCsvDocument {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly declaredMovements: number;
  readonly rows: readonly SantanderCsvRow[];
}

export type SantanderReconciliationStatus = "new" | "matched" | "ambiguous" | "duplicate" | "excluded";

export interface SantanderReconciliationState {
  readonly status: SantanderReconciliationStatus;
  readonly candidateEventIds: readonly string[];
}

export type SantanderReconciliationDecision =
  | { readonly action: "create" }
  | { readonly action: "link"; readonly eventId: string };

export type SantanderApplyAction =
  | { readonly kind: "create" }
  | { readonly kind: "link"; readonly eventId: string }
  | { readonly kind: "skip" };

export const santanderImportCompletionUpdate = (
  appliedAt: string,
  result: { readonly created: number; readonly linked: number; readonly skipped: number },
) => ({
  UpdateExpression: "SET #status = :status, #appliedAt = :appliedAt, #result = :result",
  ExpressionAttributeNames: { "#status": "status", "#appliedAt": "appliedAt", "#result": "result" },
  ExpressionAttributeValues: { ":status": "applied", ":appliedAt": appliedAt, ":result": result },
});

export const santanderApplyAction = (
  current: SantanderReconciliationState,
  preview: SantanderReconciliationState | undefined,
  decision?: SantanderReconciliationDecision,
): SantanderApplyAction => {
  if (current.status === "new" && preview?.status === "new") return { kind: "create" };
  if (current.status === "matched" && preview?.status === "matched" && current.candidateEventIds[0] === preview.candidateEventIds[0]) {
    return { kind: "link", eventId: current.candidateEventIds[0] };
  }
  if (current.status === "ambiguous" && preview?.status === "ambiguous") {
    if (decision?.action === "create") return { kind: "create" };
    if (decision?.action === "link" && current.candidateEventIds.includes(decision.eventId)) return { kind: "link", eventId: decision.eventId };
  }
  return { kind: "skip" };
};

const monthNumbers: Readonly<Record<string, string>> = {
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12",
};

const csvFields = (line: string): string[] => {
  const result: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      result.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new InvalidSantanderCsvError("El CSV contiene comillas sin cerrar.");
  result.push(value.trim());
  return result;
};

const parseDate = (value: string): string => {
  const match = /^(\d{1,2})\/([A-Za-zÁÉÍÓÚáéíóú]{3})\/(\d{4})$/.exec(value.trim());
  const month = match && monthNumbers[match[2].toLowerCase()];
  if (!match || !month) throw new InvalidSantanderCsvError(`Fecha Santander inválida: ${value}`);
  const day = match[1].padStart(2, "0");
  const date = `${match[3]}-${month}-${day}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (parsed.toISOString().slice(0, 10) !== date) throw new InvalidSantanderCsvError(`Fecha Santander inválida: ${value}`);
  return date;
};

const parseAmount = (fields: readonly string[]): number => {
  const raw = fields.join(",").replace(/^\$\s*/, "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) throw new InvalidSantanderCsvError(`Importe Santander inválido: ${fields.join(",")}`);
  const amountMinor = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) throw new InvalidSantanderCsvError(`Importe Santander inválido: ${fields.join(",")}`);
  return amountMinor;
};

export const normaliseMerchant = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "")
  .replace(/^(?:PAGO|COMPRA)(?:CON|POR)?/, "");

export const merchantsMatch = (left: string, right: string): boolean => {
  const a = normaliseMerchant(left);
  const b = normaliseMerchant(right);
  return a === b || (Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a)));
};

export const fallbackFingerprint = (accountLastFour: string, row: Pick<SantanderCsvRow, "occurredOn" | "merchantRaw" | "amountMinor" | "occurrence">): string =>
  createHash("sha256").update([
    "santander_mx",
    accountLastFour,
    row.occurredOn,
    normaliseMerchant(row.merchantRaw),
    String(row.amountMinor),
    String(row.occurrence),
  ].join(":"), "utf8").digest("hex");

export const parseSantanderCsv = (input: string): SantanderCsvDocument => {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const accountLastFour = /No\. de Tarjeta:\s*\d{4}\*+(\d{4})/i.exec(lines[0] ?? "")?.[1];
  const product = /^Producto:\s*(.+)$/i.exec(lines[1] ?? "")?.[1]?.trim();
  const detail = /^Detalle del\s+(.+?)\s+al\s+(.+?),\s*Total de movimientos:\s*(\d+)$/i.exec(lines[3] ?? "");
  const headerIndex = lines.findIndex((line) => line.trim().toUpperCase() === "FECHA,CONSECUTIVO,CONCEPTO,IMPORTE");
  if (!accountLastFour || !product || !detail || headerIndex < 0) {
    throw new InvalidSantanderCsvError("El archivo no tiene el formato de movimientos de tarjeta Santander esperado.");
  }

  const occurrenceCounts = new Map<string, number>();
  const rows = lines.slice(headerIndex + 1).map((line, index): SantanderCsvRow => {
    const fields = csvFields(line);
    if (fields.length < 4) throw new InvalidSantanderCsvError(`La fila ${headerIndex + index + 2} está incompleta.`);
    const occurredOn = parseDate(fields[0]);
    const transactionId = fields[1] || undefined;
    if (transactionId && !/^\d+$/.test(transactionId)) throw new InvalidSantanderCsvError(`Consecutivo inválido en la fila ${headerIndex + index + 2}.`);
    const merchantRaw = fields[2].trim();
    if (!merchantRaw) throw new InvalidSantanderCsvError(`Concepto vacío en la fila ${headerIndex + index + 2}.`);
    const amountMinor = parseAmount(fields.slice(3));
    const base = [occurredOn, normaliseMerchant(merchantRaw), amountMinor].join(":");
    const occurrence = (occurrenceCounts.get(base) ?? 0) + 1;
    occurrenceCounts.set(base, occurrence);
    const row = {
      rowNumber: headerIndex + index + 2,
      occurredOn,
      ...(transactionId ? { transactionId } : {}),
      merchantRaw,
      amountMinor,
      occurrence,
    };
    return {
      ...row,
      identity: transactionId
        ? `santander_mx:${accountLastFour}:transaction:${transactionId}`
        : `santander_mx:${accountLastFour}:fallback:${fallbackFingerprint(accountLastFour, row)}`,
    };
  });

  const declaredMovements = Number(detail[3]);
  if (rows.length !== declaredMovements) {
    throw new InvalidSantanderCsvError(`El archivo declara ${declaredMovements} movimientos, pero contiene ${rows.length}.`);
  }
  return {
    accountLastFour,
    product,
    period: { from: parseDate(detail[1]), to: parseDate(detail[2]) },
    declaredMovements,
    rows,
  };
};
