import {
  AnalyzeDocumentCommand,
  TextractClient,
  type Block,
  type Query,
} from '@aws-sdk/client-textract';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Institution } from '@finance/domain';
import {
  detectEmailInstitution,
  documentTextForTextract,
  InvalidEmailTextractError,
  mapTextractEmailPurchase,
  type ParsedPurchase,
  type TextractEmailExtraction,
  type TextractEmailQueryAnswer,
} from '@finance/ingestion';

export class EmailTextractError extends Error {}

const amexQueries: readonly Query[] = [
  { Text: 'What is the purchase amount in MXN?', Alias: 'AMOUNT' },
  { Text: 'What is the merchant or establishment name?', Alias: 'MERCHANT' },
  { Text: 'What are the last 4 digits of the card number?', Alias: 'ACCOUNT_LAST_FOUR' },
  { Text: 'What is the purchase date?', Alias: 'OCCURRED_AT' },
];

const santanderQueries: readonly Query[] = [
  { Text: 'What is the authorized purchase amount in MXN or M.N.?', Alias: 'AMOUNT' },
  { Text: 'Where was the purchase made? What is the merchant name?', Alias: 'MERCHANT' },
  { Text: 'What are the last 4 digits of the card termination?', Alias: 'ACCOUNT_LAST_FOUR' },
  { Text: 'What is the purchase date?', Alias: 'OCCURRED_AT' },
];

const nuQueries: readonly Query[] = [
  { Text: 'What is the transfer amount?', Alias: 'AMOUNT' },
  { Text: 'What is the recipient name?', Alias: 'RECIPIENT' },
  { Text: 'What is the transfer date?', Alias: 'DATE' },
  { Text: 'What is the transfer time?', Alias: 'TIME' },
  { Text: 'What is the transfer type?', Alias: 'TRANSFER_TYPE' },
  { Text: 'What is the transfer status?', Alias: 'STATUS' },
  { Text: 'What is the reference number?', Alias: 'REFERENCE' },
  { Text: 'What is the folio?', Alias: 'FOLIO' },
  { Text: 'What is the tracking key (clave de rastreo)?', Alias: 'TRACKING_KEY' },
  { Text: 'What is the destination bank or entity?', Alias: 'COUNTERPARTY_INSTITUTION' },
  { Text: 'What are the last 4 digits of the CLABE?', Alias: 'CLABE_LAST_FOUR' },
];

const awsQueries: readonly Query[] = [
  { Text: 'What is the total amount in MXN?', Alias: 'AMOUNT_MXN' },
  { Text: 'What are the last 4 digits of the AWS account?', Alias: 'AWS_ACCOUNT_LAST_FOUR' },
  { Text: 'What are the last 4 digits of the credit card payment method?', Alias: 'PAYMENT_CARD_LAST_FOUR' },
  { Text: 'What is the billing year in the bills URL?', Alias: 'BILLING_YEAR' },
  { Text: 'What is the billing month in the bills URL?', Alias: 'BILLING_MONTH' },
];

export const emailQueries = (institution: Institution): readonly Query[] => {
  switch (institution) {
    case 'american_express_mx':
      return amexQueries;
    case 'santander_mx':
      return santanderQueries;
    case 'nu_mx':
      return nuQueries;
    case 'amazon_web_services':
      return awsQueries;
  }
};

const escapePdfString = (value: string): string =>
  [...value].map((character) => {
    if (character === '\\' || character === '(' || character === ')') return `\\${character}`;
    const code = character.codePointAt(0) ?? 63;
    if (code < 32 || (code > 126 && code < 160) || code > 255) {
      // WinAnsi / Latin-1 page only; drop unsupported glyphs.
      if (code > 255) return '?';
      return `\\${code.toString(8).padStart(3, '0')}`;
    }
    if (code > 126) return `\\${code.toString(8).padStart(3, '0')}`;
    return character;
  }).join('');

const wrapLines = (text: string, maxChars: number): string[] => {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = words[0]!;
    for (const word of words.slice(1)) {
      if (`${current} ${word}`.length <= maxChars) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines.slice(0, 60);
};

/** Minimal single-page PDF so sync AnalyzeDocument can query the alert body. */
export const renderEmailBodyPdf = (text: string): Uint8Array => {
  const lines = wrapLines(text.normalize('NFC'), 90);
  if (lines.every((line) => !line.trim())) {
    throw new EmailTextractError('Email body is empty; cannot build Textract document.');
  }
  const contentLines = [
    'BT',
    '/F1 11 Tf',
    '50 770 Td',
    '14 TL',
    ...lines.flatMap((line, index) => {
      const escaped = escapePdfString(line);
      return index === 0 ? [`(${escaped}) Tj`] : ['T*', `(${escaped}) Tj`];
    }),
    'ET',
  ];
  const stream = contentLines.join('\n');
  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n',
    `4 0 obj<< /Length ${Buffer.byteLength(stream, 'latin1')} >>stream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>endobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
};

const blockText = (block: Block | undefined, byId: ReadonlyMap<string, Block>): string => {
  if (!block) return '';
  if (block.Text) return block.Text.trim();
  const childIds = block.Relationships?.find((relation) => relation.Type === 'CHILD')?.Ids ?? [];
  return childIds
    .map((id) => byId.get(id))
    .filter((child): child is Block => Boolean(child && (child.BlockType === 'WORD' || child.BlockType === 'LINE')))
    .map((child) => child.Text?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
};

const extractQueryAnswers = (blocks: readonly Block[]): readonly TextractEmailQueryAnswer[] => {
  const byId = new Map(blocks.filter((block) => block.Id).map((block) => [block.Id!, block]));
  const answers: TextractEmailQueryAnswer[] = [];
  for (const block of blocks) {
    if (block.BlockType !== 'QUERY') continue;
    const alias = block.Query?.Alias ?? '';
    const question = block.Query?.Text ?? '';
    const resultIds = block.Relationships?.find((relation) => relation.Type === 'ANSWER')?.Ids ?? [];
    const resultBlock = resultIds.map((id) => byId.get(id)).find((candidate) => candidate?.BlockType === 'QUERY_RESULT');
    const answer = resultBlock ? (resultBlock.Text?.trim() || blockText(resultBlock, byId) || undefined) : undefined;
    answers.push({
      alias,
      question,
      answer: answer || undefined,
      confidence: resultBlock?.Confidence,
    });
  }
  return answers;
};

export const normalizeEmailTextractAnalysis = (
  institution: Institution,
  blocks: readonly Block[],
): TextractEmailExtraction => {
  const queryAnswers = extractQueryAnswers(blocks);
  const answers: Record<string, string> = {};
  for (const item of queryAnswers) {
    if (item.alias && item.answer) answers[item.alias] = item.answer;
  }
  return { institution, answers, queryAnswers };
};

export const analyzeEmailWithTextract = async (
  client: TextractClient,
  institution: Institution,
  pdfBytes: Uint8Array,
): Promise<TextractEmailExtraction> => {
  const result = await client.send(new AnalyzeDocumentCommand({
    Document: { Bytes: pdfBytes },
    FeatureTypes: ['QUERIES'],
    QueriesConfig: { Queries: [...emailQueries(institution)] },
  }));
  const extraction = normalizeEmailTextractAnalysis(institution, result.Blocks ?? []);
  if (Object.keys(extraction.answers).length === 0) {
    throw new EmailTextractError('Textract no devolvió respuestas útiles para el correo.');
  }
  return extraction;
};

export const textractJsonKeyForSource = (sourceKey: string): string =>
  sourceKey.endsWith('.textract.json') ? sourceKey : `${sourceKey}.textract.json`;

export const persistEmailTextractExtraction = async (
  s3: S3Client,
  bucket: string,
  sourceKey: string,
  extraction: TextractEmailExtraction,
): Promise<string> => {
  const key = textractJsonKeyForSource(sourceKey);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: 'application/json',
    Body: JSON.stringify(extraction, null, 2),
  }));
  return key;
};

export const extractPurchaseFromEmailMime = async (input: {
  readonly textract: TextractClient;
  readonly s3: S3Client;
  readonly mime: string;
  readonly sourceBucket: string;
  readonly sourceKey: string;
}): Promise<ParsedPurchase> => {
  const institution = detectEmailInstitution(input.mime);
  if (!institution) {
    const error = new EmailTextractError('No configured institution accepted this SES-received email.');
    (error as Error & { reason: string }).reason = 'unsupported_source';
    throw error;
  }
  const documentText = documentTextForTextract(input.mime);
  const pdfBytes = renderEmailBodyPdf(documentText);
  let extraction: TextractEmailExtraction;
  try {
    extraction = await analyzeEmailWithTextract(input.textract, institution, pdfBytes);
  } catch (error) {
    if (error instanceof EmailTextractError || error instanceof InvalidEmailTextractError) throw error;
    throw new EmailTextractError(error instanceof Error ? error.message : 'Textract analysis failed.');
  }
  await persistEmailTextractExtraction(input.s3, input.sourceBucket, input.sourceKey, extraction);
  try {
    return mapTextractEmailPurchase(institution, extraction);
  } catch (error) {
    if (error instanceof InvalidEmailTextractError) throw error;
    throw new EmailTextractError(error instanceof Error ? error.message : 'Unable to map Textract answers.');
  }
};
