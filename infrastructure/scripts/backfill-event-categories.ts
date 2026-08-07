/**
 * Backfill categoryId on events using persisted merchant rules (+ heuristic residual).
 *
 * Usage (from infrastructure/):
 *   METADATA_TABLE_NAME=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/backfill-event-categories.ts [--dry-run] [--llm-residual-heuristic]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  normalizeMerchantKey,
  resolveCategoryId,
  suggestCategoryIdFromMerchant,
  type MerchantCategoryRule,
} from '@finance/domain';

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) {
  console.error('METADATA_TABLE_NAME is required');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const useHeuristic = process.argv.includes('--llm-residual-heuristic');
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const loadRules = async (): Promise<readonly MerchantCategoryRule[]> => {
  const rules: MerchantCategoryRule[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'CATEGORY_RULES', ':sk': 'RULE#' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) {
      rules.push({
        id: String(item.id),
        merchantKey: String(item.merchantKey),
        pattern: typeof item.pattern === 'string' ? item.pattern : undefined,
        categoryId: String(item.categoryId),
        source: item.source as MerchantCategoryRule['source'],
        updatedAt: String(item.updatedAt),
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return rules;
};

const main = async () => {
  const rules = await loadRules();
  console.log(`Loaded ${rules.length} rules.`);
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
    for (const item of result.Items ?? []) {
      if (item.SK !== 'EVENT' || !item.PK) continue;
      scanned += 1;
      const payload = item.payload as { categoryId?: string | null; merchantRaw?: string } | undefined;
      if (payload?.categoryId) {
        skipped += 1;
        continue;
      }
      const merchantRaw = payload?.merchantRaw;
      if (!merchantRaw) {
        skipped += 1;
        continue;
      }
      let categoryId = resolveCategoryId(merchantRaw, rules);
      if (!categoryId && useHeuristic) {
        categoryId = suggestCategoryIdFromMerchant(merchantRaw);
      }
      if (!categoryId) {
        skipped += 1;
        continue;
      }
      console.log(`${dryRun ? '[dry-run] ' : ''}${normalizeMerchantKey(merchantRaw)} → ${categoryId}`);
      if (!dryRun) {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: 'EVENT' },
          UpdateExpression: 'SET #payload.#categoryId = :categoryId',
          ExpressionAttributeNames: { '#payload': 'payload', '#categoryId': 'categoryId' },
          ExpressionAttributeValues: { ':categoryId': categoryId },
        }));
      }
      updated += 1;
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  console.log(`Scanned ${scanned}; updated ${updated}; skipped ${skipped}.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
