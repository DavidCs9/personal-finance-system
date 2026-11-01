import { readLedgerMovementIdsByPrefix } from '@finance/ledger/native-ledger';
import { applicationSqlClient } from '@finance/ledger/sql-runtime';
import { InvalidBulkEditError } from '../events/bulk-edits.js';

/** References only resolve SQL identities; the existing preview still freezes and validates every row. */
export const resolveMovementReferences = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (input.eventRefs === undefined) return input;
  if (input.eventId !== undefined || input.eventIds !== undefined) {
    throw new InvalidBulkEditError('Usa eventRefs o eventId/eventIds, no ambos.');
  }
  if (!Array.isArray(input.eventRefs) || input.eventRefs.length < 1 || input.eventRefs.length > 49
    || input.eventRefs.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{8}$/i.test(ref))) {
    throw new InvalidBulkEditError('eventRefs requiere entre 1 y 49 referencias de 8 caracteres devueltas por list_movements.');
  }
  const refs = input.eventRefs.map(ref => String(ref).toLowerCase());
  if (new Set(refs).size !== refs.length) throw new InvalidBulkEditError('eventRefs no puede repetir referencias.');
  const ids = await readLedgerMovementIdsByPrefix(applicationSqlClient(), refs);
  const eventIds = refs.map(ref => {
    const candidates = ids.filter(id => id.startsWith(ref));
    if (candidates.length !== 1) {
      throw new InvalidBulkEditError(candidates.length === 0
        ? `La referencia ${ref} no existe. Vuelve a consultar list_movements.`
        : `La referencia ${ref} es ambigua. Usa el ID completo de list_movements.`);
    }
    return candidates[0]!;
  });
  const { eventRefs: _refs, ...rest } = input;
  return { ...rest, eventIds };
};
