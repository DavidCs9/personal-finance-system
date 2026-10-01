import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead, type LedgerReadMode } from '../events/read-selection.js';
import { publicMerchantRule } from './read-model.js';
import { listCategoriesDynamo, listMerchantRulesDynamo } from './source-reads.js';

export const domainReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_DOMAIN_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};
export const categoryReadStatement = "SELECT payload FROM olbia.categories WHERE source_pk='CATEGORY_CATALOG' AND source_sk >= 'CAT#' AND source_sk < 'CAT$' ORDER BY source_sk COLLATE \"C\"";
export const ruleReadStatement = "SELECT payload FROM olbia.merchant_category_rules WHERE source_pk='CATEGORY_RULES' AND source_sk >= 'RULE#' AND source_sk < 'RULE$' ORDER BY source_sk COLLATE \"C\"";
export const readSqlCategories = async (client: ReadSqlClient = readerPool()) => {
  const rows = (await client.query(categoryReadStatement)).rows;
  // Do not refill missing default rows here: the independent gate must detect an incomplete projection.
  return rows.map(row => row.payload as Record<string, unknown>).map(item => ({
    id: item.id as string, name: item.name as string, sortOrder: item.sortOrder as number,
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));
};
export const readSqlMerchantRules = async (client: ReadSqlClient = readerPool()) =>
  (await client.query(ruleReadStatement)).rows.map(row => publicMerchantRule(row.payload as Record<string, unknown>));
export const listCategories = () => {
  const mode = domainReadMode();
  return selectLedgerRead({ mode, sql: () => readSqlCategories(), source: listCategoriesDynamo,
    report: (outcome, selected) => observe('categories', mode, outcome, selected) });
};
export const listMerchantRules = () => {
  const mode = domainReadMode();
  return selectLedgerRead({ mode, sql: () => readSqlMerchantRules(), source: listMerchantRulesDynamo,
    report: (outcome, selected) => observe('merchant-rules', mode, outcome, selected) });
};
