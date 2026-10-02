import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import type { CardRecord } from './cards.js';

export const cardReadStatement = `SELECT id,name,cut_off_day,payment_due_day,institution,created_at,updated_at
  FROM olbia.card_profiles WHERE owner=$1 AND deleted_at IS NULL`;
export const toNativeCardRecord = (row: Record<string, unknown>): CardRecord => ({
  id: row.id as string, name: row.name as string,
  cutOffDay: row.cut_off_day as number, paymentDueDay: row.payment_due_day as number,
  ...(row.institution ? { institution: row.institution as CardRecord['institution'] } : {}),
  createdAt: new Date(row.created_at as string | Date).toISOString(),
  updatedAt: new Date(row.updated_at as string | Date).toISOString(),
});
export const readSqlCards = async (owner: string, client: ReadSqlClient = readerPool()): Promise<readonly CardRecord[]> =>
  (await client.query(cardReadStatement, [owner])).rows.map(toNativeCardRecord)
    .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id));
