import type { Institution } from "@finance/domain";
import { header, readableBody } from "./email-mime.js";

/**
 * Routes an inbound alert to an institution-specific Textract query set.
 * Uses From/Subject and bank-name presence only — never amount/merchant fields.
 */
export const detectEmailInstitution = (mime: string): Institution | undefined => {
  const from = (header(mime, "from") ?? "").toLowerCase();
  const subject = (header(mime, "subject") ?? "").toLowerCase();
  const text = readableBody(mime).toLowerCase();
  const haystack = `${from}\n${subject}\n${text}`;

  if (
    from.includes("invoicing@aws.com")
    || (subject.includes("amazon web services billing statement") && /total in mxn/.test(text))
  ) {
    return "amazon_web_services";
  }

  if (
    (from.includes("nu@nu.com.mx") || from.includes("nu.com.mx") || /\bnu(?:@|\s|<)|nu\.com\.mx/.test(haystack))
    && /transferencia\s+fue\s+exitosa/.test(`${subject} ${text}`)
  ) {
    return "nu_mx";
  }

  if (from.includes("americanexpress") || /american express/.test(text)) {
    return "american_express_mx";
  }

  if (from.includes("santander") || (/santander/.test(text) && /\b(?:compra|cargo)\b/.test(text))) {
    return "santander_mx";
  }

  return undefined;
};

export const emailParserVersion = (institution: Institution): string => {
  switch (institution) {
    case "american_express_mx":
      return "amex-mx-card-purchase-textract-v1";
    case "santander_mx":
      return "santander-mx-card-purchase-textract-v1";
    case "nu_mx":
      return "nu-mx-outgoing-transfer-textract-v1";
    case "amazon_web_services":
      return "aws-mx-billing-statement-textract-v1";
  }
};
