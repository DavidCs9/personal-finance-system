import { extractLastFourDigits, parseFlexibleDate } from "./statement-dates.js";
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
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12",
};

const parseMoneyMinor = (raw: string): number | undefined => {
  const cleaned = raw.replace(/[\$]/g, "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return undefined;
  const amountMinor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(amountMinor) ? amountMinor : undefined;
};

const parseSpanishDayMonth = (raw: string, yearHint: string): string | undefined => {
  const match = /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]{3,12})/i.exec(raw);
  if (!match) return undefined;
  const month = monthNames[match[2].toLowerCase()];
  if (!month) return undefined;
  const date = `${yearHint}-${month}-${match[1].padStart(2, "0")}`;
  return new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date ? date : undefined;
};

const installmentFrom = (text: string): { index: number; months: number } | undefined => {
  const match = /CARGO\s+(\d{1,2})\s+DE\s+(\d{1,2})/i.exec(text);
  if (!match) return undefined;
  return { index: Number(match[1]), months: Number(match[2]) };
};

const periodFromAnswers = (
  answers: Readonly<Record<string, string>>,
): { from: string; to: string } => {
  const from = parseFlexibleDate(answers.PERIOD_FROM);
  const to = parseFlexibleDate(answers.PERIOD_TO);
  if (from && to) return { from, to };

  const periodText = answers.PERIOD_TEXT ?? "";
  const match =
    /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+al\s+(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+de\s+(\d{4})/i
      .exec(periodText);
  if (!match) throw new InvalidAmexStatementError("Textract no devolvió el periodo de facturación Amex.");
  const year = match[5];
  const fromMonth = monthNames[match[2].toLowerCase()];
  const toMonth = monthNames[match[4].toLowerCase()];
  if (!fromMonth || !toMonth) {
    throw new InvalidAmexStatementError("Textract devolvió un periodo Amex inválido.");
  }
  const fromYear = Number(fromMonth) > Number(toMonth) ? String(Number(year) - 1) : year;
  const parsedFrom = `${fromYear}-${fromMonth}-${match[1].padStart(2, "0")}`;
  const parsedTo = `${year}-${toMonth}-${match[3].padStart(2, "0")}`;
  return { from: parsedFrom, to: parsedTo };
};

const accountFromAnswers = (answers: Readonly<Record<string, string>>): string => {
  const lastFour = extractLastFourDigits(answers.ACCOUNT_LAST_FOUR);
  if (!lastFour) throw new InvalidAmexStatementError("Textract no devolvió el número de cuenta Amex.");
  return lastFour;
};

const productFromAnswers = (answers: Readonly<Record<string, string>>): string => {
  const product = answers.PRODUCT?.trim() ?? "";
  if (/Aerom[eé]xico/i.test(product)) return "American Express Aeroméxico";
  if (/Gold Elite/i.test(product)) return "The Gold Elite Credit Card American Express";
  if (product) return product;
  return "American Express";
};

const rowText = (row: readonly string[]): string => row.join(" ").replace(/\s+/g, " ").trim();

const chargesFromTables = (
  tables: readonly TextractTable[],
  accountLastFour: string,
  periodTo: string,
): AmexStatementCharge[] => {
  const yearHint = periodTo.slice(0, 4);
  const charges: AmexStatementCharge[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const joined = rowText(row);
      if (!joined || /Total de|Fecha y Detalle|Número de Cuenta|GRACIAS POR SU PAGO/i.test(joined)) continue;

      const moneyMatches = [...joined.matchAll(/-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2}/g)];
      const amountRaw = moneyMatches.at(-1)?.[0];
      const amountMinor = amountRaw ? parseMoneyMinor(amountRaw) : undefined;
      if (amountMinor === undefined || amountMinor === 0) continue;

      const occurredOn =
        parseFlexibleDate(row.find((cell) => parseFlexibleDate(cell)) ?? "")
        ?? parseSpanishDayMonth(joined, yearHint)
        ?? periodTo;

      const installment = installmentFrom(joined);
      const credit = /\bCR\b/i.test(joined) || amountMinor < 0;
      const msi = Boolean(installment) || /MESES EN AUTOM/i.test(joined);
      let merchantRaw = joined
        .replace(/CARGO\s+\d{1,2}\s+DE\s+\d{1,2}/ig, " ")
        .replace(/-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2}/g, " ")
        .replace(/\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚáéíóú]+/ig, " ")
        .replace(/\bCR\b/ig, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!merchantRaw || merchantRaw.length < 3) {
        if (!msi) continue;
        merchantRaw = /MESES EN AUTOM/i.test(joined) ? "MESES EN AUTOMÁTICO NACIONAL" : "MSI";
      }

      charges.push({
        occurredOn,
        merchantRaw,
        amountMinor: Math.abs(amountMinor),
        credit,
        installmentIndex: installment?.index,
        installmentMonths: installment?.months,
        msi,
        identity: [
          "amex_statement",
          accountLastFour,
          occurredOn,
          merchantRaw,
          String(Math.abs(amountMinor)),
          installment ? `${installment.index}/${installment.months}` : msi ? "msi" : "full",
          String(charges.length + 1),
        ].join(":"),
      });
    }
  }
  return charges;
};

const plansFromTables = (
  tables: readonly TextractTable[],
  periodTo: string,
): AmexMsiPlanSummary[] => {
  const yearHint = periodTo.slice(0, 4);
  const plans: AmexMsiPlanSummary[] = [];
  for (const table of tables) {
    for (let index = 0; index < table.rows.length; index += 1) {
      const joined = rowText(table.rows[index] ?? []);
      const installment = /(?:CARGO\s+)?(\d{1,2})\s+de\s+(\d{1,2})/i.exec(joined);
      if (!installment) continue;
      const amounts = [...joined.matchAll(/\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g)].map((match) => parseMoneyMinor(match[0]));
      const validAmounts = amounts.filter((value): value is number => value !== undefined);
      if (validAmounts.length < 2) continue;
      // Heuristic: original, pending, cuota often appear together on plan rows.
      const originalAmountMinor = validAmounts[0];
      const pendingMinor = validAmounts.length >= 3 ? validAmounts[1] : 0;
      const cuotaMinor = validAmounts.at(-1)!;
      if (cuotaMinor <= 0 || originalAmountMinor <= 0) continue;
      const merchantRaw = (
        rowText(table.rows[index - 1] ?? [])
        || joined.replace(/\d.*/, "").trim()
        || "MESES EN AUTOMÁTICO NACIONAL"
      ).slice(0, 80);
      if (/Total de Plan|Conoce tus Meses/i.test(merchantRaw)) continue;
      plans.push({
        merchantRaw,
        originalOn: parseSpanishDayMonth(joined, yearHint),
        originalAmountMinor,
        pendingMinor,
        installmentIndex: Number(installment[1]),
        installmentMonths: Number(installment[2]),
        cuotaMinor,
      });
    }
  }
  return plans;
};

/** Map Textract AnalyzeDocument output into an Amex statement. Queries + tables only. */
export const parseAmexStatementExtraction = (
  extraction: TextractStatementExtraction,
): AmexStatementDocument => {
  const period = periodFromAnswers(extraction.answers);
  const accountLastFour = accountFromAnswers(extraction.answers);
  const product = productFromAnswers(extraction.answers);
  const charges = chargesFromTables(extraction.tables, accountLastFour, period.to)
    .filter((charge) => !charge.credit);
  const msiPlans = plansFromTables(extraction.tables, period.to);

  if (charges.length === 0 && msiPlans.length === 0) {
    throw new InvalidAmexStatementError(
      "Textract no encontró movimientos en tablas del estado Amex.",
    );
  }

  return {
    accountLastFour,
    product,
    period,
    charges,
    msiPlans,
  };
};
