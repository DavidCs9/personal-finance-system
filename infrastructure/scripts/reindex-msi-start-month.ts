/**
 * Re-anchor MSI events so GSI3 / occurredAt sit on cuota 1's month.
 * Fixes plans opened from mid-plan statement evidence (2/n, 3/n, …).
 *
 * Usage (from infrastructure/):
 *   METADATA_TABLE_NAME=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/reindex-msi-start-month.ts [--dry-run]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MsiPlan } from '@finance/domain';
import { eventMonthIndexKeys, msiPlanPurchaseOccurredAt } from '../lambda/event-month-index.js';

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
  payload?: {
    id?: string;
    merchantRaw?: string;
    occurredAt?: string;
    receivedAt?: string;
    msi?: MsiPlan;
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
      const plan = item.payload?.msi;
      const startMonth = plan?.installments?.[0]?.month;
      const occurredAt = item.payload?.occurredAt;
      if (!item.PK || item.SK !== 'EVENT' || !plan || !startMonth || !occurredAt) {
        skipped += 1;
        continue;
      }
      const evidenceOn = occurredAt.slice(0, 10);
      const nextOccurredAt = msiPlanPurchaseOccurredAt(evidenceOn, startMonth);
      if (nextOccurredAt === occurredAt && item.GSI3PK === `MONTH#${startMonth}`) {
        skipped += 1;
        continue;
      }
      const eventId = item.payload?.id ?? item.PK.slice('EVENT#'.length);
      const receivedAt = item.payload?.receivedAt ?? occurredAt;
      const indexKeys = eventMonthIndexKeys({ eventId, occurredAt: nextOccurredAt, receivedAt });
      console.log(
        `${dryRun ? '[dry-run] ' : ''}reindex ${eventId} (${item.payload?.merchantRaw ?? '?'}) `
        + `${occurredAt.slice(0, 10)} / ${item.GSI3PK} → ${nextOccurredAt.slice(0, 10)} / ${indexKeys.GSI3PK}`,
      );
      if (!dryRun) {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: 'EVENT' },
          UpdateExpression: 'SET #payload.#occurredAt = :occurredAt, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, GSI2SK = :gsi2sk, reconciliationAt = :occurredAt',
          ExpressionAttributeNames: {
            '#payload': 'payload',
            '#occurredAt': 'occurredAt',
          },
          ExpressionAttributeValues: {
            ':occurredAt': nextOccurredAt,
            ':gsi3pk': indexKeys.GSI3PK,
            ':gsi3sk': indexKeys.GSI3SK,
            ':gsi2sk': `${nextOccurredAt}#${eventId}`,
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
