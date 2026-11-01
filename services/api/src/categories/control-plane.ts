import { randomUUID } from 'node:crypto';
import { normalizeMerchantKey } from '@finance/domain';
import { applicationSqlClient, withSqlTransaction } from '@finance/ledger/sql-runtime';
import { catalogFingerprint, InvalidCategoryError, readCategoryCatalog, validateCategory, writeCategory } from './catalog.js';
import type { ReadSqlClient } from '../events/sql-reads.js';

export const readAgentCatalogOperation = async (owner: string, operationId: string, client: ReadSqlClient) => {
  const row = (await client.query(`SELECT action,revision,category_id,created_at,previous_value,next_value
    FROM olbia.category_catalog_changes WHERE operation_id=$1 AND changed_by=$2`, [operationId, owner])).rows[0];
  if (!row) return undefined;
  const current = (await readCategoryCatalog(client)).find(category => category.id === row.category_id);
  return { ok: true, operationId, kind: 'category_catalog', status: 'applied', action: row.action,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    previous: row.previous_value, category: row.next_value,
    currentStateMatchesReceipt: current?.revision === Number(row.revision), currentCategory: current ?? null };
};

/** Read-only discovery also supplies a fresh retry identity for the next bounded write. */
export const listAgentCategories = async () => ({
  operationId: randomUUID(),
  categories: (await readCategoryCatalog()).map(category => ({ ...category,
    archived: category.archived === true, revision: category.revision ?? 0 })),
});

export const manageAgentCategory = async (owner: string, input: Record<string, unknown>) => {
  const { operationId, action, categoryId, expectedRevision } = input;
  if (!owner.trim()) throw new InvalidCategoryError('Falta el dueño autenticado.');
  if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId))
    throw new InvalidCategoryError('Consulta list_categories para obtener un operationId válido.');
  if (typeof action !== 'string' || !['create','update','archive','restore'].includes(action)) throw new InvalidCategoryError('Acción de catálogo inválida.');
  if (typeof categoryId !== 'string') throw new InvalidCategoryError('categoryId es obligatorio.');
  if (action !== 'create' && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0))
    throw new InvalidCategoryError('expectedRevision es obligatorio; consulta list_categories.');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new InvalidCategoryError('Nombre inválido.');
  if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) throw new InvalidCategoryError('Orden inválido.');
  if ((action === 'archive' || action === 'restore') && (input.name !== undefined || input.sortOrder !== undefined))
    throw new InvalidCategoryError('Archivar/restaurar no cambia nombre ni orden.');
  if (action === 'update' && input.name === undefined && input.sortOrder === undefined) throw new InvalidCategoryError('Indica nombre u orden a modificar.');
  const fingerprint = catalogFingerprint([action,categoryId,expectedRevision ?? null,
    typeof input.name === 'string' ? input.name.trim() : null,input.sortOrder ?? null]);
  return withSqlTransaction(async () => {
    const client = applicationSqlClient();
    const existing = (await client.query(`SELECT changed_by,request_fingerprint,action,previous_value,next_value
      FROM olbia.category_catalog_changes WHERE operation_id=$1`, [operationId])).rows[0];
    if (existing) {
      if (existing.changed_by !== owner || existing.request_fingerprint !== fingerprint)
        throw new InvalidCategoryError('operationId ya corresponde a otra solicitud.');
      return { operationId, action: existing.action, previous: existing.previous_value, category: existing.next_value };
    }
    const catalog = await readCategoryCatalog(client);
    const previous = catalog.find(c => c.id === categoryId);
    if (action === 'create' ? Boolean(previous) : !previous)
      throw new InvalidCategoryError(action === 'create' ? 'El ID ya existe, incluso si está archivado.' : 'La categoría no existe.');
    if (previous && (previous.revision ?? 0) !== expectedRevision)
      throw new InvalidCategoryError('La categoría cambió. Consulta list_categories y vuelve a intentarlo.');
    if (action === 'update' && previous?.archived) throw new InvalidCategoryError('Restaura la categoría antes de editarla.');
    if ((action === 'archive' && previous?.archived) || (action === 'restore' && !previous?.archived))
      throw new InvalidCategoryError('La categoría ya tiene ese estado; consulta list_categories.');
    const next = { id: categoryId, name: typeof input.name === 'string' ? input.name.trim() : previous?.name ?? '',
      sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : previous?.sortOrder ?? 0,
      archived: action === 'archive' };
    validateCategory(next);
    if (!next.archived && catalog.some(c => c.id !== categoryId && !c.archived
      && normalizeMerchantKey(c.name) === normalizeMerchantKey(next.name))) throw new InvalidCategoryError('Ya existe una categoría activa con ese nombre.');
    if ((action === 'create' || action === 'restore') && catalog.filter(c => !c.archived).length >= 100)
      throw new InvalidCategoryError('El catálogo admite hasta 100 categorías activas.');
    const category = await writeCategory({ previous, next, operationId, changedBy: owner,
      action: action as 'create' | 'update' | 'archive' | 'restore', fingerprint });
    return { operationId, action, previous: previous ?? null, category };
  });
};
