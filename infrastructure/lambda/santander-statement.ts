export class InvalidSantanderStatementError extends Error {}

export interface SantanderStatementCharge {
  readonly occurredOn: string;
  readonly postedOn?: string;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly credit: boolean;
  readonly msi: boolean;
  readonly identity: string;
}

export interface SantanderStatementDocument {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly charges: readonly SantanderStatementCharge[];
  readonly msiCharges: readonly SantanderStatementCharge[];
}

const monthNumbers: Readonly<Record<string, string>> = {
  ene: "01",
  feb: "02",
  mar: "03",
  abr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  ago: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dic: "12",
};

const normalizeLines = (input: string): string[] =>
  input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && !/^=====/.test(line));

const parseMoneyMinor = (raw: string): number | undefined => {
  const cleaned = raw
    .replace(/[\$S]/g, "")
    .replace(/\s/g, "")
    .replace(/,/g, "")
    .replace(/[|\[\]]/g, "")
    .trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return undefined;
  const amountMinor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(amountMinor) && amountMinor !== 0 ? amountMinor : undefined;
};

const parseDayMonthYear = (raw: string): string | undefined => {
  const match = /^(\d{1,2})[-\/.]([A-Za-z]{3}|\d{1,2})[-\/.](\d{2,4})/.exec(raw.trim().replace(/_/g, ""));
  if (!match) return undefined;
  const day = match[1].padStart(2, "0");
  let month = match[2];
  if (/^\d+$/.test(month)) month = month.padStart(2, "0");
  else month = monthNumbers[month.toLowerCase()] ?? "";
  if (!month) return undefined;
  let year = match[3];
  if (year.length === 2) year = `20${year}`;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  return parsed.toISOString().slice(0, 10) === date ? date : undefined;
};

const parsePeriod = (text: string): { from: string; to: string } => {
  const match =
    /Periodo:\s*(\d{1,2})[-\/.]([A-Za-z]{3})[-\/.](\d{4})\s+al\s+(\d{1,2})[-\/.]([A-Za-z]{3})[-\/.](\d{4})/i
      .exec(text);
  if (!match) throw new InvalidSantanderStatementError("No se encontró el periodo del estado Santander.");
  const from = parseDayMonthYear(`${match[1]}-${match[2]}-${match[3]}`);
  const to = parseDayMonthYear(`${match[4]}-${match[5]}-${match[6]}`);
  if (!from || !to) throw new InvalidSantanderStatementError("El periodo del estado Santander es inválido.");
  return { from, to };
};

const parseAccountLastFour = (text: string): string => {
  const match =
    /N[uú]mero de tarjeta:\s*[\d\s]*(\d{4})\b/i.exec(text)
    ?? /N[uú]mero de cuenta:\s*[\d\s]*(\d{4})\b/i.exec(text)
    ?? /\b(\d{4})\s+\d{4}\s+\d{4}\s+(\d{4})\b/.exec(text);
  if (!match) throw new InvalidSantanderStatementError("No se encontró el número de tarjeta Santander.");
  return match[2] ?? match[1];
};

const isMsiMerchant = (merchantRaw: string): boolean =>
  /\bA\s*MESES\b/i.test(merchantRaw) || /\bMSI\b/i.test(merchantRaw);

const cleanMerchant = (raw: string): string =>
  raw
    .replace(/[\[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bMOM\b.*$/i, "")
    .trim();

/**
 * Parse OCR/Textract plain text from a Santander MX credit-card statement.
 * Tolerates noisy separators from image OCR (`_`, `[`, `|`, `$`/`S` confusion).
 */
export const parseSantanderStatementText = (input: string): SantanderStatementDocument => {
  const lines = normalizeLines(input);
  const text = lines.join("\n");
  const period = parsePeriod(text);
  const accountLastFour = parseAccountLastFour(text);
  const product = /UNIQUE REWARDS|PLATINUM|PLATINO/i.test(text)
    ? "Santander Unique Rewards Platinum"
    : "Santander";

  const charges: SantanderStatementCharge[] = [];
  const rowPattern =
    /(\d{1,2}[-\/.][A-Za-z0-9]{2,3}[-\/.]\d{2,4})\s*[\[|_]?\s*(\d{1,2}[-\/.][A-Za-z0-9]{2,3}[-\/.]\d{2,4})?\s*[\[|_]?\s*(.+?)\s+(-?\s*[\$S]?\s*[\d,]+\.\d{2})\s*$/i;

  for (const line of lines) {
    if (/PAGO POR TRANSFERENCIA|Total de cargos|Total de abonos|NOTAS ACLARATORIAS/i.test(line)) {
      if (/PAGO POR TRANSFERENCIA/i.test(line)) continue;
      if (/Total de/i.test(line)) continue;
    }
    const match = rowPattern.exec(line);
    if (!match) continue;
    const occurredOn = parseDayMonthYear(match[1]);
    const postedOn = match[2] ? parseDayMonthYear(match[2]) : undefined;
    if (!occurredOn) continue;
    const amountMinor = parseMoneyMinor(match[4]);
    if (amountMinor === undefined) continue;
    const merchantRaw = cleanMerchant(match[3]);
    if (!merchantRaw || merchantRaw.length < 3) continue;
    if (/^Fecha\b/i.test(merchantRaw) || /^Tarjeta\b/i.test(merchantRaw)) continue;
    const credit = amountMinor < 0 || /\bPAGO\b|\bABONO\b|\bCASH BACK\b/i.test(merchantRaw);
    const absolute = Math.abs(amountMinor);
    const msi = isMsiMerchant(merchantRaw);
    const identity = [
      "santander_statement",
      accountLastFour,
      occurredOn,
      merchantRaw.toUpperCase(),
      String(absolute),
      msi ? "msi" : "full",
      String(charges.length + 1),
    ].join(":");
    charges.push({
      occurredOn,
      postedOn,
      merchantRaw,
      amountMinor: absolute,
      credit,
      msi,
      identity,
    });
  }

  const msiCharges = charges.filter((charge) => charge.msi && !charge.credit);
  if (msiCharges.length === 0 && charges.length === 0) {
    throw new InvalidSantanderStatementError(
      "No se pudieron leer movimientos del estado Santander. Revisa que el PDF sea el estado de cuenta de la tarjeta.",
    );
  }

  return {
    accountLastFour,
    product,
    period,
    charges: charges.filter((charge) => !charge.credit),
    msiCharges,
  };
};

export const santanderStatementImportCompletionUpdate = (
  appliedAt: string,
  result: { readonly confirmed: number; readonly createdUnplanned: number; readonly skipped: number },
) => ({
  UpdateExpression: "SET #status = :status, #appliedAt = :appliedAt, #result = :result",
  ExpressionAttributeNames: { "#status": "status", "#appliedAt": "appliedAt", "#result": "result" },
  ExpressionAttributeValues: { ":status": "applied", ":appliedAt": appliedAt, ":result": result },
});
