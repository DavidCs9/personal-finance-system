import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSHandler } from 'aws-lambda';
import { ingestionExceptionAlert, type IngestionExceptionAlertInput } from './notifications.js';
import { maybeAutoAmexMsi } from '@finance/domain';
import { saveObservedEvent } from '@finance/ledger';
import { notifyObservedPurchasePush } from '@finance/notify';
import { emailParsers, header, shouldIgnoreEmail } from './parsers.js';
import type { ParsedPurchase } from './types.js';
import { normalizeEmail } from './email.js';
import { trustedInstitutionHint } from './institution.js';
import { toParsedPurchase } from './bedrock-extractor.js';
import type { BedrockFallbackJob, IngestionJob } from './jobs.js';

export { emailParsers, shouldIgnoreEmail };

const s3 = new S3Client({});
const ses = new SESClient({});
const sqs = new SQSClient({ region: process.env.AWS_REGION, maxAttempts: 5, retryMode: 'adaptive' });
const secrets = new SecretsManagerClient({});
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const ingestionHandler: SQSHandler = async (event) => {
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
  const tableName = requiredEnvironment('METADATA_TABLE_NAME');
  const object = await s3.send(new GetObjectCommand({ Bucket: job.source.bucket, Key: job.source.key }));
  if (!object.Body) throw new Error('Raw SES email object did not contain a body');
  const mime = await object.Body.transformToString();
  const email = await normalizeEmail(mime);
  const sha256 = createHash('sha256').update(mime).digest('hex');
  const sourceMessageId = normaliseMessageId(job.sourceMessageId ?? email.messageId);
  const dedupeKey = createHash('sha256').update(`${sourceMessageId ?? 'no-message-id'}:${sha256}`).digest('hex');

  const source = { bucket: job.source.bucket, key: job.source.key, sha256, contentType: 'message/rfc822' as const };
  if (shouldIgnoreEmail(email)) {
    const claimed = await claimIgnoredSource(tableName, dedupeKey);
    if (!claimed) return;
    console.info(JSON.stringify({ message: 'Administrative email ignored', sourceKey: job.source.key }));
    return;
  }
  let parsed: ParsedPurchase;
  let parserVersion: string;
  if (job.bedrockExtraction) {
    parserVersion = job.bedrockExtraction.version;
    try {
      parsed = toParsedPurchase(job.bedrockExtraction.result, job.bedrockExtraction.institutionHint, email.text);
    } catch (error) {
      await saveException(tableName, {
        receivedAt: job.receivedAt,
        institution: job.bedrockExtraction.institutionHint,
        reason: 'parser_failed',
        details: `Primary: ${job.bedrockExtraction.primaryFailure}. Bedrock: ${errorMessage(error)}`,
        source,
      }, dedupeKey, parserVersion, job.retryExceptionId);
      return;
    }
  } else {
    const parser = emailParsers.find((candidate) => candidate.matches(email));
    if (!parser) {
      const institutionHint = trustedInstitutionHint(email);
      if (institutionHint) {
        await enqueueBedrockFallback({ ...job, sourceMessageId }, institutionHint, 'No configured parser accepted this email.');
        return;
      }
      await saveException(tableName, {
        receivedAt: job.receivedAt,
        reason: 'unsupported_source',
        details: 'No configured parser or trusted institution classifier accepted this SES-received email.',
        source,
      }, dedupeKey, 'source-classifier-v1', job.retryExceptionId);
      return;
    }

    parserVersion = parser.version;
    try {
      parsed = parser.parse(email);
      if (parsed.amount.amountMinor <= 0 || !parsed.amount.currency || !parsed.merchantRaw.trim()) {
        throw new Error('Parser returned incomplete event data.');
      }
    } catch (error) {
      await enqueueBedrockFallback({ ...job, sourceMessageId }, parser.institution, errorMessage(error));
      return;
    }
  }

  if (parsed.amount.amountMinor <= 0 || !parsed.amount.currency || !parsed.merchantRaw.trim()) {
    await saveException(tableName, {
      receivedAt: job.receivedAt,
      institution: parsed.institution,
      reason: 'missing_required_data',
      details: 'Extractor returned incomplete event data.',
      source,
    }, dedupeKey, parserVersion, job.retryExceptionId);
    return;
  }

  const importWarning = header(email, 'x-ledger-import-source')
    ? ['Importado desde un PDF de ejemplo; el MIME original no estaba disponible.']
    : [];
  const parseWarnings = [...(parsed.parseWarnings ?? []), ...importWarning];
  const autoMsi = maybeAutoAmexMsi({
    institution: parsed.institution,
    amountMinor: parsed.amount.amountMinor,
    occurredAt: parsed.occurredAt,
    receivedAt: job.receivedAt,
  });
  const purchase = {
    id: randomUUID(),
    institution: parsed.institution,
    eventType: parsed.eventType ?? 'card_purchase',
    status: parseWarnings.length ? 'needs_review' : 'accepted',
    account: parsed.account ? { ...parsed.account } : undefined,
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
    parserVersion,
    parseWarnings,
    ...(autoMsi ? { msi: autoMsi } : {}),
  };
  const saved = await saveObservedEvent({
    database,
    tableName,
    dedupeKey,
    captureSource: 'email',
    event: purchase,
    reconciliationAt: job.receivedAt,
  });
  if (saved.duplicate) {
    if (job.retryExceptionId) await markRetryCompleted(tableName, job.retryExceptionId, saved.eventId);
    console.info(JSON.stringify({ message: 'Duplicate SES email ignored', dedupeKey }));
    return;
  }
  if (job.retryExceptionId) await markRetryCompleted(tableName, job.retryExceptionId, saved.eventId);
  if (!saved.created) {
    console.info(JSON.stringify({ message: 'Email observation reconciled with an existing event', eventId: saved.eventId }));
    return;
  }
  try {
    await notifyObservedPurchaseByPush(tableName, purchase);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Unable to send observed-movement push',
      eventId: purchase.id,
      error: errorMessage(error),
    }));
  }
};

const enqueueBedrockFallback = async (
  job: IngestionJob,
  institutionHint: BedrockFallbackJob['institutionHint'],
  primaryFailure: string,
): Promise<void> => {
  const fallbackJob: BedrockFallbackJob = {
    receivedAt: job.receivedAt,
    sourceMessageId: job.sourceMessageId,
    source: job.source,
    retryExceptionId: job.retryExceptionId,
    institutionHint,
    primaryFailure,
  };
  await sqs.send(new SendMessageCommand({
    QueueUrl: requiredEnvironment('BEDROCK_FALLBACK_QUEUE_URL'),
    MessageBody: JSON.stringify(fallbackJob),
  }));
  console.warn(JSON.stringify({
    message: 'Email queued for Bedrock fallback extraction',
    sourceKey: job.source.key,
    institution: institutionHint,
  }));
};

const claimIgnoredSource = async (tableName: string, dedupeKey: string): Promise<boolean> => {
  try {
    await database.send(new PutCommand({
      TableName: tableName,
      Item: { PK: `DEDUPE#${dedupeKey}`, SK: 'CLAIM', entityType: 'source_dedupe_claim', createdAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (error) {
    if (errorName(error) === 'ConditionalCheckFailedException') return false;
    throw error;
  }
};

const markRetryCompleted = async (tableName: string, exceptionId: string, eventId: string): Promise<void> => {
  await database.send(new UpdateCommand({
    TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' },
    UpdateExpression: 'SET #payload.#retry.#status = :status, #payload.#retry.#completedAt = :completedAt, #payload.#retry.#eventId = :eventId',
    ExpressionAttributeNames: { '#payload': 'payload', '#retry': 'retry', '#status': 'status', '#completedAt': 'completedAt', '#eventId': 'eventId' },
    ExpressionAttributeValues: { ':status': 'completed', ':completedAt': new Date().toISOString(), ':eventId': eventId },
  }));
};

const markRetryFailed = async (tableName: string, exceptionId: string, details: string): Promise<void> => {
  await database.send(new UpdateCommand({
    TableName: tableName, Key: { PK: `EXCEPTION#${exceptionId}`, SK: 'EXCEPTION' },
    UpdateExpression: 'SET #payload.#retry.#status = :status, #payload.#retry.#failedAt = :failedAt, #payload.#retry.#details = :details',
    ExpressionAttributeNames: {
      '#payload': 'payload', '#retry': 'retry', '#status': 'status', '#failedAt': 'failedAt', '#details': 'details',
    },
    ExpressionAttributeValues: { ':status': 'failed', ':failedAt': new Date().toISOString(), ':details': details },
  }));
};

type NewIngestionException = Omit<IngestionExceptionAlertInput, 'id'>;

const saveException = async (
  tableName: string,
  exception: NewIngestionException,
  sourceDedupeKey: string,
  extractorVersion: string,
  retryExceptionId?: string,
): Promise<void> => {
  const id = randomUUID();
  const savedException = { id, ...exception };
  const exceptionDedupeKey = createHash('sha256')
    .update(`${sourceDedupeKey}:${extractorVersion}:${exception.reason}`)
    .digest('hex');
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EXCEPTION_DEDUPE#${exceptionDedupeKey}`,
          SK: 'CLAIM',
          entityType: 'ingestion_exception_claim',
          sourceDedupeKey,
          extractorVersion,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EXCEPTION#${id}`,
          SK: 'EXCEPTION',
          GSI1PK: 'EXCEPTIONS',
          GSI1SK: String(exception.receivedAt),
          entityType: 'ingestion_exception',
          payload: savedException,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
    ] }));
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') {
      if (retryExceptionId) await markRetryFailed(tableName, retryExceptionId, exception.details);
      console.info(JSON.stringify({ message: 'Duplicate SES email exception ignored', exceptionDedupeKey }));
      return;
    }
    throw error;
  }
  if (retryExceptionId) await markRetryFailed(tableName, retryExceptionId, exception.details);
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

const notifyObservedPurchaseByPush = async (tableName: string, purchase: {
  readonly id: string;
  readonly institution: string;
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly merchantRaw: string;
}): Promise<void> => {
  const vapidSecretArn = process.env.VAPID_SECRET_ARN;
  const navigateUrl = process.env.WEB_APP_URL;
  if (!vapidSecretArn || !navigateUrl) {
    console.info(JSON.stringify({ message: 'Purchase push skipped until VAPID secret and web app URL are configured.' }));
    return;
  }
  const result = await notifyObservedPurchasePush({
    database,
    tableName,
    secrets,
    vapidSecretArn,
    navigateUrl,
    purchase,
  });
  console.info(JSON.stringify({
    message: 'Observed-purchase push finished',
    eventId: purchase.id,
    sent: result.sent,
    expired: result.expired,
    failed: result.failed,
  }));
};

const normaliseMessageId = (value?: string): string | undefined => value?.trim().replace(/^<|>$/g, '').toLowerCase() || undefined;
const errorName = (error: unknown): string | undefined => error instanceof Error ? error.name : undefined;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export { ingestionHandler as handler };
