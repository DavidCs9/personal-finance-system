import { withApplicationTransaction } from '@finance/ledger/dsql-store';
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  isValidCategoryId,
  resolveCategoryId,
  type MerchantCategoryRule,
  type SpendCategory,
} from '@finance/domain';
import { listCategories, listMerchantRules } from './sql-reads.js';
import { saveMerchantRule } from './merchant-rules.js';
import { InvalidCategoryError, requireCatalogCategories, saveCategoryCatalog } from './catalog.js';
import { database, tableName } from '../http/clients.js';

export { InvalidCategoryError };

export { listCategories, listMerchantRules } from './sql-reads.js';

const putCategoryCatalogInternal = async (categories: readonly SpendCategory[]): Promise<readonly SpendCategory[]> => {
  await saveCategoryCatalog(categories);
  return listCategories();
};

const upsertMerchantRuleInternal = saveMerchantRule;

export const resolveCategoryForMerchant = async (merchantRaw: string): Promise<string | undefined> => {
  const rules = await listMerchantRules();
  return resolveCategoryId(merchantRaw, rules);
};


const setEventCategoryInternal = async (
  eventId: string,
  changedBy: string,
  categoryId: string | null,
  options?: { readonly updateRule?: boolean; readonly source?: MerchantCategoryRule['source'] },
): Promise<Record<string, unknown> | undefined> => {
  if (categoryId !== null && !isValidCategoryId(categoryId)) {
    throw new InvalidCategoryError(`Categoría inválida: ${categoryId}`);
  }
  await requireCatalogCategories([categoryId]);
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

export const putCategoryCatalog = (...args:Parameters<typeof putCategoryCatalogInternal>):ReturnType<typeof putCategoryCatalogInternal> => withApplicationTransaction(()=>putCategoryCatalogInternal(...args));

export const upsertMerchantRule = (...args:Parameters<typeof upsertMerchantRuleInternal>):ReturnType<typeof upsertMerchantRuleInternal> => withApplicationTransaction(()=>upsertMerchantRuleInternal(...args));

// Retained API name; a catalog read never seeds or mutates data.
export const ensureDefaultCatalog = listCategories;

export const setEventCategory = (...args:Parameters<typeof setEventCategoryInternal>):ReturnType<typeof setEventCategoryInternal> => withApplicationTransaction(()=>setEventCategoryInternal(...args));
