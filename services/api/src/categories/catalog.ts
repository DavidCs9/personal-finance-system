import { createHash, randomUUID } from 'node:crypto';
import { isValidCategoryId, type SpendCategory } from '@finance/domain';
import { applicationSqlClient } from '@finance/ledger/sql-runtime';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';

export class InvalidCategoryError extends Error {}
export const categoryReadStatement = `SELECT c.id,c.name,c.sort_order,
  COALESCE(l.archived,false) AS archived,COALESCE(l.revision,0) AS revision
  FROM olbia.spend_categories c LEFT JOIN olbia.category_lifecycle l ON l.category_id=c.id`;

/** Include retired identities for historical labels; assignment choices filter archived. */
export const readCategoryCatalog = async (client: ReadSqlClient = readerPool()): Promise<readonly SpendCategory[]> =>
  (await client.query(categoryReadStatement)).rows.map(row => ({
    id: row.id as string, name: row.name as string, sortOrder: row.sort_order as number,
    ...(row.archived === true ? { archived: true } : {}),
    ...(Number(row.revision) > 0 ? { revision: Number(row.revision) } : {}),
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));

export const requireCatalogCategories = async (ids: readonly (string | null)[], allowArchived = false): Promise<void> => {
  const requested = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!requested.length) return;
  if (requested.some(id => !isValidCategoryId(id))) throw new InvalidCategoryError('La categoría no es válida.');
  const found = new Set((await applicationSqlClient().query(
    `SELECT c.id FROM olbia.spend_categories c LEFT JOIN olbia.category_lifecycle l ON l.category_id=c.id
      WHERE c.id=ANY($1::text[]) AND ($2::boolean OR COALESCE(l.archived,false)=false)`, [requested, allowArchived],
  )).rows.map(row => String(row.id)));
  if (requested.some(id => !found.has(id))) {
    throw new InvalidCategoryError('La categoría no existe o está archivada. Consulta el catálogo antes de aplicar.');
  }
};

export const validateCategory = (category: SpendCategory): void => {
  if (!category || typeof category.id !== 'string' || !isValidCategoryId(category.id)
    || typeof category.name !== 'string' || !category.name.trim() || category.name.trim().length > 100
    || !Number.isInteger(category.sortOrder) || category.sortOrder < -2_147_483_648 || category.sortOrder > 2_147_483_647) {
    throw new InvalidCategoryError('Cada categoría requiere ID, nombre y orden válidos.');
  }
};
export const catalogFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Caller owns the domain transaction/barrier. History and lifecycle commit with the label. */
export const writeCategory = async (input: {
  previous: SpendCategory | undefined; next: SpendCategory; operationId: string;
  changedBy: string; action: 'create' | 'update' | 'archive' | 'restore'; fingerprint: string;
}): Promise<SpendCategory> => {
  const client = applicationSqlClient();
  const next = { id: input.next.id, name: input.next.name.trim(), sortOrder: input.next.sortOrder,
    archived: input.next.archived === true, revision: (input.previous?.revision ?? 0) + 1 };
  validateCategory(next);
  await client.query(`INSERT INTO olbia.spend_categories (id,name,sort_order) VALUES ($1,$2,$3)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order`, [next.id,next.name,next.sortOrder]);
  await client.query(`INSERT INTO olbia.category_lifecycle (category_id,archived,revision) VALUES ($1,$2,$3)
    ON CONFLICT (category_id) DO UPDATE SET archived=EXCLUDED.archived,revision=EXCLUDED.revision`, [next.id,next.archived,next.revision]);
  await client.query(`INSERT INTO olbia.category_catalog_changes
    (operation_id,category_id,revision,changed_by,action,request_fingerprint,created_at,previous_value,next_value)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.operationId,next.id,next.revision,input.changedBy,input.action,
    input.fingerprint,new Date().toISOString(),input.previous ? JSON.stringify(input.previous) : null,JSON.stringify(next)]);
  return next;
};

/** Legacy catalog PUT changes labels/order only; it cannot archive or reactivate entries. */
export const saveCategoryCatalog = async (categories: readonly SpendCategory[]): Promise<void> => {
  if (!Array.isArray(categories) || categories.length > 100) {
    throw new InvalidCategoryError('El catálogo debe contener hasta 100 categorías con IDs únicos.');
  }
  categories.forEach(validateCategory);
  if (new Set(categories.map(c => c.id)).size !== categories.length) throw new InvalidCategoryError('El catálogo requiere IDs únicos.');
  const current = await readCategoryCatalog(applicationSqlClient());
  for (const category of categories) {
    const previous = current.find(c => c.id === category.id);
    if (previous && previous.name === category.name.trim() && previous.sortOrder === category.sortOrder) continue;
    await writeCategory({ previous, next: { ...category, archived: previous?.archived === true },
      operationId: randomUUID(), changedBy: 'catalog_api', action: previous ? 'update' : 'create',
      fingerprint: catalogFingerprint([category.id,category.name.trim(),category.sortOrder]) });
  }
};
