import { isValidCategoryId, type SpendCategory } from '@finance/domain';
import { applicationStoreClient } from '@finance/ledger/dsql-store';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';

export class InvalidCategoryError extends Error {}

export const categoryReadStatement = 'SELECT id,name,sort_order FROM olbia.spend_categories';

/** The catalog is authoritative SQL; defaults are seeded once by the schema migration. */
export const readCategoryCatalog = async (client: ReadSqlClient = readerPool()): Promise<readonly SpendCategory[]> =>
  (await client.query(categoryReadStatement)).rows.map(row => ({
    id: row.id as string, name: row.name as string, sortOrder: row.sort_order as number,
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));

export const requireCatalogCategories = async (ids: readonly (string | null)[]): Promise<void> => {
  const requested = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!requested.length) return;
  if (requested.some(id => !isValidCategoryId(id))) throw new InvalidCategoryError('La categoría no es válida.');
  const found = new Set((await readerPool().query(
    'SELECT id FROM olbia.spend_categories WHERE id=ANY($1::text[])', [requested],
  )).rows.map(row => String(row.id)));
  if (requested.some(id => !found.has(id))) {
    throw new InvalidCategoryError('La categoría no existe. Consulta el catálogo antes de aplicar.');
  }
};

/** Caller owns the domain transaction, including validation and the complete catalog update. */
export const saveCategoryCatalog = async (categories: readonly SpendCategory[]): Promise<void> => {
  if (!Array.isArray(categories) || categories.length > 100) {
    throw new InvalidCategoryError('El catálogo debe contener hasta 100 categorías con IDs únicos.');
  }
  for (const category of categories) {
    if (!category || typeof category.id !== 'string' || !isValidCategoryId(category.id)
      || typeof category.name !== 'string' || !category.name.trim() || category.name.trim().length > 100
      || !Number.isInteger(category.sortOrder) || category.sortOrder < -2_147_483_648 || category.sortOrder > 2_147_483_647) {
      throw new InvalidCategoryError('Cada categoría requiere ID, nombre y orden válidos.');
    }
  }
  if (new Set(categories.map(c => c.id)).size !== categories.length) {
    throw new InvalidCategoryError('El catálogo requiere IDs únicos.');
  }
  const client = applicationStoreClient();
  for (const category of categories) await client.query(
    `INSERT INTO olbia.spend_categories (id,name,sort_order) VALUES ($1,$2,$3)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order`,
    [category.id, category.name.trim(), category.sortOrder],
  );
};
