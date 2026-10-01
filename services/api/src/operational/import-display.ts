import { readOperationalItem } from './reads.js';
import { database, tableName } from '../http/clients.js';
import type { StatementPreviewRow } from '../imports/statement-reconciliation.js';
import { statementPreviewResponse } from '../imports/statement-shared.js';
import type { JsonObject } from '../http/response.js';

export const terminalImportDisplay = (importId: string, provider: 'AMEX' | 'SANTANDER_STATEMENT', item?: JsonObject): JsonObject | undefined => {
  if (!item || (item.status !== 'previewed' && item.status !== 'applied')) return undefined;
  return statementPreviewResponse(importId, { accountLastFour: String(item.accountLastFour ?? ''),
    product: String(item.product ?? (provider === 'AMEX' ? 'American Express' : 'Santander')),
    period: item.period as { from: string; to: string } }, Array.isArray(item.rows) ? item.rows as readonly StatementPreviewRow[] : []);
};
// Called only after a source-only GET establishes a terminal display branch.
// If a concurrent source re-upload restarts processing, the caller rereads its authoritative workflow.
export const readTerminalImportDisplay = async (owner: string, importId: string, provider: 'AMEX' | 'SANTANDER_STATEMENT') =>
  terminalImportDisplay(importId, provider, await readOperationalItem('import_records', { database, tableName }, `USER#${owner}`, `IMPORT#${provider}#${importId}`));
