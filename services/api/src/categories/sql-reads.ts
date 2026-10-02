import { readMerchantRules } from './merchant-rules.js';
import { readCategoryCatalog } from './catalog.js';
export { categoryReadStatement } from './catalog.js';

export { ruleReadStatement } from './merchant-rules.js';
export const readSqlCategories = readCategoryCatalog;
export const readSqlMerchantRules = readMerchantRules;
export const listCategories = readCategoryCatalog;
export const listMerchantRules = readMerchantRules;
