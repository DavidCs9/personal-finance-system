import { applicationStoreClient, withNativeTransaction } from '@finance/ledger/dsql-store';
import { randomUUID } from 'node:crypto';
import { insertLedgerRevision, readLedgerMovements, setMovementCategory } from '@finance/ledger/native-ledger';
import {
  isValidCategoryId,
  resolveCategoryId,
  type MerchantCategoryRule,
  type SpendCategory,
} from '@finance/domain';
import { listCategories, listMerchantRules } from './sql-reads.js';
import { saveMerchantRule } from './merchant-rules.js';
import { InvalidCategoryError, requireCatalogCategories, saveCategoryCatalog } from './catalog.js';

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
  const payload = (await readLedgerMovements(applicationStoreClient(), { ids: [eventId] }))[0];
  if (!payload) return undefined;
  const previous = (payload.categoryId as string | null | undefined) ?? null;
  await setMovementCategory(applicationStoreClient(), eventId, categoryId);
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
  await insertLedgerRevision(applicationStoreClient(), { ...revision, movementId: eventId });
  if (options?.updateRule && categoryId && typeof payload.merchantRaw === 'string') {
    await upsertMerchantRule({
      merchantRaw: payload.merchantRaw,
      categoryId,
      source: options.source ?? 'human',
    });
  }
  const nextPayload = (await readLedgerMovements(applicationStoreClient(), { ids: [eventId] }))[0];
  return {
    ...nextPayload,
    categoryId: (nextPayload.categoryId as string | undefined) ?? null,
  };
};

export const putCategoryCatalog = (...args:Parameters<typeof putCategoryCatalogInternal>):ReturnType<typeof putCategoryCatalogInternal> => withNativeTransaction(()=>putCategoryCatalogInternal(...args));

export const upsertMerchantRule = (...args:Parameters<typeof upsertMerchantRuleInternal>):ReturnType<typeof upsertMerchantRuleInternal> => withNativeTransaction(()=>upsertMerchantRuleInternal(...args));

// Retained API name; a catalog read never seeds or mutates data.
export const ensureDefaultCatalog = listCategories;

export const setEventCategory = (...args:Parameters<typeof setEventCategoryInternal>):ReturnType<typeof setEventCategoryInternal> => withNativeTransaction(()=>setEventCategoryInternal(...args));
