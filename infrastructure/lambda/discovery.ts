/**
 * Placeholder for the Gmail incremental-history poller.
 *
 * It will read the OAuth configuration from Secrets Manager, list messages since
 * the stored Gmail history cursor, and send one message identifier per SQS job.
 */
export const handler = async (): Promise<void> => {
  console.info(JSON.stringify({ message: 'Gmail discovery placeholder invoked' }));
};
