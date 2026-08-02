import type { CardPurchaseParser, IncomingEmail, ParsedPurchase } from "./types.js";

const header = (mime: string, name: string): string | undefined => {
  const expression = new RegExp(`^${name}:\\s*(.+)$`, "im");
  return expression.exec(mime)?.[1]?.trim();
};

const body = (mime: string): string => mime.split(/\r?\n\r?\n/, 2)[1] ?? mime;

const compact = (value: string): string => value.replace(/\s+/g, " ").trim();

const decodeQuotedPrintable = (value: string): string => {
  const bytes = value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(bytes, "binary").toString("utf8");
};

const decodedBody = (mime: string): string => {
  const raw = body(mime);
  return /quoted-printable/i.test(header(mime, "content-transfer-encoding") ?? "")
    ? decodeQuotedPrintable(raw)
    : raw;
};

const readableBody = (mime: string): string =>
  decodedBody(mime)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|td|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');

const dateOnlyToIso = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const [, day, month, year] = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value) ?? [];
  if (!day || !month || !year) return undefined;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day)
    ? date.toISOString()
    : undefined;
};

const mxnMinorUnits = (amount: string): number => {
  const normalised = amount.replace(/,/g, "");
  const [whole, fraction = ""] = normalised.split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) {
    throw new Error(`Invalid MXN amount: ${amount}`);
  }
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

const nuMonthMap = { ENE: 0, FEB: 1, MAR: 2, ABR: 3, MAY: 4, JUN: 5, JUL: 6, AGO: 7, SEP: 8, OCT: 9, NOV: 10, DIC: 11 } as const;

const accountFromLastFour = (institution: "american_express_mx" | "santander_mx", lastFour?: string) =>
  lastFour
    ? {
        institution,
        accountId: `${institution}:${lastFour}`,
        displayName: `Tarjeta terminada en ${lastFour}`,
        lastFour,
      }
    : undefined;

/**
 * Narrow, deliberately deterministic parser for the fixture-like Amex MX alert
 * format. Real bank templates can be added as new parser versions without
 * changing the ingestion pipeline.
 */
export class AmexMxCardPurchaseParser implements CardPurchaseParser {
  readonly institution = "american_express_mx" as const;
  readonly version = "amex-mx-card-purchase-v1";

  matches(email: IncomingEmail): boolean {
    const from = header(email.mime, "from")?.toLowerCase() ?? "";
    return from.includes("americanexpress") || /american express/i.test(body(email.mime));
  }

  parse(email: IncomingEmail): ParsedPurchase {
    const text = body(email.mime);
    const amount = /(?:importe|monto)\s*(?:de)?\s*\$?\s*([\d,.]+)\s*(MXN|M\.N\.)/i.exec(text)?.[1];
    const merchant = /(?:establecimiento|comercio)\s*:\s*(.+)/i.exec(text)?.[1];
    const lastFour = /(?:terminaci[oó]n|tarjeta)\s*(?:en)?\s*(\d{4})/i.exec(text)?.[1];
    const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1]
      ?? dateOnlyToIso(/(?:fecha|d[ií]a)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1]
        ?? /\b(\d{2}\/\d{2}\/\d{4})\b/.exec(text)?.[1]);

    if (!amount || !merchant) {
      throw new Error("Amex MX card-purchase alert is missing amount or merchant");
    }

    return {
      institution: this.institution,
      account: accountFromLastFour(this.institution, lastFour),
      amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" },
      merchantRaw: compact(merchant),
      occurredAt,
    };
  }
}

/** Deterministic parser for the fixture-like Santander MX purchase alert format. */
export class SantanderMxCardPurchaseParser implements CardPurchaseParser {
  readonly institution = "santander_mx" as const;
  readonly version = "santander-mx-card-purchase-v2";

  matches(email: IncomingEmail): boolean {
    const from = header(email.mime, "from")?.toLowerCase() ?? "";
    const text = readableBody(email.mime);
    return from.includes("santander") || (/santander/i.test(text) && /\b(?:compra|cargo)\b/i.test(text));
  }

  parse(email: IncomingEmail): ParsedPurchase {
    const text = readableBody(email.mime);
    const uniqueRewardsPurchase = /autoriz[oó]\s+una\s+compra\s+en\s+(.+?)\s+por\s+un\s+monto\s+de\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text);
    const amount = uniqueRewardsPurchase?.[2] ?? /(?:compra|cargo)\s*(?:por|de)\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text)?.[1];
    const merchant = uniqueRewardsPurchase?.[1] ?? /(?:en|comercio)\s*:\s*([^\r\n]+)/i.exec(text)?.[1];
    const lastFour = /(?:tarjeta|terminaci[oó]n)\s*(?:\*+|en)?\s*(\d{4})/i.exec(text)?.[1];
    const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1]
      ?? dateOnlyToIso(/(?:fecha|d[ií]a)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1]
        ?? /\b(\d{2}\/\d{2}\/\d{4})\b/.exec(text)?.[1]);

    if (!amount || !merchant) {
      throw new Error("Santander MX card-purchase alert is missing amount or merchant");
    }

    return {
      institution: this.institution,
      account: accountFromLastFour(this.institution, lastFour),
      amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" },
      merchantRaw: compact(merchant),
      occurredAt,
    };
  }
}

/** Deterministic parser for Nu's "Tu transferencia fue exitosa" SPEI alert. */
export class NuMxOutgoingTransferParser implements CardPurchaseParser {
  readonly institution = "nu_mx" as const;
  readonly version = "nu-mx-outgoing-transfer-v2";

  matches(email: IncomingEmail): boolean {
    const from = header(email.mime, "from")?.toLowerCase() ?? "";
    const subject = header(email.mime, "subject")?.toLowerCase() ?? "";
    const text = readableBody(email.mime);
    return (from.includes("nu@nu.com.mx") || from.includes("nu.com.mx"))
      && /transferencia\s+fue\s+exitosa/i.test(`${subject} ${text}`)
      && /(?:monto|nombre|estatus)\s*:/i.test(text);
  }

  parse(email: IncomingEmail): ParsedPurchase {
    const text = readableBody(email.mime);
    const amount = /(?:^|\n)\s*monto\s*:\s*\$?\s*([\d,.]+)/im.exec(text)?.[1];
    const date = /(?:^|\n)\s*fecha\s*:\s*(\d{1,2})\/(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\/(\d{4})/im.exec(text);
    const time = /(?:^|\n)\s*hora\s*:\s*(\d{1,2}):(\d{2})/im.exec(text);
    const transferType = /(?:^|\n)\s*tipo de transferencia\s*:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim().toLowerCase();
    const recipient = /(?:^|\n)\s*nombre\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
    const institution = /(?:^|\n)\s*entidad\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
    const counterpartyAccountLastFour = /(?:^|\n)\s*clabe\s*:\s*[^\d]*(\d{4})\s*$/im.exec(text)?.[1];
    const reference = /(?:^|\n)\s*n[uú]mero de referencia\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
    const folio = /(?:^|\n)\s*folio\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
    const trackingKey = /(?:^|\n)\s*clave de rastreo\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
    const status = /(?:^|\n)\s*estatus\s*:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim();

    if (!amount || !recipient || !date || !time || transferType !== "spei" || !status || !/completada/i.test(status)) {
      throw new Error("Nu MX outgoing-transfer alert is missing amount, recipient, date, time, SPEI type, or completed status");
    }

    const month = nuMonthMap[date[2] as keyof typeof nuMonthMap];
    if (month === undefined) throw new Error(`Invalid Nu MX transfer month: ${date[2]}`);
    const occurredAt = new Date(Date.UTC(Number(date[3]), month, Number(date[1]), Number(time[1]) + 6, Number(time[2])));
    if (occurredAt.getUTCFullYear() !== Number(date[3]) || occurredAt.getUTCMonth() !== month || occurredAt.getUTCDate() !== Number(date[1])) {
      throw new Error("Invalid Nu MX transfer date");
    }

    return {
      institution: this.institution,
      eventType: "outgoing_transfer",
      account: {
        institution: this.institution,
        accountId: "nu_mx:primary",
        displayName: "Cuenta Nu",
      },
      amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" },
      merchantRaw: compact(recipient),
      counterparty: compact(recipient),
      transferType: "spei",
      reference: reference && compact(reference),
      folio: folio && compact(folio),
      trackingKey: trackingKey && compact(trackingKey),
      counterpartyInstitution: institution && compact(institution),
      counterpartyAccountLastFour,
      occurredAt: occurredAt.toISOString(),
    };
  }
}

/** Captures the MXN amount AWS announces it will charge to the default card. */
export class AwsMxBillingStatementParser implements CardPurchaseParser {
  readonly institution = "amazon_web_services" as const;
  readonly version = "aws-mx-billing-statement-v1";

  matches(email: IncomingEmail): boolean {
    const from = header(email.mime, "from")?.toLowerCase() ?? "";
    const subject = header(email.mime, "subject") ?? "";
    const text = readableBody(email.mime);
    return from.includes("invoicing@aws.com")
      && /amazon web services billing statement available/i.test(subject)
      && /total in mxn\s*:/i.test(text);
  }

  parse(email: IncomingEmail): ParsedPurchase {
    const text = readableBody(email.mime);
    const decoded = decodedBody(email.mime);
    const amount = /total in mxn\s*:\s*\$\s*([\d,.]+)/i.exec(text)?.[1];
    const awsAccountLastFour = /account ending in\s*\*+(\d{4})/i.exec(text)?.[1];
    const paymentMethodLastFour = /credit card ending in\s*(\d{4})/i.exec(text)?.[1];
    const billing = /\/bills\?year=(\d{4})(?:&|&amp;)month=(\d{1,2})/i.exec(decoded);

    if (!amount || !awsAccountLastFour || !paymentMethodLastFour || !billing) {
      throw new Error("AWS MX billing statement is missing amount, account, payment card, or billing period");
    }
    const month = Number(billing[2]);
    if (month < 1 || month > 12) throw new Error(`Invalid AWS billing month: ${billing[2]}`);

    return {
      institution: this.institution,
      eventType: "card_charge",
      account: {
        institution: this.institution,
        accountId: `${this.institution}:${awsAccountLastFour}`,
        displayName: `Cuenta AWS terminada en ${awsAccountLastFour}`,
        lastFour: awsAccountLastFour,
      },
      amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" },
      merchantRaw: "Amazon Web Services",
      billingPeriod: `${billing[1]}-${String(month).padStart(2, "0")}`,
      paymentMethodLastFour,
    };
  }
}

export const defaultCardPurchaseParsers = (): readonly CardPurchaseParser[] => [
  new AmexMxCardPurchaseParser(),
  new AwsMxBillingStatementParser(),
  new NuMxOutgoingTransferParser(),
  new SantanderMxCardPurchaseParser(),
];
