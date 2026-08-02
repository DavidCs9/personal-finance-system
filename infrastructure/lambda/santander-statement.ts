import { extractLastFourDigits, parseFlexibleDate } from "./statement-dates.js";
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
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12",
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
  const flexible = parseFlexibleDate(raw);
  if (flexible) return flexible;
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
  return new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date ? date : undefined;
};

const periodFromAnswers = (
  answers: Readonly<Record<string, string>>,
): { from: string; to: string } => {
  const from = parseFlexibleDate(answers.PERIOD_FROM) ?? parseDayMonthYear(answers.PERIOD_FROM ?? "");
  const to = parseFlexibleDate(answers.PERIOD_TO) ?? parseDayMonthYear(answers.PERIOD_TO ?? "");
  if (from && to) return { from, to };

  const periodText = answers.PERIOD_TEXT ?? "";
  const match =
    /(\d{1,2}[-\/.][A-Za-z0-9]{2,9}[-\/.]\d{2,4})\s+al\s+(\d{1,2}[-\/.][A-Za-z0-9]{2,9}[-\/.]\d{2,4})/i
      .exec(periodText);
  if (!match) throw new InvalidSantanderStatementError("Textract no devolvió el periodo del estado Santander.");
  const parsedFrom = parseDayMonthYear(match[1]);
  const parsedTo = parseDayMonthYear(match[2]);
  if (!parsedFrom || !parsedTo) {
    throw new InvalidSantanderStatementError("Textract devolvió un periodo Santander inválido.");
  }
  return { from: parsedFrom, to: parsedTo };
};

const accountFromAnswers = (answers: Readonly<Record<string, string>>): string => {
  const lastFour = extractLastFourDigits(answers.ACCOUNT_LAST_FOUR);
  if (!lastFour) throw new InvalidSantanderStatementError("Textract no devolvió el número de tarjeta Santander.");
  return lastFour;
};

const productFromAnswers = (answers: Readonly<Record<string, string>>): string => {
  const product = answers.PRODUCT?.trim() ?? "";
  if (/UNIQUE REWARDS|PLATINUM|PLATINO/i.test(product)) return "Santander Unique Rewards Platinum";
  return product || "Santander";
};

const isMsiMerchant = (merchantRaw: string): boolean =>
  /\bA\s*MESES\b/i.test(merchantRaw) || /\bMSI\b/i.test(merchantRaw);

const cleanMerchant = (raw: string): string =>
  raw.replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").replace(/\bMOM\b.*$/i, "").trim();

const chargesFromTables = (
  tables: readonly TextractTable[],
  accountLastFour: string,
): SantanderStatementCharge[] => {
  const charges: SantanderStatementCharge[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const cells = row.map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const dateCells = cells.filter((cell) => parseDayMonthYear(cell));
      const occurredOn = dateCells[0] ? parseDayMonthYear(dateCells[0]) : undefined;
      if (!occurredOn) continue;
      const postedOn = dateCells[1] ? parseDayMonthYear(dateCells[1]) : undefined;
      const amountCell = [...cells].reverse().find((cell) => parseMoneyMinor(cell) !== undefined);
      const amountMinor = amountCell ? parseMoneyMinor(amountCell) : undefined;
      if (amountMinor === undefined) continue;
      const merchantRaw = cleanMerchant(
        cells.filter((cell) => cell !== dateCells[0] && cell !== dateCells[1] && cell !== amountCell).join(" "),
      );
      if (!merchantRaw || merchantRaw.length < 3) continue;
      if (/^Fecha\b|^Tarjeta\b|Total de cargos|Total de abonos|NOTAS ACLARATORIAS/i.test(merchantRaw)) continue;
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
  }
  return charges;
};

/** Map Textract AnalyzeDocument output into a Santander statement. Queries + tables only. */
export const parseSantanderStatementExtraction = (
  extraction: TextractStatementExtraction,
): SantanderStatementDocument => {
  const period = periodFromAnswers(extraction.answers);
  const accountLastFour = accountFromAnswers(extraction.answers);
  const product = productFromAnswers(extraction.answers);
  const charges = chargesFromTables(extraction.tables, accountLastFour).filter((charge) => !charge.credit);
  const msiCharges = charges.filter((charge) => charge.msi);

  if (charges.length === 0) {
    throw new InvalidSantanderStatementError(
      "Textract no encontró movimientos en tablas del estado Santander.",
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
