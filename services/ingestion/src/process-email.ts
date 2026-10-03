import { withNativeTransaction } from '@finance/ledger/dsql-store';
import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { assertNativeExceptionAccess,resolveRetryAttempt,completeRetryAttempt,failRetryAttempt,saveClaimedReviewException,type ReviewException } from '@finance/ledger/native-exceptions';
import type { SQSHandler } from 'aws-lambda';
import { ingestionExceptionAlert, type IngestionExceptionAlertInput } from './notifications.js';
import { maybeAutoAmexMsi } from '@finance/domain';
import { captureObservedEvent, claimIgnoredEmail, SourceClaimUnavailableError } from '@finance/ledger/native-ledger';
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

export const ingestionHandler: SQSHandler = async (event) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await assertNativeExceptionAccess();
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
  const email = await normalizeEmail(mime);
  const sha256 = createHash('sha256').update(mime).digest('hex');
  const sourceMessageId = normaliseMessageId(job.sourceMessageId ?? email.messageId);
  const dedupeKey = createHash('sha256').update(`${sourceMessageId ?? 'no-message-id'}:${sha256}`).digest('hex');

  const source = { bucket: job.source.bucket, key: job.source.key, sha256, contentType: 'message/rfc822' as const };
  if (shouldIgnoreEmail(email)) {
    const claimed = await withNativeTransaction(client => claimIgnoredEmail(client, dedupeKey, new Date().toISOString()));
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
      await saveException({
        receivedAt: job.receivedAt,
        institution: job.bedrockExtraction.institutionHint,
        reason: 'parser_failed',
        details: `Primary: ${job.bedrockExtraction.primaryFailure}. Bedrock: ${errorMessage(error)}`,
        source,
      }, dedupeKey, parserVersion, job);
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
      await saveException({
        receivedAt: job.receivedAt,
        reason: 'unsupported_source',
        details: 'No configured parser or trusted institution classifier accepted this SES-received email.',
        source,
      }, dedupeKey, 'source-classifier-v1', job);
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
    await saveException({
      receivedAt: job.receivedAt,
      institution: parsed.institution,
      reason: 'missing_required_data',
      details: 'Extractor returned incomplete event data.',
      source,
    }, dedupeKey, parserVersion, job);
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
  let saved;
  try {
    const completedAt=new Date().toISOString();
    saved=await withNativeTransaction(async client=>{
      await assertNativeExceptionAccess(client);const attempt=await resolveRetryAttempt(client,{...job,source});
      const result=await captureObservedEvent({token:dedupeKey,captureSource:'email',event:purchase,reconciliationAt:job.receivedAt});
      if(attempt)await completeRetryAttempt(client,attempt,result.eventId,completedAt);return result;
    });
  } catch (error) {
    if (error instanceof SourceClaimUnavailableError &&
      ['suppressed', 'unresolved_suppression'].includes(error.outcome)) {
      if (job.retryExceptionId) await markRetryFailed({...job,source},
        'La fuente conserva una supresión previa; no se creó un movimiento.');
      console.info(JSON.stringify({ message: 'Previously suppressed SES email ignored', dedupeKey }));
      return;
    }
    throw error;
  }
  if (saved.duplicate) {
    console.info(JSON.stringify({ message: 'Duplicate SES email ignored', dedupeKey }));
    return;
  }
  if (!saved.created) {
    console.info(JSON.stringify({ message: 'Email observation reconciled with an existing event', eventId: saved.eventId }));
    return;
  }
  try {
    await notifyObservedPurchaseByPush(purchase);
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
    retryRequestedAt: job.retryRequestedAt,
    institutionHint,
    primaryFailure,
  };
  await assertNativeExceptionAccess();
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

const markRetryFailed=async(job:IngestionJob,details:string):Promise<void>=>{
  const at=new Date().toISOString();await withNativeTransaction(async client=>{
    await assertNativeExceptionAccess(client);const attempt=await resolveRetryAttempt(client,job);if(attempt)await failRetryAttempt(client,attempt,details,at);
  });
};
type NewIngestionException=Pick<ReviewException,'receivedAt'|'institution'|'reason'|'details'|'source'>;
const saveException=async(exception:NewIngestionException,sourceToken:string,extractorVersion:string,job:IngestionJob):Promise<void>=>{
  const id=randomUUID(),createdAt=new Date().toISOString(),savedException={id,...exception,sourceToken};
  const created=await withNativeTransaction(async client=>{
    await assertNativeExceptionAccess(client);const attempt=await resolveRetryAttempt(client,{...job,source:exception.source});
    const inserted=await saveClaimedReviewException(client,savedException,extractorVersion,createdAt);
    if(attempt)await failRetryAttempt(client,attempt,exception.details,createdAt);return inserted;
  });
  if(!created){console.info(JSON.stringify({message:'Duplicate SES email exception ignored'}));return;}
  console.warn(JSON.stringify({message:'SES email needs review',exception:{reason:exception.reason,institution:exception.institution}}));
  try{await notifyIngestionException(savedException);}
  catch(error){console.error(JSON.stringify({message:'Unable to send ingestion-exception alert',exceptionId:id,error:errorMessage(error)}));}
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
  await assertNativeExceptionAccess();
  await ses.send(new SendEmailCommand({
    Source: addresses.source,
    Destination: { ToAddresses: [addresses.destination] },
    Message: {
      Subject: { Data: alert.subject },
      Body: { Text: { Data: alert.body } },
    },
  }));
};

const notifyObservedPurchaseByPush = async (purchase: {
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
