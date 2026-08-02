import {
  extractLastFourDigits,
  findPeriodInLooseText,
  parseFlexibleDate,
} from "./statement-dates.js";
import type { TextractStatementExtraction, TextractTable } from "./textract-document.js";

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

const parsePeriod = (
  text: string,
  answers: Readonly<Record<string, string>> = {},
): { from: string; to: string } => {
  const fromAnswer = parseFlexibleDate(answers.PERIOD_FROM);
  const toAnswer = parseFlexibleDate(answers.PERIOD_TO);
  if (fromAnswer && toAnswer) return { from: fromAnswer, to: toAnswer };

  const fromPeriodText = findPeriodInLooseText(answers.PERIOD_TEXT ?? "");
  if (fromPeriodText) return fromPeriodText;

  const loose = findPeriodInLooseText(text);
  if (loose) return loose;

  throw new InvalidSantanderStatementError("No se encontró el periodo del estado Santander.");
};

const parseAccountLastFour = (
  text: string,
  answers: Readonly<Record<string, string>> = {},
): string => {
  const fromAnswer = extractLastFourDigits(answers.ACCOUNT_LAST_FOUR);
  if (fromAnswer) return fromAnswer;
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

const chargesFromTables = (
  tables: readonly TextractTable[],
  accountLastFour: string,
): readonly SantanderStatementCharge[] => {
  const charges: SantanderStatementCharge[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const cells = row.map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const joined = cells.join(" ");
      const dateCell = cells.find((cell) => parseDayMonthYear(cell) || parseFlexibleDate(cell));
      const occurredOn = dateCell
        ? (parseDayMonthYear(dateCell) ?? parseFlexibleDate(dateCell))
        : undefined;
      if (!occurredOn) continue;
      const amountCell = [...cells].reverse().find((cell) => parseMoneyMinor(cell) !== undefined);
      const amountMinor = amountCell ? parseMoneyMinor(amountCell) : undefined;
      if (amountMinor === undefined) continue;
      const merchantRaw = cleanMerchant(
        cells
          .filter((cell) => cell !== dateCell && cell !== amountCell)
          .join(" ")
          || joined,
      );
      if (!merchantRaw || merchantRaw.length < 3) continue;
      if (/^Fecha\b/i.test(merchantRaw) || /^Tarjeta\b/i.test(merchantRaw)) continue;
      const credit = amountMinor < 0 || /\bPAGO\b|\bABONO\b|\bCASH BACK\b/i.test(merchantRaw);
      const absolute = Math.abs(amountMinor);
      const msi = isMsiMerchant(merchantRaw);
      charges.push({
        occurredOn,
        merchantRaw,
        amountMinor: absolute,
        credit,
        msi,
        identity: [
          "santander_statement_table",
          accountLastFour,
          occurredOn,
          merchantRaw.toUpperCase(),
          String(absolute),
          msi ? "msi" : "full",
          String(charges.length + 1),
        ].join(":"),
      });
    }
  }
  return charges;
};

const chargesFromLines = (
  lines: readonly string[],
  accountLastFour: string,
): readonly SantanderStatementCharge[] => {
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
    charges.push({
      occurredOn,
      postedOn,
      merchantRaw,
      amountMinor: absolute,
      credit,
      msi,
      identity: [
        "santander_statement",
        accountLastFour,
        occurredOn,
        merchantRaw.toUpperCase(),
        String(absolute),
        msi ? "msi" : "full",
        String(charges.length + 1),
      ].join(":"),
    });
  }
  return charges;
};

/**
 * Preferred path: map Textract AnalyzeDocument (queries + tables + lines).
 * Queries own period/account; tables/lines own movement rows.
 */
export const parseSantanderStatementExtraction = (
  extraction: TextractStatementExtraction,
): SantanderStatementDocument => {
  const text = extraction.text;
  const period = parsePeriod(text, extraction.answers);
  const accountLastFour = parseAccountLastFour(text, extraction.answers);
  const productHint = `${extraction.answers.PRODUCT ?? ""} ${text}`;
  const product = /UNIQUE REWARDS|PLATINUM|PLATINO/i.test(productHint)
    ? "Santander Unique Rewards Platinum"
    : (extraction.answers.PRODUCT?.trim() || "Santander");

  const seen = new Set<string>();
  const charges: SantanderStatementCharge[] = [];
  for (const charge of [
    ...chargesFromTables(extraction.tables, accountLastFour),
    ...chargesFromLines(extraction.lines, accountLastFour),
  ]) {
    if (charge.credit) continue;
    const key = [charge.occurredOn, charge.merchantRaw, charge.amountMinor, charge.msi].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    charges.push(charge);
  }

  const msiCharges = charges.filter((charge) => charge.msi);
  if (charges.length === 0) {
    throw new InvalidSantanderStatementError(
      `Textract no encontró movimientos Santander (answers=${Object.keys(extraction.answers).join(",") || "∅"}, tables=${extraction.tables.length}, lines=${extraction.lines.length}).`,
    );
  }

  return {
    accountLastFour,
    product,
    period,
    charges,
    msiCharges,
  };
};
