import type { CardPurchaseParser, IncomingEmail, ParsedPurchase } from "./types.js";

const header = (mime: string, name: string): string | undefined => {
  const expression = new RegExp(`^${name}:\\s*(.+)$`, "im");
  return expression.exec(mime)?.[1]?.trim();
};

const body = (mime: string): string => mime.split(/\r?\n\r?\n/, 2)[1] ?? mime;

const compact = (value: string): string => value.replace(/\s+/g, " ").trim();

const mxnMinorUnits = (amount: string): number => {
  const normalised = amount.replace(/,/g, "");
  const [whole, fraction = ""] = normalised.split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) {
    throw new Error(`Invalid MXN amount: ${amount}`);
  }
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

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
    const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1];

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
  readonly version = "santander-mx-card-purchase-v1";

  matches(email: IncomingEmail): boolean {
    const from = header(email.mime, "from")?.toLowerCase() ?? "";
    return from.includes("santander") || /santander/i.test(body(email.mime));
  }

  parse(email: IncomingEmail): ParsedPurchase {
    const text = body(email.mime);
    const amount = /(?:compra|cargo)\s*(?:por|de)\s*\$?\s*([\d,.]+)\s*(MXN|M\.N\.)/i.exec(text)?.[1];
    const merchant = /(?:en|comercio)\s*:\s*([^\r\n]+)/i.exec(text)?.[1];
    const lastFour = /(?:tarjeta|terminaci[oó]n)\s*(?:\*+|en)?\s*(\d{4})/i.exec(text)?.[1];
    const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1];

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

export const defaultCardPurchaseParsers = (): readonly CardPurchaseParser[] => [
  new AmexMxCardPurchaseParser(),
  new SantanderMxCardPurchaseParser(),
];
