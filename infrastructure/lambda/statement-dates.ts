/** Shared OCR-tolerant date helpers for statement Textract mappers. */

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

const validIsoDate = (date: string): string | undefined => {
  const parsed = new Date(`${date}T12:00:00Z`);
  return parsed.toISOString().slice(0, 10) === date ? date : undefined;
};

export const parseFlexibleDate = (raw: string | undefined): string | undefined => {
  if (!raw?.trim()) return undefined;
  const value = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_|\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const iso = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(value);
  if (iso) {
    return validIsoDate(`${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`);
  }

  const dmyNum = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/.exec(value);
  if (dmyNum) {
    let year = dmyNum[3];
    if (year.length === 2) year = `20${year}`;
    return validIsoDate(`${year}-${dmyNum[2].padStart(2, "0")}-${dmyNum[1].padStart(2, "0")}`);
  }

  const dmyMon = /^(\d{1,2})[-\/.]([A-Za-z]{3,9})[-\/.](\d{2,4})$/.exec(value);
  if (dmyMon) {
    const month = monthNames[dmyMon[2].toLowerCase()];
    if (!month) return undefined;
    let year = dmyMon[3];
    if (year.length === 2) year = `20${year}`;
    return validIsoDate(`${year}-${month}-${dmyMon[1].padStart(2, "0")}`);
  }

  const spanish = /^(\d{1,2})\s+de\s+([A-Za-z]{3,12})(?:\s+de)?\s+(\d{4})$/i.exec(value);
  if (spanish) {
    const month = monthNames[spanish[2].toLowerCase()];
    if (!month) return undefined;
    return validIsoDate(`${spanish[3]}-${month}-${spanish[1].padStart(2, "0")}`);
  }

  const spanishNoYear = /^(\d{1,2})\s+de\s+([A-Za-z]{3,12})$/i.exec(value);
  if (spanishNoYear) {
    // Caller must supply year context; return month-day marker as undefined here.
    return undefined;
  }

  return undefined;
};

export const parseSpanishDayMonth = (
  day: string,
  monthToken: string,
  yearHint: string,
): string | undefined => {
  const month = monthNames[monthToken.toLowerCase()];
  if (!month) return undefined;
  return validIsoDate(`${yearHint}-${month}-${day.padStart(2, "0")}`);
};

export const monthTokenToNumber = (token: string): string | undefined => monthNames[token.toLowerCase()];

export const extractLastFourDigits = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return digits.slice(-4);
};

export const findPeriodInLooseText = (text: string): { from: string; to: string } | undefined => {
  const flat = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

  const spanish =
    /Periodo(?:\s+de\s+Facturacion)?(?:\s*:)?\s*(?:Del\s+)?(\d{1,2})\s+de\s+([A-Za-z]{3,12})\s+al\s+(\d{1,2})\s+de\s+([A-Za-z]{3,12})\s+de\s+(\d{4})/i
      .exec(flat);
  if (spanish) {
    const year = spanish[5];
    const fromMonth = monthTokenToNumber(spanish[2]);
    const toMonth = monthTokenToNumber(spanish[4]);
    if (fromMonth && toMonth) {
      const fromYear = Number(fromMonth) > Number(toMonth) ? String(Number(year) - 1) : year;
      const from = validIsoDate(`${fromYear}-${fromMonth}-${spanish[1].padStart(2, "0")}`);
      const to = validIsoDate(`${year}-${toMonth}-${spanish[3].padStart(2, "0")}`);
      if (from && to) return { from, to };
    }
  }

  const dashed =
    /Periodo(?:\s*:)?\s*(\d{1,2}[-\/.][A-Za-z0-9]{2,9}[-\/.]\d{2,4})\s+al\s+(\d{1,2}[-\/.][A-Za-z0-9]{2,9}[-\/.]\d{2,4})/i
      .exec(flat);
  if (dashed) {
    const from = parseFlexibleDate(dashed[1]);
    const to = parseFlexibleDate(dashed[2]);
    if (from && to) return { from, to };
  }

  return undefined;
};
