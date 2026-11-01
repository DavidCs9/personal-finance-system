import { readLedgerMovements, isLedgerMovementId } from '@finance/ledger/native-ledger';
import { readBulkOperation } from '../events/bulk-storage.js';
import { readerPool, withLedgerReadSnapshot } from '../events/sql-reads.js';
import { readAgentCatalogOperation } from '../categories/control-plane.js';
import { InvalidAgentQueryError } from './aggregates.js';

/** Inspect committed state without repeating a preview, apply or catalog write. */
export const editOperationStatus = async (owner: string, operationId: unknown, now = Date.now()) => {
  if (typeof operationId !== 'string' || !isLedgerMovementId(operationId)) {
    throw new InvalidAgentQueryError('Usa el operationId exacto del preview o cambio de catálogo.');
  }
  return withLedgerReadSnapshot(async () => {
    const client = readerPool();
    const operation = await readBulkOperation(owner, operationId, client);
    if (!operation) {
      const catalog = await readAgentCatalogOperation(owner, operationId, client);
      return catalog ?? { ok: false, status: 'not_found', operationId,
        message: 'No hay un recibo de esta operación. No demuestra que una solicitud distinta haya fallado; consulta el estado actual.' };
    }
    const current = await readLedgerMovements(client, { ids: operation.events.map(event => event.id) });
    const category = Object.hasOwn(operation.change, 'categoryId');
    const tagsChanged = Object.hasOwn(operation.change, 'addTags') || Object.hasOwn(operation.change, 'removeTags');
    const applied = operation.status === 'applied';
    const changedMovementIds = operation.events.filter(event => {
      const row = current.find(row => row.id === event.id);
      if (!row || row.status !== 'accepted') return true;
      if (category && (row.categoryId ?? null) !== (applied ? event.nextCategoryId : event.previousCategoryId)) return true;
      const tags = Array.isArray(row.tags) ? row.tags.map(String).sort() : [];
      return tagsChanged && JSON.stringify(tags) !== JSON.stringify([...(applied ? event.nextTags : event.previousTags)].sort());
    }).map(event => event.id);
    return { ok: true, operationId, kind: category && tagsChanged ? 'mixed_edit' : category ? 'category_edit' : 'tag_edit',
      status: operation.status, change: operation.change, movementCount: operation.events.length,
      amountMinor: operation.amountMinor, appliedAt: operation.appliedAt ?? null, undoneAt: operation.undoneAt ?? null,
      expired: operation.status === 'pending' && operation.expiresAt * 1000 <= now,
      comparisonScope: 'classification_values_modified_by_operation',
      currentStateMatchesReceipt: changedMovementIds.length === 0, changedMovementIds };
  });
};
