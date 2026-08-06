import {
  monthFromFechaPago,
  payslipLineGroup,
  type PayslipLine,
  type PayslipSummary,
} from "@finance/domain";

export class InvalidCfdiNominaError extends Error {}

const MXN_AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

export const mxnStringToMinor = (value: string, field: string): number => {
  const match = MXN_AMOUNT.exec(value.trim());
  if (!match) throw new InvalidCfdiNominaError(`${field} is not a valid MXN amount.`);
  const whole = Number(match[1]);
  const frac = (match[2] ?? "00").padEnd(2, "0").slice(0, 2);
  const minor = whole * 100 + Number(frac);
  if (!Number.isSafeInteger(minor)) throw new InvalidCfdiNominaError(`${field} is out of range.`);
  return minor;
};

const attr = (attrs: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match?.[1];
};

const requireAttr = (attrs: string, name: string, context: string): string => {
  const value = attr(attrs, name);
  if (value === undefined || value.length === 0) {
    throw new InvalidCfdiNominaError(`${context} is missing ${name}.`);
  }
  return value;
};

/** Open tags (and self-closing) for a local element name, with or without prefix. */
const matchOpenTags = (xml: string, localName: string): readonly string[] => {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b([^>]*)>`, "g");
  const attrs: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    attrs.push((match[1] ?? "").replace(/\/\s*$/, ""));
  }
  return attrs;
};

const firstOpenTag = (xml: string, localName: string): string => {
  const tags = matchOpenTags(xml, localName);
  if (tags.length === 0) throw new InvalidCfdiNominaError(`Missing ${localName} element.`);
  return tags[0]!;
};

const parseLine = (
  kind: PayslipLine["kind"],
  attrs: string,
  tipoAttr: string,
  amountField: "Importe" | "ImporteGravado",
): PayslipLine => {
  const tipo = requireAttr(attrs, tipoAttr, kind);
  const clave = attr(attrs, "Clave") ?? "";
  const concepto = attr(attrs, "Concepto") ?? "";
  let amountMinor: number;
  if (kind === "percepcion") {
    const gravado = mxnStringToMinor(attr(attrs, "ImporteGravado") ?? "0", "ImporteGravado");
    const exento = mxnStringToMinor(attr(attrs, "ImporteExento") ?? "0", "ImporteExento");
    amountMinor = gravado + exento;
  } else {
    amountMinor = mxnStringToMinor(requireAttr(attrs, amountField, kind), amountField);
  }
  const group = payslipLineGroup(kind, tipo);
  return {
    kind,
    tipo,
    clave,
    concepto,
    amountMinor,
    group,
    ...(kind === "percepcion" && tipo === "005" ? { notCashInBank: true } : {}),
  };
};

/**
 * Parse a CFDI 4.0 nómina 1.2 XML into a structured payslip.
 * Accepts only TipoDeComprobante=N with nomina12 + TimbreFiscalDigital UUID.
 */
export const parseCfdiNominaXml = (xml: string): PayslipSummary => {
  if (typeof xml !== "string" || xml.trim().length < 32) {
    throw new InvalidCfdiNominaError("A CFDI nómina XML body is required.");
  }
  if (xml.length > 2_000_000) {
    throw new InvalidCfdiNominaError("XML exceeds the 2 MB limit.");
  }

  const comprobante = firstOpenTag(xml, "Comprobante");
  const tipo = attr(comprobante, "TipoDeComprobante");
  if (tipo !== "N") {
    throw new InvalidCfdiNominaError("Only CFDI TipoDeComprobante=N (nómina) is accepted.");
  }

  const nominaTags = matchOpenTags(xml, "Nomina");
  if (nominaTags.length === 0) {
    throw new InvalidCfdiNominaError("Missing nomina12 complementary.");
  }
  const nomina = nominaTags[0]!;

  const timbre = firstOpenTag(xml, "TimbreFiscalDigital");
  const uuid = requireAttr(timbre, "UUID", "TimbreFiscalDigital").toUpperCase();
  if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(uuid)) {
    throw new InvalidCfdiNominaError("TimbreFiscalDigital UUID is invalid.");
  }

  const fechaPago = requireAttr(nomina, "FechaPago", "Nomina").slice(0, 10);
  const month = monthFromFechaPago(fechaPago);
  const tipoNomina = requireAttr(nomina, "TipoNomina", "Nomina");
  const totalMinor = mxnStringToMinor(requireAttr(comprobante, "Total", "Comprobante"), "Total");
  const totalPercepcionesMinor = mxnStringToMinor(
    attr(nomina, "TotalPercepciones") ?? "0",
    "TotalPercepciones",
  );
  const totalDeduccionesMinor = mxnStringToMinor(
    attr(nomina, "TotalDeducciones") ?? "0",
    "TotalDeducciones",
  );
  const totalOtrosPagosMinor = mxnStringToMinor(
    attr(nomina, "TotalOtrosPagos") ?? "0",
    "TotalOtrosPagos",
  );

  const lines: PayslipLine[] = [
    ...matchOpenTags(xml, "Percepcion").map((attrs) => parseLine("percepcion", attrs, "TipoPercepcion", "ImporteGravado")),
    ...matchOpenTags(xml, "Deduccion").map((attrs) => parseLine("deduccion", attrs, "TipoDeduccion", "Importe")),
    ...matchOpenTags(xml, "OtroPago").map((attrs) => parseLine("otro_pago", attrs, "TipoOtroPago", "Importe")),
  ];

  const emisor = matchOpenTags(xml, "Emisor")[0];
  const employerName = emisor ? attr(emisor, "Nombre") : undefined;

  return {
    uuid,
    fechaPago,
    month,
    tipoNomina,
    totalMinor,
    totalPercepcionesMinor,
    totalDeduccionesMinor,
    totalOtrosPagosMinor,
    lines,
    ...(employerName ? { employerName } : {}),
    ...(attr(nomina, "FechaInicialPago")
      ? { fechaInicialPago: attr(nomina, "FechaInicialPago")!.slice(0, 10) }
      : {}),
    ...(attr(nomina, "FechaFinalPago")
      ? { fechaFinalPago: attr(nomina, "FechaFinalPago")!.slice(0, 10) }
      : {}),
  };
};
