/** MIME plumbing for inbound bank alerts. Field extraction is Textract's job. */

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

const body = (mime: string): string => {
  const separator = /\r?\n\r?\n/.exec(mime);
  return separator?.index === undefined ? mime : mime.slice(separator.index + separator[0].length);
};

const decodeText = (bytes: Uint8Array, charset?: string): string => {
  const normalisedCharset = charset?.trim().toLowerCase().replace(/^utf8$/, "utf-8");
  const supportedCharset = normalisedCharset === "windows-1252"
    || normalisedCharset === "iso-8859-1"
    || normalisedCharset === "utf-8"
    ? normalisedCharset
    : "utf-8";
  return new TextDecoder(supportedCharset).decode(bytes);
};

const decodeQuotedPrintable = (value: string, charset?: string): string => {
  const bytes = value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decodeText(Buffer.from(bytes, "latin1"), charset);
};

const boundaryFrom = (contentType?: string): string | undefined => {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return match?.[1] ?? match?.[2];
};

const charsetFrom = (contentType?: string): string | undefined => {
  const match = /charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return match?.[1] ?? match?.[2];
};

const multipartParts = (value: string, boundary: string): readonly string[] => {
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

const textParts = (mime: string): readonly string[] => {
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

const decodeHref = (value: string): string =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/=3D/gi, "=")
    .trim();

/** Readable body plus HTML hrefs so Textract can see billing URLs and similar. */
export const documentTextForTextract = (mime: string): string => {
  const text = readableBody(mime).replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const hrefs = [...decodedBody(mime).matchAll(/\bhref\s*=\s*(?:3D)?["']?([^"'>\s]+)/gi)]
    .map((match) => decodeHref(match[1] ?? ""))
    .filter((href) => /^https?:\/\//i.test(href));
  const uniqueHrefs = [...new Set(hrefs)];
  if (uniqueHrefs.length === 0) return text;
  return `${text}\n\nLinks:\n${uniqueHrefs.join("\n")}`;
};
