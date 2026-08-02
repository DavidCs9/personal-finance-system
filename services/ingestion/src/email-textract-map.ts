import type { Institution } from "@finance/domain";
import { emailParserVersion } from "./email-institution.js";
import type { ParsedPurchase } from "./types.js";

export class InvalidEmailTextractError extends Error {}

export interface TextractEmailQueryAnswer {
  readonly alias: string;
  readonly question: string;
  readonly answer?: string;
  readonly confidence?: number;
}

/** Normalized Textract analysis for an email alert — the only field-extraction contract. */
export interface TextractEmailExtraction {
  readonly institution: Institution;
  readonly answers: Readonly<Record<string, string>>;
  readonly queryAnswers: readonly TextractEmailQueryAnswer[];
}

const compact = (value: string): string => value.replace(/\s+/g, " ").trim();

const mxnMinorUnits = (raw: string): number => {
  const match = /([\d,.]+)/.exec(raw.replace(/\s/g, ""));
  if (!match) throw new InvalidEmailTextractError(`Textract devolvió un importe inválido: ${raw}`);
  const amount = match[1]!;
  const [whole, fraction = ""] = amount.replace(/,/g, "").split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) {
    throw new InvalidEmailTextractError(`Textract devolvió un importe inválido: ${raw}`);
  }
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

const lastFourDigits = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const match = /(\d{4})\s*$/.exec(raw.replace(/[^\d]/g, " ").trim());
  return match?.[1];
};

const dateOnlyToIso = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/i.exec(value.trim())?.[1];
  if (iso) return new Date(iso).toISOString();
  const [, day, month, year] = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim()) ?? [];
  if (!day || !month || !year) return undefined;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    ? date.toISOString()
    : undefined;
};

const nuMonthMap = {
  ENE: 0, FEB: 1, MAR: 2, ABR: 3, MAY: 4, JUN: 5,
  JUL: 6, AGO: 7, SEP: 8, OCT: 9, NOV: 10, DIC: 11,
} as const;

const nuOccurredAt = (dateRaw: string | undefined, timeRaw: string | undefined): string => {
  if (!dateRaw || !timeRaw) {
    throw new InvalidEmailTextractError("Textract no devolvió fecha u hora de la transferencia Nu.");
  }
  const date = /(\d{1,2})\s*[\/\-]\s*(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\s*[\/\-]\s*(\d{4})/i
    .exec(dateRaw);
  const time = /(\d{1,2}):(\d{2})/.exec(timeRaw);
  if (!date || !time) {
    throw new InvalidEmailTextractError("Textract devolvió fecha u hora Nu en un formato no reconocido.");
  }
  const month = nuMonthMap[date[2]!.toUpperCase() as keyof typeof nuMonthMap];
  if (month === undefined) throw new InvalidEmailTextractError(`Mes Nu inválido: ${date[2]}`);
  const occurredAt = new Date(Date.UTC(
    Number(date[3]),
    month,
    Number(date[1]),
    Number(time[1]) + 6,
    Number(time[2]),
  ));
  if (
    occurredAt.getUTCFullYear() !== Number(date[3])
    || occurredAt.getUTCMonth() !== month
    || occurredAt.getUTCDate() !== Number(date[1])
  ) {
    throw new InvalidEmailTextractError("Textract devolvió una fecha Nu inválida.");
  }
  return occurredAt.toISOString();
};

const accountFromLastFour = (institution: Institution, lastFour?: string) =>
  lastFour
    ? {
        institution,
        accountId: `${institution}:${lastFour}`,
        displayName: `Tarjeta terminada en ${lastFour}`,
        lastFour,
      }
    : undefined;

const requireAnswer = (answers: Readonly<Record<string, string>>, alias: string): string => {
  const value = answers[alias]?.trim();
  if (!value) throw new InvalidEmailTextractError(`Textract no devolvió ${alias}.`);
  return value;
};

type MappedFields = Omit<ParsedPurchase, "parserVersion">;

const mapCardPurchase = (
  institution: "american_express_mx" | "santander_mx",
  answers: Readonly<Record<string, string>>,
): MappedFields => {
  const amount = mxnMinorUnits(requireAnswer(answers, "AMOUNT"));
  const merchantRaw = compact(requireAnswer(answers, "MERCHANT"));
  const lastFour = lastFourDigits(answers.ACCOUNT_LAST_FOUR);
  const occurredAt = dateOnlyToIso(answers.OCCURRED_AT);
  if (!merchantRaw) throw new InvalidEmailTextractError("Textract devolvió un comercio vacío.");
  return {
    institution,
    account: accountFromLastFour(institution, lastFour),
    amount: { amountMinor: amount, currency: "MXN" },
    merchantRaw,
    occurredAt,
  };
};

const mapNuTransfer = (answers: Readonly<Record<string, string>>): MappedFields => {
  const amount = mxnMinorUnits(requireAnswer(answers, "AMOUNT"));
  const recipient = compact(requireAnswer(answers, "RECIPIENT"));
  const transferType = compact(requireAnswer(answers, "TRANSFER_TYPE")).toLowerCase();
  const status = compact(requireAnswer(answers, "STATUS"));
  if (transferType !== "spei") {
    throw new InvalidEmailTextractError(`Textract devolvió un tipo de transferencia no SPEI: ${transferType}`);
  }
  if (!/completada/i.test(status)) {
    throw new InvalidEmailTextractError(`Textract devolvió un estatus no completado: ${status}`);
  }
  return {
    institution: "nu_mx",
    eventType: "outgoing_transfer",
    account: { institution: "nu_mx", accountId: "nu_mx:primary", displayName: "Cuenta Nu" },
    amount: { amountMinor: amount, currency: "MXN" },
    merchantRaw: recipient,
    counterparty: recipient,
    transferType: "spei",
    reference: answers.REFERENCE ? compact(answers.REFERENCE) : undefined,
    folio: answers.FOLIO ? compact(answers.FOLIO) : undefined,
    trackingKey: answers.TRACKING_KEY ? compact(answers.TRACKING_KEY) : undefined,
    counterpartyInstitution: answers.COUNTERPARTY_INSTITUTION
      ? compact(answers.COUNTERPARTY_INSTITUTION)
      : undefined,
    counterpartyAccountLastFour: lastFourDigits(answers.CLABE_LAST_FOUR),
    occurredAt: nuOccurredAt(answers.DATE, answers.TIME),
  };
};

const mapAwsBilling = (answers: Readonly<Record<string, string>>): MappedFields => {
  const amount = mxnMinorUnits(requireAnswer(answers, "AMOUNT_MXN"));
  const awsAccountLastFour = lastFourDigits(requireAnswer(answers, "AWS_ACCOUNT_LAST_FOUR"));
  const paymentMethodLastFour = lastFourDigits(requireAnswer(answers, "PAYMENT_CARD_LAST_FOUR"));
  const year = compact(requireAnswer(answers, "BILLING_YEAR")).replace(/\D/g, "");
  const monthRaw = compact(requireAnswer(answers, "BILLING_MONTH")).replace(/\D/g, "");
  const month = Number(monthRaw);
  if (!awsAccountLastFour || !paymentMethodLastFour) {
    throw new InvalidEmailTextractError("Textract no devolvió cuenta o tarjeta AWS.");
  }
  if (!/^\d{4}$/.test(year) || month < 1 || month > 12) {
    throw new InvalidEmailTextractError("Textract devolvió un periodo de facturación AWS inválido.");
  }
  return {
    institution: "amazon_web_services",
    eventType: "card_charge",
    account: {
      institution: "amazon_web_services",
      accountId: `amazon_web_services:${awsAccountLastFour}`,
      displayName: `Cuenta AWS terminada en ${awsAccountLastFour}`,
      lastFour: awsAccountLastFour,
    },
    amount: { amountMinor: amount, currency: "MXN" },
    merchantRaw: "Amazon Web Services",
    billingPeriod: `${year}-${String(month).padStart(2, "0")}`,
    paymentMethodLastFour,
  };
};

export const mapTextractEmailPurchase = (
  institution: Institution,
  extraction: Pick<TextractEmailExtraction, "answers">,
): ParsedPurchase & { readonly parserVersion: string } => {
  const answers = extraction.answers;
  const parsed = (() => {
    switch (institution) {
      case "american_express_mx":
      case "santander_mx":
        return mapCardPurchase(institution, answers);
      case "nu_mx":
        return mapNuTransfer(answers);
      case "amazon_web_services":
        return mapAwsBilling(answers);
    }
  })();
  if (parsed.amount.amountMinor <= 0 || !parsed.merchantRaw.trim()) {
    throw new InvalidEmailTextractError("Textract devolvió datos incompletos del movimiento.");
  }
  return { ...parsed, parserVersion: emailParserVersion(institution) };
};
