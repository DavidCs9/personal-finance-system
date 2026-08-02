/**
 * One-shot backfill: set GSI3PK / GSI3SK / spendMonth on existing EVENT items.
 *
 * Usage (from infrastructure/):
 *   METADATA_TABLE_NAME=... AWS_PROFILE=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/backfill-event-month-gsi.ts [--dry-run]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { eventMonthIndexKeys } from '../lambda/event-month-index.js';

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) {
  console.error('METADATA_TABLE_NAME is required');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type EventItem = {
  PK?: string;
  SK?: string;
  GSI3PK?: string;
  GSI3SK?: string;
  payload?: {
    id?: string;
    occurredAt?: string;
    receivedAt?: string;
  };
};

const main = async () => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': 'EVENTS' },
      ExclusiveStartKey: exclusiveStartKey,
    }));

    for (const item of (result.Items ?? []) as EventItem[]) {
      scanned += 1;
      const payload = item.payload;
      const eventId = typeof payload?.id === 'string'
        ? payload.id
        : typeof item.PK === 'string' && item.PK.startsWith('EVENT#')
          ? item.PK.slice('EVENT#'.length)
          : undefined;
      const receivedAt = typeof payload?.receivedAt === 'string' ? payload.receivedAt : undefined;
      if (!eventId || !receivedAt || item.SK !== 'EVENT' || !item.PK) {
        skipped += 1;
        continue;
      }
      const keys = eventMonthIndexKeys({
        eventId,
        occurredAt: typeof payload?.occurredAt === 'string' ? payload.occurredAt : undefined,
        receivedAt,
      });
      if (item.GSI3PK === keys.GSI3PK && item.GSI3SK === keys.GSI3SK) {
        skipped += 1;
        continue;
      }
      console.log(`${dryRun ? '[dry-run] ' : ''}update ${eventId} → ${keys.GSI3PK} / ${keys.GSI3SK}`);
      if (!dryRun) {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: 'EVENT' },
          UpdateExpression: 'SET GSI3PK = :pk, GSI3SK = :sk, spendMonth = :month',
          ExpressionAttributeValues: {
            ':pk': keys.GSI3PK,
            ':sk': keys.GSI3SK,
            ':month': keys.spendMonth,
          },
        }));
      }
      updated += 1;
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  console.log(JSON.stringify({ scanned, updated, skipped, dryRun }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
