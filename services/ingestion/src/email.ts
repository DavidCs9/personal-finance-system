import { simpleParser } from 'mailparser';

export interface NormalizedEmail {
  readonly raw: string;
  readonly from: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly text: string;
  readonly html?: string;
  header(name: string): string | undefined;
}

const headerValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(String).join(', ').trim() || undefined;
  return value === undefined || value === null ? undefined : String(value).trim() || undefined;
};

export const normalizeEmail = async (raw: string): Promise<NormalizedEmail> => {
  const parsed = await simpleParser(raw, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    keepCidLinks: true,
  });
  const text = (parsed.text ?? '')
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');

  return {
    raw,
    from: parsed.from?.text?.trim() ?? '',
    subject: parsed.subject?.trim() ?? '',
    messageId: parsed.messageId?.trim() || undefined,
    text,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    header: (name) => {
      const normalizedName = name.toLowerCase();
      if (normalizedName === 'from') return parsed.from?.text?.trim() || undefined;
      if (normalizedName === 'subject') return parsed.subject?.trim() || undefined;
      if (normalizedName === 'message-id') return parsed.messageId?.trim() || undefined;
      return headerValue(parsed.headers.get(normalizedName));
    },
  };
};
