import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSHandler } from 'aws-lambda';
import { BEDROCK_EMAIL_EXTRACTOR_VERSION, extractEmailWithBedrock } from './bedrock-extractor.js';
import { normalizeEmail } from './email.js';
import type { BedrockFallbackJob, IngestionJob } from './jobs.js';
import type { BedrockEmailExtraction } from './bedrock-extractor.js';

const s3 = new S3Client({ region: process.env.AWS_REGION, maxAttempts: 5, retryMode: 'adaptive' });
const sqs = new SQSClient({ region: process.env.AWS_REGION, maxAttempts: 5, retryMode: 'adaptive' });
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION, maxAttempts: 5, retryMode: 'adaptive' });

export const bedrockFallbackHandler: SQSHandler = async (event) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let job: BedrockFallbackJob | undefined;
    try {
      job = JSON.parse(record.body) as BedrockFallbackJob;
      const object = await s3.send(new GetObjectCommand({ Bucket: job.source.bucket, Key: job.source.key }));
      if (!object.Body) throw new Error('Raw email object did not contain a body.');
      const email = await normalizeEmail(await object.Body.transformToString());
      const result = await extractEmailWithBedrock(email, job.institutionHint, bedrock);
      await returnToIngestion(job, result);
      console.info(JSON.stringify({
        message: 'Bedrock email extraction completed',
        sourceKey: job.source.key,
        institution: job.institutionHint,
        extractorVersion: BEDROCK_EMAIL_EXTRACTOR_VERSION,
      }));
    } catch (error) {
      const attempt = Number(record.attributes.ApproximateReceiveCount ?? 1);
      const retryable = isRetryableBedrockError(error);
      if (job && (!retryable || attempt >= 3)) {
        try {
          await returnToIngestion(job, rejectedExtraction(error));
          console.warn(JSON.stringify({
            message: 'Bedrock extraction exhausted and was returned for review',
            institution: job.institutionHint,
            attempt,
            errorName: errorName(error),
          }));
          continue;
        } catch (returnError) {
          console.error(JSON.stringify({
            message: 'Unable to return exhausted Bedrock extraction to ingestion',
            errorName: errorName(returnError),
          }));
        }
      }
      console.error(JSON.stringify({
        message: 'Unable to extract email with Bedrock',
        attempt,
        retryable,
        errorName: errorName(error),
      }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

const returnToIngestion = async (job: BedrockFallbackJob, result: BedrockEmailExtraction): Promise<void> => {
  const nextJob: IngestionJob = {
    receivedAt: job.receivedAt,
    sourceMessageId: job.sourceMessageId,
    source: job.source,
    retryExceptionId: job.retryExceptionId,
    bedrockExtraction: {
      version: BEDROCK_EMAIL_EXTRACTOR_VERSION,
      institutionHint: job.institutionHint,
      primaryFailure: job.primaryFailure,
      result,
    },
  };
  await sqs.send(new SendMessageCommand({
    QueueUrl: requiredEnvironment('INGESTION_QUEUE_URL'),
    MessageBody: JSON.stringify(nextJob),
  }));
};

const rejectedExtraction = (error: unknown): BedrockEmailExtraction => ({
  recognized: false,
  institution: null,
  eventType: null,
  completed: null,
  amountMinor: null,
  currency: null,
  merchantRaw: null,
  accountLastFour: null,
  counterparty: null,
  transferType: null,
  reference: null,
  folio: null,
  trackingKey: null,
  counterpartyInstitution: null,
  counterpartyAccountLastFour: null,
  billingPeriod: null,
  paymentMethodLastFour: null,
  occurredAt: null,
  rejectionReason: `Bedrock ${errorName(error)} after fallback extraction.`,
  evidence: { amount: null, merchantOrCounterparty: null, status: null, occurredDate: null, occurredTime: null, account: null },
});

const isRetryableBedrockError = (error: unknown): boolean =>
  ['ThrottlingException', 'ModelTimeoutException', 'ServiceUnavailableException', 'InternalServerException']
    .includes(errorName(error));

const errorName = (error: unknown): string => error instanceof Error ? error.name : 'UnknownError';

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
