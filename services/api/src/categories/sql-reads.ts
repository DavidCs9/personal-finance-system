import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead, type LedgerReadMode } from '../events/read-selection.js';
import { publicMerchantRule } from './read-model.js';
import { listMerchantRulesDynamo } from './source-reads.js';
import { readCategoryCatalog } from './catalog.js';
export { categoryReadStatement } from './catalog.js';

export const domainReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_DOMAIN_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};
export const ruleReadStatement = "SELECT payload FROM olbia.merchant_category_rules WHERE source_pk='CATEGORY_RULES' AND source_sk >= 'RULE#' AND source_sk < 'RULE$' ORDER BY source_sk COLLATE \"C\"";
export const readSqlCategories = readCategoryCatalog;
export const readSqlMerchantRules = async (client: ReadSqlClient = readerPool()) =>
  (await client.query(ruleReadStatement)).rows.map(row => publicMerchantRule(row.payload as Record<string, unknown>));
export const listCategories = readCategoryCatalog;
export const listMerchantRules = () => {
  const mode = domainReadMode();
  return selectLedgerRead({ mode, sql: () => readSqlMerchantRules(), source: listMerchantRulesDynamo,
    report: (outcome, selected) => observe('merchant-rules', mode, outcome, selected) });
};
