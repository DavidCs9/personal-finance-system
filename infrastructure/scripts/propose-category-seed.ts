/**
 * Propose category catalog + merchant→category rules from historical merchants.
 *
 * Usage (from infrastructure/):
 *   METADATA_TABLE_NAME=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/propose-category-seed.ts [--apply] [--categorize-events]
 *
 * Default is dry-run (prints proposal only).
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_SPEND_CATEGORIES,
  normalizeMerchantKey,
  suggestCategoryIdFromMerchant,
} from '@finance/domain';

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) {
  console.error('METADATA_TABLE_NAME is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const categorizeEvents = process.argv.includes('--categorize-events');
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type EventItem = {
  PK?: string;
  SK?: string;
  payload?: {
    id?: string;
    merchantRaw?: string;
    categoryId?: string | null;
  };
};

const main = async () => {
  const merchantCounts = new Map<string, { raw: string; count: number; suggestion?: string }>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let scanned = 0;

  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': 'EVENTS' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of (result.Items ?? []) as EventItem[]) {
      if (item.SK !== 'EVENT') continue;
      scanned += 1;
      const raw = item.payload?.merchantRaw;
      if (!raw) continue;
      const key = normalizeMerchantKey(raw);
      if (!key) continue;
      const existing = merchantCounts.get(key);
      const suggestion = suggestCategoryIdFromMerchant(raw);
      if (existing) {
        existing.count += 1;
      } else {
        merchantCounts.set(key, { raw, count: 1, suggestion });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  const proposals = [...merchantCounts.entries()]
    .map(([merchantKey, value]) => ({ merchantKey, ...value }))
    .sort((left, right) => right.count - left.count);

  console.log(`Scanned ${scanned} events; ${proposals.length} distinct merchants.`);
  console.log('Catalog:');
  for (const category of DEFAULT_SPEND_CATEGORIES) {
    console.log(`  - ${category.id}: ${category.name}`);
  }
  console.log('Proposed rules (top 80):');
  for (const proposal of proposals.slice(0, 80)) {
    console.log(
      `  ${proposal.count}× ${proposal.raw} → ${proposal.suggestion ?? '(residual/LLM)'}`,
    );
  }

  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write catalog + rules.');
    return;
  }

  for (const category of DEFAULT_SPEND_CATEGORIES) {
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: 'CATEGORY_CATALOG',
        SK: `CAT#${category.id}`,
        entityType: 'spend_category',
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        GSI1PK: 'SPEND_CATEGORIES',
        GSI1SK: category.id,
      },
    }));
  }

  let rulesWritten = 0;
  for (const proposal of proposals) {
    if (!proposal.suggestion) continue;
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: 'CATEGORY_RULES',
        SK: `RULE#${proposal.merchantKey}`,
        entityType: 'merchant_category_rule',
        id: randomUUID(),
        merchantKey: proposal.merchantKey,
        categoryId: proposal.suggestion,
        source: 'seed',
        updatedAt: new Date().toISOString(),
        GSI1PK: 'CATEGORY_RULES',
        GSI1SK: proposal.merchantKey,
      },
    }));
    rulesWritten += 1;
  }
  console.log(`Wrote catalog (${DEFAULT_SPEND_CATEGORIES.length}) and ${rulesWritten} rules.`);

  if (!categorizeEvents) {
    console.log('Skip event updates (pass --categorize-events to patch events).');
    return;
  }

  exclusiveStartKey = undefined;
  let updated = 0;
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': 'EVENTS' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of (result.Items ?? []) as EventItem[]) {
      if (item.SK !== 'EVENT' || !item.PK) continue;
      if (item.payload?.categoryId) continue;
      const raw = item.payload?.merchantRaw;
      if (!raw) continue;
      const key = normalizeMerchantKey(raw);
      const suggestion = merchantCounts.get(key)?.suggestion;
      if (!suggestion) continue;
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: item.PK, SK: 'EVENT' },
        UpdateExpression: 'SET #payload.#categoryId = :categoryId',
        ExpressionAttributeNames: { '#payload': 'payload', '#categoryId': 'categoryId' },
        ExpressionAttributeValues: { ':categoryId': suggestion },
      }));
      updated += 1;
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  console.log(`Updated categoryId on ${updated} events.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
