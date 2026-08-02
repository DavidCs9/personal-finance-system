import {
  extractLastFourDigits,
  findPeriodInLooseText,
  parseFlexibleDate,
} from "./statement-dates.js";
import type { TextractStatementExtraction, TextractTable } from "./textract-document.js";

export class InvalidAmexStatementError extends Error {}

export interface AmexStatementCharge {
  readonly occurredOn: string;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly credit: boolean;
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
  readonly msi: boolean;
  readonly identity: string;
}

export interface AmexMsiPlanSummary {
  readonly merchantRaw: string;
  readonly originalOn?: string;
  readonly originalAmountMinor: number;
  readonly pendingMinor: number;
  readonly installmentIndex: number;
  readonly installmentMonths: number;
  readonly cuotaMinor: number;
}

export interface AmexStatementDocument {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly charges: readonly AmexStatementCharge[];
  readonly msiPlans: readonly AmexMsiPlanSummary[];
}

const monthNames: Readonly<Record<string, string>> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
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

const moneyPattern = /^-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?$|^-?\d+(?:\.\d{2})?$/;

const parseMoneyMinor = (raw: string): number | undefined => {
  const cleaned = raw.replace(/\$/g, "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return undefined;
  const amountMinor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(amountMinor) ? amountMinor : undefined;
};

const resolveYear = (month: string, periodTo: string): string => {
  const periodYear = Number(periodTo.slice(0, 4));
  const periodMonth = Number(periodTo.slice(5, 7));
  const chargeMonth = Number(month);
  if (chargeMonth > periodMonth + 1) return String(periodYear - 1);
  return String(periodYear);
};

const parseSpanishDate = (day: string, monthToken: string, periodTo: string): string | undefined => {
  const month = monthNames[monthToken.toLowerCase()];
  if (!month) return undefined;
  const year = resolveYear(month, periodTo);
  const date = `${year}-${month}-${day.padStart(2, "0")}`;
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

  // Header often shows "Fecha de Corte" as DD-Mon-YYYY; previous corte ≈ period start+1 month back is weak,
  // but end-of-period = corte date is reliable enough when billing text is mangled by OCR.
  const corte = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/i.exec(text);
  if (corte) {
    const to = parseFlexibleDate(`${corte[1]}-${corte[2]}-${corte[3]}`);
    if (to) {
      const end = new Date(`${to}T12:00:00Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 29);
      const from = start.toISOString().slice(0, 10);
      return { from, to };
    }
  }

  throw new InvalidAmexStatementError("No se encontró el periodo de facturación Amex.");
};

const parseAccountLastFour = (
  text: string,
  answers: Readonly<Record<string, string>> = {},
): string => {
  const fromAnswer = extractLastFourDigits(answers.ACCOUNT_LAST_FOUR);
  if (fromAnswer) return fromAnswer;
  const match = /N[uú]mero de Cuenta:\s*[\d-]*(\d{4})\b/i.exec(text)
    ?? /Tarjetahabiente\s+[\d-]*(\d{4})\b/i.exec(text)
    ?? /\b(?:3401|3717)[\d-]*(\d{4})\b/.exec(text)
    ?? /\b(\d{4})\b/.exec(answers.ACCOUNT_LAST_FOUR ?? "");
  if (!match) throw new InvalidAmexStatementError("No se encontró el número de cuenta Amex.");
  return match[1];
};

const parseProduct = (text: string, answers: Readonly<Record<string, string>> = {}): string => {
  const hinted = `${answers.PRODUCT ?? ""} ${text}`;
  if (/Aerom[eé]xico/i.test(hinted)) return "American Express Aeroméxico";
  if (/Gold Elite/i.test(hinted)) return "The Gold Elite Credit Card American Express";
  if (/American Express/i.test(hinted)) return "American Express";
  return answers.PRODUCT?.trim() || "American Express";
};

const installmentFrom = (line: string): { index: number; months: number } | undefined => {
  const match = /CARGO\s+(\d{1,2})\s+DE\s+(\d{1,2})/i.exec(line);
  if (!match) return undefined;
  return { index: Number(match[1]), months: Number(match[2]) };
};

const isNoiseLine = (line: string): boolean =>
  /^(RFC|D[oó]lar U\.S\.A\.|TC:|Total de|Este no es|Estado de Cuenta|N[uú]mero de Cuenta|Fecha y Detalle|P[aá]gina|Nuevos cargos|GRACIAS POR SU PAGO)/i
    .test(line);

const msiFromTables = (
  tables: readonly TextractTable[],
  accountLastFour: string,
  periodTo: string,
): readonly AmexStatementCharge[] => {
  const charges: AmexStatementCharge[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const joined = row.join(" ").replace(/\s+/g, " ").trim();
      if (!joined) continue;
      const installment = installmentFrom(joined);
      if (!installment && !/MESES EN AUTOM/i.test(joined)) continue;
      const moneyMatches = [...joined.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/g)];
      const amountRaw = moneyMatches.at(-1)?.[1];
      const amountMinor = amountRaw ? parseMoneyMinor(amountRaw) : undefined;
      if (amountMinor === undefined || amountMinor <= 0) continue;
      const dated = /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)/i.exec(joined);
      const occurredOn = dated
        ? parseSpanishDate(dated[1], dated[2], periodTo)
        : periodTo;
      if (!occurredOn) continue;
      let merchantRaw = joined
        .replace(/CARGO\s+\d{1,2}\s+DE\s+\d{1,2}/ig, " ")
        .replace(/\d{1,3}(?:,\d{3})*\.\d{2}/g, " ")
        .replace(/\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚáéíóú]+/ig, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!merchantRaw || merchantRaw.length < 3) {
        merchantRaw = /MESES EN AUTOM/i.test(joined) ? "MESES EN AUTOMÁTICO NACIONAL" : "MSI";
      }
      charges.push({
        occurredOn,
        merchantRaw,
        amountMinor: Math.abs(amountMinor),
        credit: false,
        installmentIndex: installment?.index,
        installmentMonths: installment?.months,
        msi: true,
        identity: [
          "amex_statement_table",
          accountLastFour,
          occurredOn,
          merchantRaw,
          String(Math.abs(amountMinor)),
          installment ? `${installment.index}/${installment.months}` : "msi",
          String(charges.length + 1),
        ].join(":"),
      });
    }
  }
  return charges;
};

const parseChargesAndPlansFromLines = (
  lines: readonly string[],
  accountLastFour: string,
  period: { readonly from: string; readonly to: string },
): { charges: AmexStatementCharge[]; msiPlans: AmexMsiPlanSummary[] } => {
  const charges: AmexStatementCharge[] = [];
  const msiSectionStart = lines.findIndex((line) => /Transacciones de Meses sin Intereses/i.test(line));
  const detailStart = lines.findIndex((line) => /Fecha y Detalle de las operaciones/i.test(line));
  const scanStart = detailStart >= 0 ? detailStart + 1 : 0;
  const scanEnd = msiSectionStart >= 0 ? msiSectionStart : lines.length;

  for (let index = scanStart; index < scanEnd; index += 1) {
    const line = lines[index];
    const dated = /^(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+(.+)$/i.exec(line);
    if (!dated) continue;
    const occurredOn = parseSpanishDate(dated[1], dated[2], period.to);
    if (!occurredOn) continue;
    let merchantRaw = dated[3].trim();
    if (/^GRACIAS POR SU PAGO/i.test(merchantRaw)) continue;

    let installment: { index: number; months: number } | undefined;
    let amountMinor: number | undefined;
    let credit = false;
    for (let look = 1; look <= 4 && index + look < scanEnd; look += 1) {
      const next = lines[index + look];
      if (!next || isNoiseLine(next) && !installmentFrom(next) && parseMoneyMinor(next) === undefined) {
        if (/^CR$/i.test(next)) {
          credit = true;
          continue;
        }
      }
      const maybeInstallment = installmentFrom(next);
      if (maybeInstallment) {
        installment = maybeInstallment;
        continue;
      }
      const money = parseMoneyMinor(next);
      if (money !== undefined && moneyPattern.test(next.replace(/\$/g, "").trim())) {
        amountMinor = Math.abs(money);
        break;
      }
      if (/^\d{1,2}\s+de\s+/i.test(next)) break;
    }
    if (amountMinor === undefined || amountMinor <= 0) continue;
    const msi = Boolean(installment) || /MESES EN AUTOM[AÁ]TICO/i.test(merchantRaw);
    charges.push({
      occurredOn,
      merchantRaw,
      amountMinor,
      credit,
      installmentIndex: installment?.index,
      installmentMonths: installment?.months,
      msi,
      identity: [
        "amex_statement",
        accountLastFour,
        occurredOn,
        merchantRaw,
        String(amountMinor),
        installment ? `${installment.index}/${installment.months}` : "full",
        String(charges.length + 1),
      ].join(":"),
    });
  }

  if (msiSectionStart >= 0) {
    for (let index = msiSectionStart; index < lines.length; index += 1) {
      const line = lines[index];
      const dated = /^(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+(.+)$/i.exec(line);
      if (!dated) continue;
      if (/Resumen de Meses/i.test(line) || /Consolidado de compras/i.test(line)) break;
      const occurredOn = parseSpanishDate(dated[1], dated[2], period.to);
      if (!occurredOn) continue;
      const merchantRaw = dated[3].trim();
      const installmentLine = lines[index + 1] ?? "";
      const installment = installmentFrom(installmentLine);
      const amountLine = lines[index + 2] ?? lines[index + 1] ?? "";
      const amountMinor = parseMoneyMinor(amountLine);
      if (!installment || amountMinor === undefined) continue;
      charges.push({
        occurredOn,
        merchantRaw,
        amountMinor: Math.abs(amountMinor),
        credit: false,
        installmentIndex: installment.index,
        installmentMonths: installment.months,
        msi: true,
        identity: [
          "amex_statement_msi",
          accountLastFour,
          occurredOn,
          merchantRaw,
          String(Math.abs(amountMinor)),
          `${installment.index}/${installment.months}`,
          String(charges.length + 1),
        ].join(":"),
      });
    }
  }

  const msiPlans: AmexMsiPlanSummary[] = [];
  const detailPattern =
    /^(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+([\d,]+\.\d{2})\s+([\d.]+)%\s+([\d,]+\.\d{2})\s+(\d{1,2})\s+de\s+(\d{1,2})\s+([\d,]+\.\d{2})/i;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/Mensualidad=\(Pago a capital/i.test(lines[index] ?? "")) continue;
    const merchantRaw = (lines[index - 1] ?? "").trim();
    if (!merchantRaw) continue;
    let detailMatch: RegExpExecArray | null = null;
    for (let look = 1; look <= 3; look += 1) {
      detailMatch = detailPattern.exec(lines[index + look] ?? "");
      if (detailMatch) break;
    }
    if (!detailMatch) continue;
    const originalOn = parseSpanishDate(detailMatch[1], detailMatch[2], period.to);
    const originalAmountMinor = parseMoneyMinor(detailMatch[3]);
    const pendingMinor = parseMoneyMinor(detailMatch[5]);
    const cuotaMinor = parseMoneyMinor(detailMatch[8]);
    if (originalAmountMinor === undefined || pendingMinor === undefined || cuotaMinor === undefined) continue;
    msiPlans.push({
      merchantRaw,
      originalOn,
      originalAmountMinor,
      pendingMinor,
      installmentIndex: Number(detailMatch[6]),
      installmentMonths: Number(detailMatch[7]),
      cuotaMinor,
    });
  }

  return { charges, msiPlans };
};

/**
 * Map Textract AnalyzeDocument output into an Amex statement.
 * Queries own metadata (with LINE text fallback); tables + LINE blocks own movements.
 */
export const parseAmexStatementExtraction = (
  extraction: TextractStatementExtraction,
): AmexStatementDocument => {
  const text = extraction.text;
  const period = parsePeriod(text, extraction.answers);
  const accountLastFour = parseAccountLastFour(text, extraction.answers);
  const product = parseProduct(text, extraction.answers);
  const fromLines = parseChargesAndPlansFromLines(extraction.lines, accountLastFour, period);
  const fromTables = msiFromTables(extraction.tables, accountLastFour, period.to);

  const seen = new Set<string>();
  const charges: AmexStatementCharge[] = [];
  for (const charge of [...fromLines.charges, ...fromTables]) {
    if (charge.credit) continue;
    const key = [
      charge.occurredOn,
      charge.merchantRaw,
      charge.amountMinor,
      charge.installmentIndex ?? "",
      charge.installmentMonths ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    charges.push(charge);
  }

  if (charges.length === 0 && fromLines.msiPlans.length === 0) {
    throw new InvalidAmexStatementError(
      `Textract no encontró movimientos Amex (answers=${Object.keys(extraction.answers).join(",") || "∅"}, tables=${extraction.tables.length}, lines=${extraction.lines.length}).`,
    );
  }

  return {
    accountLastFour,
    product,
    period,
    charges,
    msiPlans: fromLines.msiPlans,
  };
};
