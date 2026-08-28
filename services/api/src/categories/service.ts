import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_SPEND_CATEGORIES,
  isValidCategoryId,
  normalizeMerchantKey,
  resolveCategoryId,
  type MerchantCategoryRule,
  type SpendCategory,
} from '@finance/domain';
import { database, tableName } from '../http/clients.js';

const CATALOG_PK = 'CATEGORY_CATALOG';
const RULES_PK = 'CATEGORY_RULES';

export class InvalidCategoryError extends Error {}

type CatalogItem = SpendCategory & { entityType?: string };
type RuleItem = MerchantCategoryRule & { entityType?: string; PK?: string; SK?: string };

export const listCategories = async (): Promise<readonly SpendCategory[]> => {
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': CATALOG_PK, ':sk': 'CAT#' },
  }));
  const items = (result.Items ?? []) as CatalogItem[];
  const categories = new Map(DEFAULT_SPEND_CATEGORIES.map((category) => [category.id, category]));
  for (const item of items) {
    categories.set(item.id, {
      id: item.id,
      name: item.name,
      sortOrder: item.sortOrder,
    });
  }
  return [...categories.values()]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'es'));
};

export const listMerchantRules = async (): Promise<readonly MerchantCategoryRule[]> => {
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': RULES_PK, ':sk': 'RULE#' },
  }));
  return ((result.Items ?? []) as RuleItem[]).map((item) => ({
    id: item.id,
    merchantKey: item.merchantKey,
    pattern: item.pattern,
    categoryId: item.categoryId,
    source: item.source,
    updatedAt: item.updatedAt,
  }));
};

export const putCategoryCatalog = async (categories: readonly SpendCategory[]): Promise<readonly SpendCategory[]> => {
  for (const category of categories) {
    if (!isValidCategoryId(category.id)) {
      throw new InvalidCategoryError(`Categoría inválida: ${category.id}`);
    }
    if (!category.name.trim()) throw new InvalidCategoryError('El nombre de categoría es obligatorio.');
  }
  for (const category of categories) {
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: CATALOG_PK,
        SK: `CAT#${category.id}`,
        entityType: 'spend_category',
        id: category.id,
        name: category.name.trim(),
        sortOrder: category.sortOrder,
        GSI1PK: 'SPEND_CATEGORIES',
        GSI1SK: category.id,
      },
    }));
  }
  return listCategories();
};

export const upsertMerchantRule = async (input: {
  readonly merchantRaw: string;
  readonly categoryId: string;
  readonly pattern?: string;
  readonly source: MerchantCategoryRule['source'];
}): Promise<MerchantCategoryRule> => {
  if (!isValidCategoryId(input.categoryId) && input.categoryId !== '') {
    throw new InvalidCategoryError(`Categoría inválida: ${input.categoryId}`);
  }
  const merchantKey = normalizeMerchantKey(input.merchantRaw);
  if (!merchantKey) throw new InvalidCategoryError('Comercio vacío.');
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: RULES_PK, SK: `RULE#${merchantKey}` },
  }));
  const now = new Date().toISOString();
  const rule: MerchantCategoryRule = {
    id: typeof existing.Item?.id === 'string' ? existing.Item.id : randomUUID(),
    merchantKey,
    pattern: input.pattern ? normalizeMerchantKey(input.pattern) : undefined,
    categoryId: input.categoryId,
    source: input.source,
    updatedAt: now,
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: RULES_PK,
      SK: `RULE#${merchantKey}`,
      entityType: 'merchant_category_rule',
      ...rule,
      GSI1PK: 'CATEGORY_RULES',
      GSI1SK: merchantKey,
    },
  }));
  return rule;
};

export const resolveCategoryForMerchant = async (merchantRaw: string): Promise<string | undefined> => {
  const rules = await listMerchantRules();
  return resolveCategoryId(merchantRaw, rules);
};

export const ensureDefaultCatalog = async (): Promise<readonly SpendCategory[]> => {
  const existing = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': CATALOG_PK, ':sk': 'CAT#' },
    Limit: 1,
  }));
  if ((existing.Items?.length ?? 0) > 0) return listCategories();
  return putCategoryCatalog(DEFAULT_SPEND_CATEGORIES);
};

export const setEventCategory = async (
  eventId: string,
  changedBy: string,
  categoryId: string | null,
  options?: { readonly updateRule?: boolean; readonly source?: MerchantCategoryRule['source'] },
): Promise<Record<string, unknown> | undefined> => {
  if (categoryId !== null && !isValidCategoryId(categoryId)) {
    throw new InvalidCategoryError(`Categoría inválida: ${categoryId}`);
  }
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
  }));
  if (!existing.Item?.payload || typeof existing.Item.payload !== 'object') return undefined;
  const payload = existing.Item.payload as Record<string, unknown>;
  const previous = (payload.categoryId as string | null | undefined) ?? null;
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: categoryId === null
      ? 'REMOVE #payload.#categoryId'
      : 'SET #payload.#categoryId = :categoryId',
    ExpressionAttributeNames: { '#payload': 'payload', '#categoryId': 'categoryId' },
    ...(categoryId === null ? {} : { ExpressionAttributeValues: { ':categoryId': categoryId } }),
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: 'set_category',
    changes: {
      categoryId: { previous, next: categoryId },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `EVENT#${eventId}`,
      SK: `REVISION#${revision.createdAt}#${revision.id}`,
      entityType: 'event_revision',
      payload: revision,
    },
  }));
  if (options?.updateRule && categoryId && typeof payload.merchantRaw === 'string') {
    await upsertMerchantRule({
      merchantRaw: payload.merchantRaw,
      categoryId,
      source: options.source ?? 'human',
    });
  }
  const nextPayload = updated.Attributes?.payload as Record<string, unknown>;
  return {
    ...nextPayload,
    categoryId: (nextPayload.categoryId as string | undefined) ?? null,
  };
};
