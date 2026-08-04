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
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
  readonly originalAmountMinor?: number;
}

export interface SantanderStatementDocument {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly charges: readonly SantanderStatementCharge[];
  readonly msiCharges: readonly SantanderStatementCharge[];
}

interface SantanderMsiPlanHint {
  readonly merchantRaw: string;
  readonly installmentIndex: number;
  readonly installmentMonths: number;
  readonly originalAmountMinor: number;
  readonly cuotaMinor: number;
  readonly startOn?: string;
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
    .replace(/(?:^|\s)[+\-]=?(?=\s|$)/g, " ")
    .replace(/\bMOM\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

const parseInstallmentProgress = (
  raw: string,
): { readonly index: number; readonly months: number } | undefined => {
  const match = /(\d{1,2})\s+DE\s+(\d{1,2})\b/i.exec(raw);
  if (!match) return undefined;
  const index = Number(match[1]);
  const months = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(months) || index < 1 || months < index) {
    return undefined;
  }
  return { index, months };
};

const monthsFromMerchantLabel = (merchantRaw: string): number | undefined => {
  const match = /\b(\d{1,2})\s*M\b/i.exec(merchantRaw);
  if (!match) return undefined;
  const months = Number(match[1]);
  return Number.isInteger(months) && months >= 1 ? months : undefined;
};

const amountsWithin = (left: number, right: number, tolerance = 200): boolean =>
  Math.abs(left - right) <= tolerance;

/** Plan-summary rows list original purchase + pending + cuota; period cuotas appear in movimientos. */
const isMsiPlanSummaryRow = (cells: readonly string[], joined: string): boolean =>
  Boolean(parseInstallmentProgress(joined))
  || cells.some((cell) => Boolean(parseInstallmentProgress(cell)))
  || cells.some((cell) => /^(Monto original|Saldo pendiente|Pago requerido|N[uú]m\.?\s*de pago)$/i.test(cell));

const planHintFromCells = (cells: readonly string[]): SantanderMsiPlanHint | undefined => {
  const joined = cells.join(" ");
  const progress =
    cells.map((cell) => parseInstallmentProgress(cell)).find(Boolean)
    ?? parseInstallmentProgress(joined);
  if (!progress) return undefined;
  const merchantRaw = cleanMerchant(
    cells.find((cell) => isMsiMerchant(cell) || /\d+\s*M\s*S\/?INT/i.test(cell)) ?? "",
  );
  if (!merchantRaw) return undefined;
  const amounts = cells
    .map((cell) => parseMoneyMinor(cell))
    .filter((value): value is number => value !== undefined && value > 0);
  if (amounts.length < 2) return undefined;
  const originalAmountMinor = Math.max(...amounts);
  const months = monthsFromMerchantLabel(merchantRaw) ?? progress.months;
  const expectedCuota = Math.round(originalAmountMinor / months);
  const cuotaMinor =
    amounts.find((amount) => amountsWithin(amount, expectedCuota))
    ?? amounts
      .filter((amount) => amount < originalAmountMinor)
      .sort((left, right) => Math.abs(left - expectedCuota) - Math.abs(right - expectedCuota))[0];
  if (cuotaMinor === undefined || cuotaMinor <= 0) return undefined;
  const startOn = cells
    .map((cell) => parseDayMonthYear(cell) ?? parseFlexibleDate(cell))
    .find((value): value is string => Boolean(value));
  return {
    merchantRaw,
    installmentIndex: progress.index,
    installmentMonths: months,
    originalAmountMinor,
    cuotaMinor,
    ...(startOn ? { startOn } : {}),
  };
};

const plansFromTables = (tables: readonly TextractTable[]): readonly SantanderMsiPlanHint[] => {
  const plans: SantanderMsiPlanHint[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const cells = row.map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      const plan = planHintFromCells(cells);
      if (plan) plans.push(plan);
    }
  }
  return plans;
};

const enrichMsiCharges = (
  charges: readonly SantanderStatementCharge[],
  plans: readonly SantanderMsiPlanHint[],
): readonly SantanderStatementCharge[] => {
  if (plans.length === 0) return charges;
  const used = new Set<number>();
  return charges.map((charge) => {
    if (!charge.msi) return charge;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < plans.length; index += 1) {
      if (used.has(index)) continue;
      const plan = plans[index]!;
      const distance = Math.abs(plan.cuotaMinor - charge.amountMinor);
      if (distance > 200) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) return charge;
    used.add(bestIndex);
    const plan = plans[bestIndex]!;
    return {
      ...charge,
      installmentIndex: plan.installmentIndex,
      installmentMonths: plan.installmentMonths,
      originalAmountMinor: plan.originalAmountMinor,
    };
  });
};

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
      if (/^Total de\b|^Fecha de la operaci/i.test(joined)) continue;
      if (isMsiPlanSummaryRow(cells, joined)) continue;

      const dateCells = cells.filter((cell) => Boolean(parseDayMonthYear(cell) || parseFlexibleDate(cell)));
      const occurredOn = dateCells[0]
        ? (parseDayMonthYear(dateCells[0]) ?? parseFlexibleDate(dateCells[0]))
        : undefined;
      if (!occurredOn) continue;
      const postedOn = dateCells[1]
        ? (parseDayMonthYear(dateCells[1]) ?? parseFlexibleDate(dateCells[1]))
        : undefined;

      const amountCell = [...cells].reverse().find((cell) => parseMoneyMinor(cell) !== undefined);
      const amountMinor = amountCell ? parseMoneyMinor(amountCell) : undefined;
      if (amountMinor === undefined) continue;

      const dateCellSet = new Set(dateCells);
      const merchantRaw = cleanMerchant(
        cells
          .filter((cell) => !dateCellSet.has(cell) && cell !== amountCell && cell !== "+")
          .join(" ")
          || joined,
      );
      if (!merchantRaw || merchantRaw.length < 3) continue;
      if (/^Fecha\b/i.test(merchantRaw) || /^Tarjeta\b/i.test(merchantRaw) || /^Descripci/i.test(merchantRaw)) {
        continue;
      }
      const credit = amountMinor < 0 || /\bPAGO\b|\bABONO\b|\bCASH BACK\b/i.test(merchantRaw);
      const absolute = Math.abs(amountMinor);
      const msi = isMsiMerchant(merchantRaw);
      charges.push({
        occurredOn,
        ...(postedOn ? { postedOn } : {}),
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

  const remaining = new Map<string, number>();
  const chargeKey = (charge: SantanderStatementCharge): string =>
    [charge.occurredOn, charge.merchantRaw.toUpperCase(), charge.amountMinor, charge.msi].join("|");

  const charges: SantanderStatementCharge[] = [];
  // Prefer TABLES and keep duplicate table rows (same-day identical compras are valid).
  for (const charge of chargesFromTables(extraction.tables, accountLastFour)) {
    if (charge.credit) continue;
    charges.push(charge);
    const key = chargeKey(charge);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const charge of chargesFromLines(extraction.lines, accountLastFour)) {
    if (charge.credit) continue;
    const key = chargeKey(charge);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      continue;
    }
    charges.push(charge);
  }

  const msiPlans = plansFromTables(extraction.tables);
  const enrichedCharges = enrichMsiCharges(charges, msiPlans);
  const msiCharges = enrichedCharges.filter((charge) => charge.msi);
  if (enrichedCharges.length === 0) {
    throw new InvalidSantanderStatementError(
      `Textract no encontró movimientos Santander (answers=${Object.keys(extraction.answers).join(",") || "∅"}, tables=${extraction.tables.length}, lines=${extraction.lines.length}).`,
    );
  }

  return {
    accountLastFour,
    product,
    period,
    charges: enrichedCharges,
    msiCharges,
  };
};
