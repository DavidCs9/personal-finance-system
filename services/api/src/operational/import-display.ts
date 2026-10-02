// Frozen pre-cutover display oracle; live import readers use native typed relations.
import type { StatementPreviewRow } from '../imports/statement-reconciliation.js';
import { statementPreviewResponse } from '../imports/statement-shared.js';
import type { JsonObject } from '../http/response.js';

export const terminalImportDisplay = (importId: string, provider: 'AMEX' | 'SANTANDER_STATEMENT', item?: JsonObject): JsonObject | undefined => {
  if (!item || (item.status !== 'previewed' && item.status !== 'applied')) return undefined;
  return statementPreviewResponse(importId, { accountLastFour: String(item.accountLastFour ?? ''),
    product: String(item.product ?? (provider === 'AMEX' ? 'American Express' : 'Santander')),
    period: item.period as { from: string; to: string } }, Array.isArray(item.rows) ? item.rows as readonly StatementPreviewRow[] : []);
};
