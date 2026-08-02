import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSHandler } from 'aws-lambda';
import { ingestionExceptionAlert, type IngestionExceptionAlertInput } from './ingestion-notifications.js';

const s3 = new S3Client({});
const ses = new SESClient({});
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

interface IngestionJob {
  readonly receivedAt: string;
  readonly sourceMessageId?: string;
  readonly source: { readonly bucket: string; readonly key: string };
}

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) throw new Error('Missing required environment variable: METADATA_TABLE_NAME');

interface ParsedPurchase {
  readonly institution: 'american_express_mx' | 'santander_mx' | 'nu_mx' | 'amazon_web_services';
  readonly account?: { readonly institution: string; readonly accountId: string; readonly displayName: string; readonly lastFour?: string };
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly merchantRaw: string;
  readonly eventType?: 'card_purchase' | 'outgoing_transfer' | 'card_charge';
  readonly counterparty?: string;
  readonly transferType?: 'spei';
  readonly reference?: string;
  readonly folio?: string;
  readonly trackingKey?: string;
  readonly counterpartyInstitution?: string;
  readonly counterpartyAccountLastFour?: string;
  readonly billingPeriod?: string;
  readonly paymentMethodLastFour?: string;
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
      throw new Error('Parser returned incomplete event data.');
    }
    const importWarning = header(mime, 'x-ledger-import-source')
      ? ['Importado desde un PDF de ejemplo; el MIME original no estaba disponible.']
      : [];
    const parseWarnings = [...(parsed.parseWarnings ?? []), ...importWarning];
    const purchase = {
      id: randomUUID(),
      institution: parsed.institution,
      eventType: parsed.eventType ?? 'card_purchase',
      status: parseWarnings.length ? 'needs_review' : 'accepted',
      account: parsed.account,
      amount: parsed.amount,
      merchantRaw: parsed.merchantRaw,
      counterparty: parsed.counterparty,
      transferType: parsed.transferType,
      reference: parsed.reference,
      folio: parsed.folio,
      trackingKey: parsed.trackingKey,
      counterpartyInstitution: parsed.counterpartyInstitution,
      counterpartyAccountLastFour: parsed.counterpartyAccountLastFour,
      billingPeriod: parsed.billingPeriod,
      paymentMethodLastFour: parsed.paymentMethodLastFour,
      occurredAt: parsed.occurredAt,
      receivedAt: job.receivedAt,
      ingestedAt: new Date().toISOString(),
      sourceMessageId,
      source,
      parserVersion: parser.version,
      parseWarnings,
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
    try {
      await notifyObservedPurchase(purchase);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'Unable to send observed-movement alert',
        eventId: purchase.id,
        error: errorMessage(error),
      }));
    }
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

type NewIngestionException = Omit<IngestionExceptionAlertInput, 'id'>;

const saveException = async (exception: NewIngestionException): Promise<void> => {
  const id = randomUUID();
  const savedException = { id, ...exception };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `EXCEPTION#${id}`,
      SK: 'EXCEPTION',
      GSI1PK: 'EXCEPTIONS',
      GSI1SK: String(exception.receivedAt),
      entityType: 'ingestion_exception',
      payload: savedException,
    },
  }));
  console.warn(JSON.stringify({ message: 'SES email needs review', exception: { reason: exception.reason, institution: exception.institution } }));
  try {
    await notifyIngestionException(savedException);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Unable to send ingestion-exception alert',
      exceptionId: id,
      error: errorMessage(error),
    }));
  }
};

const configuredAlertAddresses = (): { readonly source: string; readonly destination: string } | undefined => {
  const source = process.env.ALERT_SENDER_EMAIL;
  const destination = process.env.ALERT_RECIPIENT_EMAIL;
  return source && destination && !source.startsWith('replace-with-') && !destination.startsWith('replace-with-')
    ? { source, destination }
    : undefined;
};

const notifyIngestionException = async (exception: IngestionExceptionAlertInput): Promise<void> => {
  const addresses = configuredAlertAddresses();
  if (!addresses) {
    console.info(JSON.stringify({ message: 'Ingestion-exception alert skipped until SES sender and recipient are configured.' }));
    return;
  }
  const alert = ingestionExceptionAlert(exception);
  await ses.send(new SendEmailCommand({
    Source: addresses.source,
    Destination: { ToAddresses: [addresses.destination] },
    Message: {
      Subject: { Data: alert.subject },
      Body: { Text: { Data: alert.body } },
    },
  }));
};

const notifyObservedPurchase = async (purchase: { readonly institution: string; readonly eventType: string; readonly amount: { readonly amountMinor: number; readonly currency: string }; readonly merchantRaw: string }): Promise<void> => {
  const addresses = configuredAlertAddresses();
  if (!addresses) {
    console.info(JSON.stringify({ message: 'Purchase alert skipped until SES sender and recipient are configured.' }));
    return;
  }
  await ses.send(new SendEmailCommand({
    Source: addresses.source,
    Destination: { ToAddresses: [addresses.destination] },
    Message: {
      Subject: { Data: `Movimiento observado: ${purchase.institution}` },
      Body: { Text: { Data: `${purchase.merchantRaw}: ${(purchase.amount.amountMinor / 100).toFixed(2)} ${purchase.amount.currency}` } },
    },
  }));
};

const header = (mime: string, name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(mime)?.[1]?.trim();
const body = (mime: string): string => mime.split(/\r?\n\r?\n/, 2)[1] ?? mime;
const compact = (value: string): string => value.replace(/\s+/g, ' ').trim();
const decodeQuotedPrintable = (value: string): string => {
  const bytes = value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(bytes, 'binary').toString('utf8');
};
const decodedBody = (mime: string): string => {
  const raw = body(mime);
  return /quoted-printable/i.test(header(mime, 'content-transfer-encoding') ?? '')
    ? decodeQuotedPrintable(raw)
    : raw;
};
const readableBody = (mime: string): string =>
  decodedBody(mime)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|td|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
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
  const [whole, fraction = ''] = amount.replace(/,/g, '').split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new Error(`Invalid MXN amount: ${amount}`);
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
const nuMonthMap = { ENE: 0, FEB: 1, MAR: 2, ABR: 3, MAY: 4, JUN: 5, JUL: 6, AGO: 7, SEP: 8, OCT: 9, NOV: 10, DIC: 11 } as const;
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
    const occurredAt = /fecha\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i.exec(text)?.[1]
      ?? dateOnlyToIso(/(?:fecha|d[ií]a)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1]);
      if (!amount || !merchant) throw new Error('Amex MX card-purchase alert is missing amount or merchant');
      return { institution: 'american_express_mx', account: accountFromLastFour('american_express_mx', lastFour), amount: { amountMinor: mxnMinorUnits(amount), currency: 'MXN' }, merchantRaw: compact(merchant), occurredAt };
    },
  },
  {
    institution: 'amazon_web_services',
    version: 'aws-mx-billing-statement-v1',
    matches: (mime) => {
      const from = (header(mime, 'from') ?? '').toLowerCase();
      const subject = header(mime, 'subject') ?? '';
      const text = readableBody(mime);
      return from.includes('invoicing@aws.com')
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
        throw new Error('AWS MX billing statement is missing amount, account, payment card, or billing period');
      }
      const month = Number(billing[2]);
      if (month < 1 || month > 12) throw new Error(`Invalid AWS billing month: ${billing[2]}`);
      return {
        institution: 'amazon_web_services',
        eventType: 'card_charge',
        account: {
          institution: 'amazon_web_services',
          accountId: `amazon_web_services:${awsAccountLastFour}`,
          displayName: `Cuenta AWS terminada en ${awsAccountLastFour}`,
          lastFour: awsAccountLastFour,
        },
        amount: { amountMinor: mxnMinorUnits(amount), currency: 'MXN' },
        merchantRaw: 'Amazon Web Services',
        billingPeriod: `${billing[1]}-${String(month).padStart(2, '0')}`,
        paymentMethodLastFour,
      };
    },
  },
  {
    institution: 'santander_mx',
    version: 'santander-mx-card-purchase-v2',
    matches: (mime) => {
      const from = (header(mime, 'from') ?? '').toLowerCase();
      const text = readableBody(mime);
      return from.includes('santander') || (/santander/i.test(text) && /\b(?:compra|cargo)\b/i.test(text));
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
      if (!amount || !merchant) throw new Error('Santander MX card-purchase alert is missing amount or merchant');
      return { institution: 'santander_mx', account: accountFromLastFour('santander_mx', lastFour), amount: { amountMinor: mxnMinorUnits(amount), currency: 'MXN' }, merchantRaw: compact(merchant), occurredAt };
    },
  },
  {
    institution: 'nu_mx',
    version: 'nu-mx-outgoing-transfer-v2',
    matches: (mime) => {
      const from = (header(mime, 'from') ?? '').toLowerCase();
      const subject = (header(mime, 'subject') ?? '').toLowerCase();
      const text = readableBody(mime);
      return (from.includes('nu@nu.com.mx') || from.includes('nu.com.mx'))
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
      if (!amount || !recipient || !date || !time || transferType !== 'spei' || !status || !/completada/i.test(status)) {
        throw new Error('Nu MX outgoing-transfer alert is missing amount, recipient, date, time, SPEI type, or completed status');
      }
      const month = nuMonthMap[date[2] as keyof typeof nuMonthMap];
      if (month === undefined) throw new Error(`Invalid Nu MX transfer month: ${date[2]}`);
      const occurredAt = new Date(Date.UTC(Number(date[3]), month, Number(date[1]), Number(time[1]) + 6, Number(time[2])));
      if (occurredAt.getUTCFullYear() !== Number(date[3]) || occurredAt.getUTCMonth() !== month || occurredAt.getUTCDate() !== Number(date[1])) throw new Error('Invalid Nu MX transfer date');
      return {
        institution: 'nu_mx',
        eventType: 'outgoing_transfer',
        account: { institution: 'nu_mx', accountId: 'nu_mx:primary', displayName: 'Cuenta Nu' },
        amount: { amountMinor: mxnMinorUnits(amount), currency: 'MXN' },
        merchantRaw: compact(recipient),
        counterparty: compact(recipient),
        transferType: 'spei',
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

const normaliseMessageId = (value?: string): string | undefined => value?.trim().replace(/^<|>$/g, '').toLowerCase() || undefined;
const errorName = (error: unknown): string | undefined => error instanceof Error ? error.name : undefined;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
