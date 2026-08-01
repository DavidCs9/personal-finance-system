import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

interface SesReceiptRecord {
  readonly ses: {
    readonly mail: {
      readonly messageId: string;
      readonly timestamp: string;
      readonly commonHeaders?: { readonly messageId?: string };
    };
  };
}

interface SesReceiptEvent {
  readonly Records: readonly SesReceiptRecord[];
}

/**
 * SES writes MIME to S3 first. This handler sends only that immutable pointer
 * to SQS, so the downstream parser never receives a raw email in a queue body.
 */
export const handler = async (event: SesReceiptEvent): Promise<void> => {
  const bucket = requiredEnvironment('RAW_EMAIL_BUCKET_NAME');
  const prefix = requiredEnvironment('RAW_EMAIL_PREFIX');
  const queueUrl = requiredEnvironment('INGESTION_QUEUE_URL');

  await Promise.all(event.Records.map(async (record) => {
    const messageId = record.ses.mail.messageId;
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        receivedAt: record.ses.mail.timestamp,
        sourceMessageId: record.ses.mail.commonHeaders?.messageId,
        source: { bucket, key: `${prefix}${messageId}` },
      }),
    }));
  }));
};

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
