import { randomUUID } from 'node:crypto';
import { normalizeMerchantKey, type MerchantCategoryRule } from '@finance/domain';
import { applicationSqlClient } from '@finance/ledger/sql-runtime';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { InvalidCategoryError, requireCatalogCategories } from './catalog.js';

export const ruleReadStatement = 'SELECT merchant_key,id,pattern,category_id,source,updated_at FROM olbia.merchant_rules ORDER BY merchant_key COLLATE "C"';
const toRule = (row: Record<string, unknown>): MerchantCategoryRule => ({
  id: row.id as string, merchantKey: row.merchant_key as string,
  pattern: (row.pattern as string | null) ?? undefined, categoryId: (row.category_id as string | null) ?? '',
  source: row.source as MerchantCategoryRule['source'], updatedAt: new Date(row.updated_at as string | Date).toISOString(),
});
export const readMerchantRules = async (client: ReadSqlClient = readerPool()): Promise<readonly MerchantCategoryRule[]> =>
  (await client.query(ruleReadStatement)).rows.map(toRule);

/** Caller owns the category domain transaction. IDs survive merchant-key upserts. */
export const saveMerchantRule = async (input: {
  readonly merchantRaw: string; readonly categoryId: string; readonly pattern?: string;
  readonly source: MerchantCategoryRule['source'];
}): Promise<MerchantCategoryRule> => {
  await requireCatalogCategories([input.categoryId === '' ? null : input.categoryId]);
  const merchantKey = normalizeMerchantKey(input.merchantRaw);
  if (!merchantKey) throw new InvalidCategoryError('Comercio vacío.');
  if (!['seed', 'human', 'llm_residual', 'agent_confirmed'].includes(input.source)) throw new InvalidCategoryError('Origen de regla inválido.');
  const rows = (await applicationSqlClient().query(`INSERT INTO olbia.merchant_rules
    (merchant_key,id,pattern,category_id,source,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (merchant_key) DO UPDATE SET pattern=EXCLUDED.pattern,category_id=EXCLUDED.category_id,
      source=EXCLUDED.source,updated_at=EXCLUDED.updated_at RETURNING merchant_key,id,pattern,category_id,source,updated_at`,
  [merchantKey, randomUUID(), input.pattern ? normalizeMerchantKey(input.pattern) || null : null,
    input.categoryId || null, input.source, new Date().toISOString()])).rows;
  return toRule(rows[0]);
};
