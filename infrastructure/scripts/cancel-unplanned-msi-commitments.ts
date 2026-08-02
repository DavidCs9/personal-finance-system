/**
 * Cancel invented committed installments on statement_unplanned / incomplete MSI stubs.
 *
 * Usage (from infrastructure/):
 *   METADATA_TABLE_NAME=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/cancel-unplanned-msi-commitments.ts [--dry-run]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancelRemainingInstallments, type MsiPlan } from '@finance/domain';

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
  payload?: {
    id?: string;
    merchantRaw?: string;
    msi?: MsiPlan;
  };
};

const isIncompleteStub = (plan: MsiPlan | undefined): plan is MsiPlan =>
  Boolean(
    plan
    && (plan.needsScheduleCompletion || plan.origin === 'statement_unplanned')
    && plan.installments.some((item) => item.status === 'committed'),
  );

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
      if (!item.PK || item.SK !== 'EVENT' || !isIncompleteStub(plan)) {
        skipped += 1;
        continue;
      }
      const next = cancelRemainingInstallments(plan);
      const eventId = item.payload?.id ?? item.PK.slice('EVENT#'.length);
      console.log(
        `${dryRun ? '[dry-run] ' : ''}cancel commitments ${eventId} (${item.payload?.merchantRaw ?? '?'}) `
        + `${plan.installments.filter((i) => i.status === 'committed').length} → 0 committed`,
      );
      if (!dryRun) {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: 'EVENT' },
          UpdateExpression: 'SET #payload.#msi = :msi',
          ExpressionAttributeNames: { '#payload': 'payload', '#msi': 'msi' },
          ExpressionAttributeValues: { ':msi': next },
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
