import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import { publicMerchantRule } from './read-model.js';

export const readMerchantRuleRecords = async (): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  for await (const page of paginateQuery({ client: database }, {
    TableName: tableName, ConsistentRead: true,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': 'CATEGORY_RULES', ':sk': 'RULE#' },
  })) items.push(...page.Items ?? []);
  // DynamoDB's ascending UTF-8 source-key order breaks equal-length pattern ties.
  return items;
};
export const listMerchantRulesDynamo = async () => (await readMerchantRuleRecords()).map(publicMerchantRule);
