import type { MerchantCategoryRule } from '@finance/domain';
export const publicMerchantRule = (item: Record<string, unknown>): MerchantCategoryRule => ({
  id: item.id as string, merchantKey: item.merchantKey as string, pattern: item.pattern as string | undefined,
  categoryId: item.categoryId as string, source: item.source as MerchantCategoryRule['source'], updatedAt: item.updatedAt as string,
});
