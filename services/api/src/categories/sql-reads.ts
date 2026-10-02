import type { LedgerReadMode } from '../events/read-selection.js';
import { readMerchantRules } from './merchant-rules.js';
import { readCategoryCatalog } from './catalog.js';
export { categoryReadStatement } from './catalog.js';

export const domainReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_DOMAIN_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};
export { ruleReadStatement } from './merchant-rules.js';
export const readSqlCategories = readCategoryCatalog;
export const readSqlMerchantRules = readMerchantRules;
export const listCategories = readCategoryCatalog;
export const listMerchantRules = readMerchantRules;
