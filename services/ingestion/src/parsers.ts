import type { ParsedPurchase } from "./types.js";

export interface EmailParser {
  readonly institution: ParsedPurchase["institution"];
  readonly version: string;
  matches(mime: string): boolean;
  parse(mime: string): ParsedPurchase;
}

export const header = (mime: string, name: string): string | undefined => {
  const headerBlock = mime.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  return new RegExp(`^${name}:\\s*(.+)$`, "im").exec(unfolded)?.[1]?.trim();
};

export const shouldIgnoreEmail = (mime: string): boolean => {
  const from = header(mime, "from")?.toLowerCase() ?? "";
  const subject = header(mime, "subject")?.toLowerCase() ?? "";
  return from.includes("forwarding-noreply@google.com") && subject.includes("gmail forwarding confirmation");
};

export const body = (mime: string): string => {
  const separator = /\r?\n\r?\n/.exec(mime);
  return separator?.index === undefined ? mime : mime.slice(separator.index + separator[0].length);
};

export const compact = (value: string): string => value.replace(/\s+/g, " ").trim();

export const decodeText = (bytes: Uint8Array, charset?: string): string => {
  const normalisedCharset = charset?.trim().toLowerCase().replace(/^utf8$/, "utf-8");
  const supportedCharset = normalisedCharset === "windows-1252" || normalisedCharset === "iso-8859-1" || normalisedCharset === "utf-8"
    ? normalisedCharset
    : "utf-8";
  return new TextDecoder(supportedCharset).decode(bytes);
};

export const decodeQuotedPrintable = (value: string, charset?: string): string => {
  const bytes = value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decodeText(Buffer.from(bytes, "latin1"), charset);
};

export const boundaryFrom = (contentType?: string): string | undefined => {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return match?.[1] ?? match?.[2];
};

export const charsetFrom = (contentType?: string): string | undefined => {
  const match = /charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return match?.[1] ?? match?.[2];
};

export const multipartParts = (value: string, boundary: string): readonly string[] => {
  const parts: string[] = [];
  let current: string[] | undefined;
  for (const line of value.split(/\r?\n/)) {
    if (line === `--${boundary}` || line === `--${boundary}--`) {
      if (current?.length) parts.push(current.join("\r\n"));
      current = line === `--${boundary}--` ? undefined : [];
    } else if (current) {
      current.push(line);
    }
  }
  return parts;
};

export const textParts = (mime: string): readonly string[] => {
  const contentType = header(mime, "content-type") ?? "text/plain";
  const mediaType = contentType.toLowerCase();
  const raw = body(mime);
  if (mediaType.startsWith("multipart/")) {
    const boundary = boundaryFrom(contentType);
    return boundary ? multipartParts(raw, boundary).flatMap(textParts) : [];
  }
  if (mediaType.startsWith("message/rfc822")) return textParts(raw);
  if (!mediaType.startsWith("text/plain") && !mediaType.startsWith("text/html")) return [];
  const transferEncoding = header(mime, "content-transfer-encoding") ?? "";
  const charset = charsetFrom(header(mime, "content-type"));
  if (/quoted-printable/i.test(transferEncoding)) return [decodeQuotedPrintable(raw, charset)];
  if (/base64/i.test(transferEncoding)) return [decodeText(Buffer.from(raw.replace(/\s/g, ""), "base64"), charset)];
  return [raw];
};

export const decodedBody = (mime: string): string => textParts(mime).join("\n");

export const readableBody = (mime: string): string =>
  decodedBody(mime)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|td|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');

export const dateOnlyToIso = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const [, day, month, year] = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value) ?? [];
  if (!day || !month || !year) return undefined;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day)
    ? date.toISOString()
    : undefined;
};

export const mxnMinorUnits = (amount: string): number => {
  const [whole, fraction = ""] = amount.replace(/,/g, "").split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new Error(`Invalid MXN amount: ${amount}`);
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

const nuMonthMap = { ENE: 0, FEB: 1, MAR: 2, ABR: 3, MAY: 4, JUN: 5, JUL: 6, AGO: 7, SEP: 8, OCT: 9, NOV: 10, DIC: 11 } as const;

export const accountFromLastFour = (institution: ParsedPurchase["institution"], lastFour?: string) => lastFour
  ? { institution, accountId: `${institution}:${lastFour}`, displayName: `Tarjeta terminada en ${lastFour}`, lastFour }
  : undefined;

export const emailParsers: readonly EmailParser[] = [
  {
    institution: "american_express_mx",
    version: "amex-mx-card-purchase-v2",
    matches: (mime) => /american express/i.test(readableBody(mime)),
    parse: (mime) => {
      const text = readableBody(mime);
      const amount = /(?:importe|monto)\s*(?:de)?\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text)?.[1];
      const merchant = /(?:establecimiento|comercio)\s*:\s*(.+)/i.exec(text)?.[1];
      const lastFour = /(?:terminaci[oó]n|tarjeta)\s*(?:en)?\s*(\d{4})/i.exec(text)?.[1];
      const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1]
        ?? dateOnlyToIso(/(?:fecha|d[ií]a)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1]);
      if (!amount || !merchant) throw new Error("Amex MX card-purchase alert is missing amount or merchant");
      return { institution: "american_express_mx", account: accountFromLastFour("american_express_mx", lastFour), amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" }, merchantRaw: compact(merchant), occurredAt };
    },
  },
  {
    institution: "amazon_web_services",
    version: "aws-mx-billing-statement-v1",
    matches: (mime) => {
      const from = (header(mime, "from") ?? "").toLowerCase();
      const subject = header(mime, "subject") ?? "";
      const text = readableBody(mime);
      return from.includes("invoicing@aws.com")
        && /amazon web services billing statement available/i.test(subject)
        && /total in mxn\s*:/i.test(text);
    },
    parse: (mime) => {
      const text = readableBody(mime);
      const decoded = decodedBody(mime);
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
        institution: "amazon_web_services",
        eventType: "card_charge",
        account: {
          institution: "amazon_web_services",
          accountId: `amazon_web_services:${awsAccountLastFour}`,
          displayName: `Cuenta AWS terminada en ${awsAccountLastFour}`,
          lastFour: awsAccountLastFour,
        },
        amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" },
        merchantRaw: "Amazon Web Services",
        billingPeriod: `${billing[1]}-${String(month).padStart(2, "0")}`,
        paymentMethodLastFour,
      };
    },
  },
  {
    institution: "santander_mx",
    version: "santander-mx-card-purchase-v3",
    matches: (mime) => {
      const from = (header(mime, "from") ?? "").toLowerCase();
      const text = readableBody(mime);
      return from.includes("santander") || (/santander/i.test(text) && /\b(?:compra|cargo)\b/i.test(text));
    },
    parse: (mime) => {
      const text = readableBody(mime);
      const uniqueRewardsPurchase = /autoriz[oó]\s+una\s+compra\s+en\s+(.+?)\s+por\s+un\s+monto\s+de\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text);
      const amount = uniqueRewardsPurchase?.[2] ?? /(?:compra|cargo)\s*(?:por|de)\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text)?.[1];
      const merchant = uniqueRewardsPurchase?.[1] ?? /(?:en|comercio)\s*:\s*([^\r\n]+)/i.exec(text)?.[1];
      const lastFour = /(?:tarjeta|terminaci[oó]n)\s*(?:\*+|en)?\s*(\d{4})/i.exec(text)?.[1];
      const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1]
        ?? dateOnlyToIso(/(?:fecha|d[ií]a)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1]
          ?? /\b(\d{2}\/\d{2}\/\d{4})\b/.exec(text)?.[1]);
      if (!amount || !merchant) throw new Error("Santander MX card-purchase alert is missing amount or merchant");
      return { institution: "santander_mx", account: accountFromLastFour("santander_mx", lastFour), amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" }, merchantRaw: compact(merchant), occurredAt };
    },
  },
  {
    institution: "nu_mx",
    version: "nu-mx-outgoing-transfer-v4",
    matches: (mime) => {
      const from = (header(mime, "from") ?? "").toLowerCase();
      const subject = (header(mime, "subject") ?? "").toLowerCase();
      const text = readableBody(mime);
      return (from.includes("nu@nu.com.mx") || from.includes("nu.com.mx") || /\bnu(?:@|\s|<)|nu\.com\.mx/i.test(text))
        && /transferencia\s+fue\s+exitosa/i.test(`${subject} ${text}`)
        && /(?:monto|nombre|estatus)\s*:/i.test(text);
    },
    parse: (mime) => {
      const text = readableBody(mime);
      const amount = /(?:^|\n)\s*monto\s*:\s*\$?\s*([\d,.]+)/im.exec(text)?.[1];
      const date = /(?:^|\n)\s*fecha\s*:\s*(\d{1,2})\/(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\/(\d{4})/im.exec(text);
      const time = /(?:^|\n)\s*hora\s*:\s*(\d{1,2}):(\d{2})/im.exec(text);
      const transferType = /(?:^|\n)\s*tipo de transferencia\s*:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim().toLowerCase();
      const recipient = /(?:^|\n)\s*nombre\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
      const counterpartyInstitution = /(?:^|\n)\s*entidad\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
      const counterpartyAccountLastFour = /(?:^|\n)\s*clabe\s*:\s*[^\d]*(\d{4})\s*$/im.exec(text)?.[1];
      const reference = /(?:^|\n)\s*n[uú]mero de referencia\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
      const folio = /(?:^|\n)\s*folio\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
      const trackingKey = /(?:^|\n)\s*clave de rastreo\s*:\s*([^\r\n]+)/im.exec(text)?.[1];
      const status = /(?:^|\n)\s*estatus\s*:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim();
      if (!amount || !recipient || !date || !time || (transferType !== undefined && transferType !== "spei") || !status || !/completada/i.test(status)) {
        throw new Error("Nu MX outgoing-transfer alert is missing amount, recipient, date, time, completed status, or has an unsupported transfer type");
      }
      const month = nuMonthMap[date[2] as keyof typeof nuMonthMap];
      if (month === undefined) throw new Error(`Invalid Nu MX transfer month: ${date[2]}`);
      const occurredAt = new Date(Date.UTC(Number(date[3]), month, Number(date[1]), Number(time[1]) + 6, Number(time[2])));
      if (occurredAt.getUTCFullYear() !== Number(date[3]) || occurredAt.getUTCMonth() !== month || occurredAt.getUTCDate() !== Number(date[1])) throw new Error("Invalid Nu MX transfer date");
      return {
        institution: "nu_mx",
        eventType: "outgoing_transfer",
        account: { institution: "nu_mx", accountId: "nu_mx:primary", displayName: "Cuenta Nu" },
        amount: { amountMinor: mxnMinorUnits(amount), currency: "MXN" },
        merchantRaw: compact(recipient),
        counterparty: compact(recipient),
        transferType: "spei",
        reference: reference && compact(reference),
        folio: folio && compact(folio),
        trackingKey: trackingKey && compact(trackingKey),
        counterpartyInstitution: counterpartyInstitution && compact(counterpartyInstitution),
        counterpartyAccountLastFour,
        occurredAt: occurredAt.toISOString(),
      };
    },
  },
];
