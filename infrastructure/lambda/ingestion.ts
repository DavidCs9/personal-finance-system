import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSHandler } from 'aws-lambda';

const s3 = new S3Client({});
const ses = new SESClient({});
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface IngestionJob {
  readonly receivedAt: string;
  readonly sourceMessageId?: string;
  readonly source: { readonly bucket: string; readonly key: string };
}

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) throw new Error('Missing required environment variable: METADATA_TABLE_NAME');

interface ParsedPurchase {
  readonly institution: 'american_express_mx' | 'santander_mx';
  readonly account?: { readonly institution: string; readonly accountId: string; readonly displayName: string; readonly lastFour?: string };
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly merchantRaw: string;
  readonly occurredAt?: string;
  readonly parseWarnings?: readonly string[];
}

interface EmailParser {
  readonly institution: ParsedPurchase['institution'];
  readonly version: string;
  matches(mime: string): boolean;
  parse(mime: string): ParsedPurchase;
}

export const handler: SQSHandler = async (event) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await ingest(JSON.parse(record.body) as IngestionJob);
    } catch (error) {
      console.error('Unable to ingest SES email', { messageId: record.messageId, error: errorMessage(error) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

const ingest = async (job: IngestionJob): Promise<void> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: job.source.bucket, Key: job.source.key }));
  if (!object.Body) throw new Error('Raw SES email object did not contain a body');
  const mime = await object.Body.transformToString();
  const sha256 = createHash('sha256').update(mime).digest('hex');
  const sourceMessageId = normaliseMessageId(job.sourceMessageId);
  const dedupeKey = createHash('sha256').update(`${sourceMessageId ?? 'no-message-id'}:${sha256}`).digest('hex');

  try {
    await database.send(new PutCommand({
      TableName: tableName,
      Item: { PK: `DEDUPE#${dedupeKey}`, SK: 'CLAIM', createdAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if (errorName(error) === 'ConditionalCheckFailedException') {
      console.info(JSON.stringify({ message: 'Duplicate SES email ignored', dedupeKey }));
      return;
    }
    throw error;
  }

  const source = { bucket: job.source.bucket, key: job.source.key, sha256, contentType: 'message/rfc822' as const };
  const parser = emailParsers.find((candidate) => candidate.matches(mime));
  if (!parser) {
    await saveException({
      receivedAt: job.receivedAt,
      reason: 'unsupported_source',
      details: 'No configured parser accepted this SES-received email.',
      source,
    });
    return;
  }

  try {
    const parsed = parser.parse(mime);
    if (parsed.amount.amountMinor <= 0 || !parsed.amount.currency || !parsed.merchantRaw.trim()) {
      throw new Error('Parser returned incomplete purchase data.');
    }
    const purchase = {
      id: randomUUID(),
      institution: parsed.institution,
      eventType: 'card_purchase',
      status: 'accepted',
      account: parsed.account,
      amount: parsed.amount,
      merchantRaw: parsed.merchantRaw,
      occurredAt: parsed.occurredAt,
      receivedAt: job.receivedAt,
      ingestedAt: new Date().toISOString(),
      sourceMessageId,
      source,
      parserVersion: parser.version,
      parseWarnings: parsed.parseWarnings ?? [],
    };
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `EVENT#${purchase.id}`,
        SK: 'EVENT',
        GSI1PK: 'EVENTS',
        GSI1SK: purchase.receivedAt,
        entityType: 'observed_purchase',
        payload: purchase,
      },
    }));
    await notifyObservedPurchase(purchase);
  } catch (error) {
    await saveException({
      receivedAt: job.receivedAt,
      institution: parser.institution,
      reason: 'parser_failed',
      details: errorMessage(error),
      source,
    });
  }
};

const saveException = async (exception: Record<string, unknown>): Promise<void> => {
  const id = randomUUID();
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `EXCEPTION#${id}`,
      SK: 'EXCEPTION',
      GSI1PK: 'EXCEPTIONS',
      GSI1SK: String(exception.receivedAt),
      entityType: 'ingestion_exception',
      payload: { id, ...exception },
    },
  }));
  console.warn(JSON.stringify({ message: 'SES email needs review', exception: { reason: exception.reason, institution: exception.institution } }));
};

const notifyObservedPurchase = async (purchase: { readonly institution: string; readonly amount: { readonly amountMinor: number; readonly currency: string }; readonly merchantRaw: string }): Promise<void> => {
  const source = process.env.ALERT_SENDER_EMAIL;
  const destination = process.env.ALERT_RECIPIENT_EMAIL;
  if (!source || !destination || source.startsWith('replace-with-') || destination.startsWith('replace-with-')) {
    console.info(JSON.stringify({ message: 'Purchase alert skipped until SES sender and recipient are configured.' }));
    return;
  }
  await ses.send(new SendEmailCommand({
    Source: source,
    Destination: { ToAddresses: [destination] },
    Message: {
      Subject: { Data: `Compra observada: ${purchase.institution}` },
      Body: { Text: { Data: `${purchase.merchantRaw}: ${(purchase.amount.amountMinor / 100).toFixed(2)} ${purchase.amount.currency}` } },
    },
  }));
};

const header = (mime: string, name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(mime)?.[1]?.trim();
const body = (mime: string): string => mime.split(/\r?\n\r?\n/, 2)[1] ?? mime;
const compact = (value: string): string => value.replace(/\s+/g, ' ').trim();
const mxnMinorUnits = (amount: string): number => {
  const [whole, fraction = ''] = amount.replace(/,/g, '').split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new Error(`Invalid MXN amount: ${amount}`);
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
const accountFromLastFour = (institution: ParsedPurchase['institution'], lastFour?: string) => lastFour
  ? { institution, accountId: `${institution}:${lastFour}`, displayName: `Tarjeta terminada en ${lastFour}`, lastFour }
  : undefined;
const emailParsers: readonly EmailParser[] = [
  {
    institution: 'american_express_mx',
    version: 'amex-mx-card-purchase-v1',
    matches: (mime) => (header(mime, 'from')?.toLowerCase() ?? '').includes('americanexpress') || /american express/i.test(body(mime)),
    parse: (mime) => {
      const text = body(mime);
      const amount = /(?:importe|monto)\s*(?:de)?\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text)?.[1];
      const merchant = /(?:establecimiento|comercio)\s*:\s*(.+)/i.exec(text)?.[1];
      const lastFour = /(?:terminaci[oó]n|tarjeta)\s*(?:en)?\s*(\d{4})/i.exec(text)?.[1];
      const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1];
      if (!amount || !merchant) throw new Error('Amex MX card-purchase alert is missing amount or merchant');
      return { institution: 'american_express_mx', account: accountFromLastFour('american_express_mx', lastFour), amount: { amountMinor: mxnMinorUnits(amount), currency: 'MXN' }, merchantRaw: compact(merchant), occurredAt };
    },
  },
  {
    institution: 'santander_mx',
    version: 'santander-mx-card-purchase-v1',
    matches: (mime) => (header(mime, 'from')?.toLowerCase() ?? '').includes('santander') || /santander/i.test(body(mime)),
    parse: (mime) => {
      const text = body(mime);
      const uniqueRewardsPurchase = /autoriz[oó]\s+una\s+compra\s+en\s+(.+?)\s+por\s+un\s+monto\s+de\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text);
      const amount = uniqueRewardsPurchase?.[2] ?? /(?:compra|cargo)\s*(?:por|de)\s*\$?\s*([\d,.]+)\s*(?:MXN|M\.N\.)/i.exec(text)?.[1];
      const merchant = uniqueRewardsPurchase?.[1] ?? /(?:en|comercio)\s*:\s*([^\r\n]+)/i.exec(text)?.[1];
      const lastFour = /(?:tarjeta|terminaci[oó]n)\s*(?:\*+|en)?\s*(\d{4})/i.exec(text)?.[1];
      const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1];
      if (!amount || !merchant) throw new Error('Santander MX card-purchase alert is missing amount or merchant');
      return { institution: 'santander_mx', account: accountFromLastFour('santander_mx', lastFour), amount: { amountMinor: mxnMinorUnits(amount), currency: 'MXN' }, merchantRaw: compact(merchant), occurredAt };
    },
  },
];

const normaliseMessageId = (value?: string): string | undefined => value?.trim().replace(/^<|>$/g, '').toLowerCase() || undefined;
const errorName = (error: unknown): string | undefined => error instanceof Error ? error.name : undefined;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
