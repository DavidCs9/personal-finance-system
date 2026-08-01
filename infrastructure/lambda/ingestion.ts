import type { SQSHandler } from 'aws-lambda';

/**
 * Placeholder for raw-email persistence, exact-message deduplication, parsing,
 * metadata writes, and SES notification delivery.
 */
export const handler: SQSHandler = async (event) => {
  console.info(JSON.stringify({ message: 'Ingestion placeholder invoked', records: event.Records.length }));
};
