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

export interface AmexDeferralCredit {
  readonly occurredOn: string;
  readonly amountMinor: number;
  readonly merchantRaw: string;
  readonly identity: string;
}

export interface AmexStatementDocument {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly charges: readonly AmexStatementCharge[];
  readonly msiPlans: readonly AmexMsiPlanSummary[];
  /** Credits that move purchases into MESES EN AUTOMÁTICO (excluded from spend). */
  readonly deferralCredits: readonly AmexDeferralCredit[];
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
const trailingMoneyPattern = /(-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2})\s*$/;

const parseMoneyMinor = (raw: string): number | undefined => {
  const cleaned = raw.replace(/\$/g, "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return undefined;
  const amountMinor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(amountMinor) ? amountMinor : undefined;
};

const cleanMerchant = (raw: string): string =>
  raw
    .replace(/CARGO\s+\d{1,2}\s+DE\s+\d{1,2}/ig, " ")
    .replace(/Mensualidad\s*=\s*\([^)]*\)/ig, " ")
    .replace(/\bRFC[A-Z0-9]+\b/ig, " ")
    .replace(/\/?REF\S*(?:\s+[A-Z0-9#]+)?/ig, " ")
    .replace(/D[oó]lar U\.S\.A\./ig, " ")
    .replace(/\bTC:\s*[\d.]+/ig, " ")
    .replace(/\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g, " ")
    .replace(/\bCR\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();

const parseAmountCell = (
  raw: string,
): { readonly amountMinor: number; readonly credit: boolean } | undefined => {
  const credit = /\bCR\b/i.test(raw);
  const match = /(-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2})/.exec(raw.replace(/\$/g, ""));
  if (!match) return undefined;
  const amountMinor = parseMoneyMinor(match[1]);
  if (amountMinor === undefined) return undefined;
  return { amountMinor: Math.abs(amountMinor), credit };
};

const spanishDateIn = (raw: string, periodTo: string): string | undefined => {
  const match = /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)/i.exec(raw.trim());
  if (!match) return undefined;
  return parseSpanishDate(match[1], match[2], periodTo);
};

const splitTrailingAmount = (
  raw: string,
): { readonly merchantRaw: string; readonly amountMinor?: number } => {
  const match = trailingMoneyPattern.exec(raw.trim());
  if (!match || match.index === undefined) return { merchantRaw: raw.trim() };
  const amountMinor = parseMoneyMinor(match[1]);
  if (amountMinor === undefined) return { merchantRaw: raw.trim() };
  return {
    merchantRaw: raw.slice(0, match.index).trim(),
    amountMinor: Math.abs(amountMinor),
  };
};

const isPlanSummaryNoise = (line: string): boolean =>
  /Mensualidad\s*=/i.test(line)
  || /\d+\.\d{2}\s*%/.test(line)
  || /Consolidado de compras|Resumen de Meses|Total de Plan/i.test(line);

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

/**
 * AnalyzeDocument TABLES keep Amex charge rows intact (date | merchant | amount).
 * LINE blocks often scramble those columns, so tables are the primary source for compras.
 */
const chargesFromTables = (
  tables: readonly TextractTable[],
  accountLastFour: string,
  periodTo: string,
): readonly AmexStatementCharge[] => {
  const charges: AmexStatementCharge[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const cells = row.map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const joined = cells.join(" ").replace(/\s+/g, " ").trim();
      if (!joined || isPlanSummaryNoise(joined)) continue;
      if (/^Fecha y Detalle|^Total de\b|^Importe\b/i.test(joined)) continue;

      const dateCell = cells.find((cell) => spanishDateIn(cell, periodTo));
      const occurredOn = dateCell ? spanishDateIn(dateCell, periodTo) : undefined;
      if (!occurredOn) continue;

      const amountCell = [...cells].reverse().find((cell) => parseAmountCell(cell));
      const parsedAmount = amountCell ? parseAmountCell(amountCell) : undefined;
      if (!parsedAmount || parsedAmount.amountMinor <= 0) continue;

      const installment = installmentFrom(joined);
      let merchantRaw = cleanMerchant(
        cells
          .filter((cell) => cell !== dateCell && cell !== amountCell)
          .join(" ")
          .replace(/\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚáéíóú]+/ig, " "),
      );
      if (!merchantRaw || merchantRaw.length < 3) {
        merchantRaw = /MESES EN AUTOM/i.test(joined) ? "MESES EN AUTOMÁTICO NACIONAL" : "";
      }
      if (!merchantRaw || merchantRaw.length < 3) continue;
      if (/^GRACIAS POR SU PAGO/i.test(merchantRaw)) {
        charges.push({
          occurredOn,
          merchantRaw,
          amountMinor: parsedAmount.amountMinor,
          credit: true,
          msi: false,
          identity: [
            "amex_statement_table",
            accountLastFour,
            occurredOn,
            merchantRaw,
            String(parsedAmount.amountMinor),
            "credit",
            String(charges.length + 1),
          ].join(":"),
        });
        continue;
      }

      const isDeferral = /MONTO A DIFERIR/i.test(merchantRaw) || /DIFERIR MESES EN AUTOM/i.test(merchantRaw);
      const msi = !isDeferral && (Boolean(installment) || /MESES EN AUTOM[AÁ]TICO/i.test(merchantRaw));
      if (msi && !installment) continue;

      charges.push({
        occurredOn,
        merchantRaw,
        amountMinor: parsedAmount.amountMinor,
        credit: parsedAmount.credit || isDeferral,
        installmentIndex: installment?.index,
        installmentMonths: installment?.months,
        msi,
        identity: [
          "amex_statement_table",
          accountLastFour,
          occurredOn,
          merchantRaw,
          String(parsedAmount.amountMinor),
          installment ? `${installment.index}/${installment.months}` : (isDeferral ? "deferral" : "full"),
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
    if (isPlanSummaryNoise(line)) continue;
    const dated = /^(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+(.+)$/i.exec(line);
    if (!dated) continue;
    const occurredOn = parseSpanishDate(dated[1], dated[2], period.to);
    if (!occurredOn) continue;
    let merchantRaw = dated[3].trim();
    if (/^GRACIAS POR SU PAGO/i.test(merchantRaw)) continue;

    let installment = installmentFrom(merchantRaw);
    const inline = splitTrailingAmount(merchantRaw);
    merchantRaw = cleanMerchant(inline.merchantRaw);
    let amountMinor = inline.amountMinor;
    let credit = false;

    for (let look = 1; look <= 6 && index + look < scanEnd; look += 1) {
      const next = lines[index + look];
      if (!next) continue;
      if (/^CR$/i.test(next)) {
        credit = true;
        continue;
      }
      if (/^RFC/i.test(next) || /^D[oó]lar U\.S\.A\./i.test(next) || /^TC:/i.test(next)) continue;
      const maybeInstallment = installmentFrom(next);
      if (maybeInstallment) {
        installment = maybeInstallment;
        continue;
      }
      if (amountMinor !== undefined) {
        if (/^\d{1,2}\s+de\s+/i.test(next)) break;
        continue;
      }
      const money = parseMoneyMinor(next);
      if (money !== undefined && moneyPattern.test(next.replace(/\$/g, "").trim())) {
        amountMinor = Math.abs(money);
        continue;
      }
      const nextInline = splitTrailingAmount(next);
      if (nextInline.amountMinor !== undefined && !/^\d{1,2}\s+de\s+/i.test(next)) {
        amountMinor = nextInline.amountMinor;
        continue;
      }
      if (/^\d{1,2}\s+de\s+/i.test(next)) break;
      if (isNoiseLine(next)) continue;
    }
    if (!merchantRaw || merchantRaw.length < 3) continue;
    if (amountMinor === undefined || amountMinor <= 0) continue;
    const isDeferral = /MONTO A DIFERIR/i.test(merchantRaw) || /DIFERIR MESES EN AUTOM/i.test(merchantRaw);
    const msi = !isDeferral && (Boolean(installment) || /MESES EN AUTOM[AÁ]TICO/i.test(merchantRaw));
    if (msi && !installment) continue;
    charges.push({
      occurredOn,
      merchantRaw,
      amountMinor,
      credit: credit || isDeferral,
      installmentIndex: installment?.index,
      installmentMonths: installment?.months,
      msi,
      identity: [
        "amex_statement",
        accountLastFour,
        occurredOn,
        merchantRaw,
        String(amountMinor),
        installment ? `${installment.index}/${installment.months}` : (isDeferral ? "deferral" : "full"),
        String(charges.length + 1),
      ].join(":"),
    });
  }

  // OCR often puts "MONTO A DIFERIR…" on its own line with date/amount/CR nearby.
  for (let index = scanStart; index < scanEnd; index += 1) {
    const line = lines[index];
    if (!/MONTO A DIFERIR|DIFERIR MESES EN AUTOM/i.test(line)) continue;
    let occurredOn: string | undefined;
    let amountMinor: number | undefined;
    for (let look = -2; look <= 4; look += 1) {
      const nearby = lines[index + look];
      if (!nearby) continue;
      const dated = /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)/i.exec(nearby);
      if (dated && !occurredOn) {
        occurredOn = parseSpanishDate(dated[1], dated[2], period.to);
      }
      const money = parseMoneyMinor(nearby);
      if (money !== undefined && moneyPattern.test(nearby.replace(/\$/g, "").trim()) && money > 0) {
        amountMinor = Math.abs(money);
      }
    }
    if (!occurredOn || amountMinor === undefined) continue;
    const merchantRaw = "MONTO A DIFERIR MESES EN AUTOMÁTICO";
    const already = charges.some(
      (charge) =>
        charge.credit
        && charge.amountMinor === amountMinor
        && charge.occurredOn === occurredOn
        && /DIFERIR/i.test(charge.merchantRaw),
    );
    if (already) continue;
    charges.push({
      occurredOn,
      merchantRaw,
      amountMinor,
      credit: true,
      msi: false,
      identity: [
        "amex_statement",
        accountLastFour,
        occurredOn,
        merchantRaw,
        String(amountMinor),
        "deferral",
        String(charges.length + 1),
      ].join(":"),
    });
  }

  if (msiSectionStart >= 0) {
    for (let index = msiSectionStart; index < lines.length; index += 1) {
      const line = lines[index];
      if (/Resumen de Meses/i.test(line) || /Consolidado de compras/i.test(line)) break;
      if (isPlanSummaryNoise(line)) continue;
      const dated = /^(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+(.+)$/i.exec(line);
      if (!dated) continue;
      const occurredOn = parseSpanishDate(dated[1], dated[2], period.to);
      if (!occurredOn) continue;
      const inline = splitTrailingAmount(dated[3]);
      let merchantRaw = cleanMerchant(inline.merchantRaw);
      let installment = installmentFrom(dated[3]) ?? installmentFrom(lines[index + 1] ?? "");
      let amountMinor = inline.amountMinor;
      if (amountMinor === undefined) {
        for (let look = 1; look <= 3; look += 1) {
          const next = lines[index + look] ?? "";
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
        }
      }
      if (!installment || amountMinor === undefined) continue;
      if (!merchantRaw || merchantRaw.length < 3) {
        merchantRaw = "MESES EN AUTOMÁTICO NACIONAL";
      }
      charges.push({
        occurredOn,
        merchantRaw,
        amountMinor,
        credit: false,
        installmentIndex: installment.index,
        installmentMonths: installment.months,
        msi: true,
        identity: [
          "amex_statement_msi",
          accountLastFour,
          occurredOn,
          merchantRaw,
          String(amountMinor),
          `${installment.index}/${installment.months}`,
          String(charges.length + 1),
        ].join(":"),
      });
    }
  }

  const msiPlans: AmexMsiPlanSummary[] = [];
  const detailPattern =
    /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+([\d,]+\.\d{2})\s+([\d.]+)%\s+([\d,]+\.\d{2})\s+(\d{1,2})\s+de\s+(\d{1,2})\s+([\d,]+\.\d{2})/i;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/Mensualidad\s*=\s*\(Pago a capital/i.test(lines[index] ?? "")) continue;
    const current = lines[index] ?? "";
    const merchantRaw = cleanMerchant(
      /MESES EN AUTOM/i.test(current)
        ? current
        : (lines[index - 1] ?? ""),
    ) || "MESES EN AUTOMÁTICO NACIONAL";
    let detailMatch: RegExpExecArray | null = detailPattern.exec(current);
    for (let look = 1; !detailMatch && look <= 3; look += 1) {
      detailMatch = detailPattern.exec(lines[index + look] ?? "");
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

const msiPlansFromTables = (
  tables: readonly TextractTable[],
  periodTo: string,
): readonly AmexMsiPlanSummary[] => {
  const plans: AmexMsiPlanSummary[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const cells = row.map((cell) => cell.trim());
      const joined = cells.join(" ").replace(/\s+/g, " ").trim();
      if (!/Mensualidad\s*=\s*\(Pago a capital/i.test(joined)) continue;
      if (/^Total de Plan/i.test(joined)) continue;

      const merchantCell = cells[0] ?? joined;
      const merchantRaw = /MESES EN AUTOM/i.test(merchantCell)
        ? "MESES EN AUTOMÁTICO NACIONAL"
        : (cleanMerchant(merchantCell) || "MESES EN AUTOMÁTICO NACIONAL");
      const installmentCell = cells.find((cell) => /^\d{1,2}\s+de\s+\d{1,2}$/i.test(cell));
      const installmentMatch = installmentCell
        ? /^(\d{1,2})\s+de\s+(\d{1,2})$/i.exec(installmentCell)
        : undefined;
      if (!installmentMatch) continue;

      const originalOn = cells.map((cell) => spanishDateIn(cell, periodTo)).find(Boolean);
      const moneyCells = cells
        .map((cell) => parseMoneyMinor(cell.replace(/%/g, "").trim()))
        .filter((value): value is number => value !== undefined)
        .map((value) => Math.abs(value));
      // Typical columns: original | rate% | pending | cuota — rate may parse as money if "0.00" without %.
      const cuotaMinor = moneyCells.at(-1);
      const originalAmountMinor = moneyCells.find((value) => value >= (cuotaMinor ?? 0) && value !== cuotaMinor)
        ?? moneyCells[0];
      const pendingMinor = moneyCells.length >= 3 ? moneyCells[moneyCells.length - 2] : 0;
      if (originalAmountMinor === undefined || cuotaMinor === undefined || cuotaMinor <= 0) continue;

      plans.push({
        merchantRaw,
        originalOn,
        originalAmountMinor,
        pendingMinor: pendingMinor ?? 0,
        installmentIndex: Number(installmentMatch[1]),
        installmentMonths: Number(installmentMatch[2]),
        cuotaMinor,
      });
    }
  }
  return plans;
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
  const fromTables = chargesFromTables(extraction.tables, accountLastFour, period.to);
  const tablePlans = msiPlansFromTables(extraction.tables, period.to);

  const remaining = new Map<string, number>();
  const chargeKey = (charge: AmexStatementCharge): string => [
    charge.occurredOn,
    charge.merchantRaw.toUpperCase(),
    charge.amountMinor,
    charge.installmentIndex ?? "",
    charge.installmentMonths ?? "",
  ].join("|");

  const isDeferralCredit = (charge: AmexStatementCharge): boolean =>
    charge.credit
    && (
      /MONTO A DIFERIR\s+MESES EN AUTOM/i.test(charge.merchantRaw)
      || /DIFERIR MESES EN AUTOM/i.test(charge.merchantRaw)
    );

  const deferralCredits: AmexDeferralCredit[] = [];
  const seenDeferral = new Set<string>();
  for (const charge of [...fromTables, ...fromLines.charges]) {
    if (!isDeferralCredit(charge)) continue;
    // Same deferral often appears once in TABLES and again in mangled LINE OCR with a wrong date.
    const key = String(charge.amountMinor);
    if (seenDeferral.has(key)) continue;
    seenDeferral.add(key);
    deferralCredits.push({
      occurredOn: charge.occurredOn,
      amountMinor: charge.amountMinor,
      merchantRaw: charge.merchantRaw,
      identity: charge.identity,
    });
  }

  const charges: AmexStatementCharge[] = [];
  // Prefer TABLES: they preserve date/merchant/amount columns that LINE OCR often splits.
  // Keep duplicate table rows (two identical compras the same day are valid).
  for (const charge of fromTables) {
    if (charge.credit) continue;
    if (charge.msi && charge.installmentIndex === undefined) continue;
    charges.push(charge);
    const key = chargeKey(charge);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const charge of fromLines.charges) {
    if (charge.credit) continue;
    if (charge.msi && charge.installmentIndex === undefined) continue;
    const key = chargeKey(charge);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      continue;
    }
    charges.push(charge);
  }

  const planKeys = new Set<string>();
  const msiPlans: AmexMsiPlanSummary[] = [];
  for (const plan of [...tablePlans, ...fromLines.msiPlans]) {
    const key = `${plan.installmentIndex}/${plan.installmentMonths}:${plan.cuotaMinor}:${plan.originalAmountMinor}`;
    if (planKeys.has(key)) continue;
    planKeys.add(key);
    msiPlans.push(plan);
  }

  if (charges.length === 0 && msiPlans.length === 0) {
    throw new InvalidAmexStatementError(
      `Textract no encontró movimientos Amex (answers=${Object.keys(extraction.answers).join(",") || "∅"}, tables=${extraction.tables.length}, lines=${extraction.lines.length}).`,
    );
  }

  return {
    accountLastFour,
    product,
    period,
    charges,
    msiPlans,
    deferralCredits,
  };
};

export interface AmexMsiEvidenceLine {
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly installmentIndex: number;
  readonly installmentMonths: number;
  readonly originalAmountMinor?: number;
  readonly identity: string;
}

/** One MSI evidence row per cuota: prefer charge lines, enrich with plan principal. */
export const amexMsiEvidenceLines = (
  document: AmexStatementDocument,
): readonly AmexMsiEvidenceLine[] => {
  const msiCharges = document.charges.filter(
    (charge): charge is AmexStatementCharge & { readonly installmentIndex: number; readonly installmentMonths: number } =>
      Boolean(charge.msi && charge.installmentIndex !== undefined && charge.installmentMonths !== undefined),
  );

  const usedPlans = new Set<string>();
  const fromCharges = msiCharges.map((charge, index) => {
    const plan = document.msiPlans.find((candidate) => {
      const key = `${candidate.installmentIndex}/${candidate.installmentMonths}:${candidate.cuotaMinor}`;
      if (usedPlans.has(key)) return false;
      return (
        candidate.installmentIndex === charge.installmentIndex
        && candidate.installmentMonths === charge.installmentMonths
        && candidate.cuotaMinor === charge.amountMinor
      );
    });
    if (plan) usedPlans.add(`${plan.installmentIndex}/${plan.installmentMonths}:${plan.cuotaMinor}`);
    return {
      merchantRaw: charge.merchantRaw,
      amountMinor: charge.amountMinor,
      occurredOn: charge.occurredOn,
      installmentIndex: charge.installmentIndex,
      installmentMonths: charge.installmentMonths,
      originalAmountMinor: plan?.originalAmountMinor,
      identity: charge.identity || `amex_msi:${document.accountLastFour}:${charge.amountMinor}:${charge.installmentIndex}/${charge.installmentMonths}:${index}`,
    };
  });

  const fromPlansOnly = document.msiPlans
    .filter((plan) => !usedPlans.has(`${plan.installmentIndex}/${plan.installmentMonths}:${plan.cuotaMinor}`))
    .map((plan, index) => ({
      merchantRaw: plan.merchantRaw,
      amountMinor: plan.cuotaMinor,
      occurredOn: document.period.to,
      installmentIndex: plan.installmentIndex,
      installmentMonths: plan.installmentMonths,
      originalAmountMinor: plan.originalAmountMinor,
      identity: `amex_plan:${document.accountLastFour}:${plan.originalAmountMinor}:${plan.installmentIndex}/${plan.installmentMonths}:${index}`,
    }));

  return [...fromCharges, ...fromPlansOnly];
};
