import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import { effectiveCategories, publicMerchantRule } from './read-model.js';

export const readCategoryRecordsDynamo = async (rules = false): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  for await (const page of paginateQuery({ client: database }, {
    TableName: tableName, ConsistentRead: true,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': rules ? 'CATEGORY_RULES' : 'CATEGORY_CATALOG', ':sk': rules ? 'RULE#' : 'CAT#' },
  })) items.push(...page.Items ?? []);
  // DynamoDB's ascending UTF-8 source-key order breaks equal-length pattern ties.
  return items;
};
export const listCategoriesDynamo = async () => effectiveCategories(await readCategoryRecordsDynamo());
export const listMerchantRulesDynamo = async () => (await readCategoryRecordsDynamo(true)).map(publicMerchantRule);
