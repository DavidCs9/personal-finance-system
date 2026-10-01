import { DEFAULT_SPEND_CATEGORIES, type SpendCategory, type MerchantCategoryRule } from '@finance/domain';

export const effectiveCategories = (items: readonly Record<string, unknown>[]): readonly SpendCategory[] => {
  const categories = new Map(DEFAULT_SPEND_CATEGORIES.map(category => [category.id, category]));
  for (const item of items) categories.set(String(item.id), {
    id: item.id as string, name: item.name as string, sortOrder: item.sortOrder as number,
  });
  return [...categories.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));
};
export const publicMerchantRule = (item: Record<string, unknown>): MerchantCategoryRule => ({
  id: item.id as string, merchantKey: item.merchantKey as string, pattern: item.pattern as string | undefined,
  categoryId: item.categoryId as string, source: item.source as MerchantCategoryRule['source'], updatedAt: item.updatedAt as string,
});
