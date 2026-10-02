import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/store.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SqlClient } from '../src/dsql/projection.js';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';
let sql: PGlite;
const migration = SCHEMA_STATEMENTS.slice(SCHEMA_STATEMENTS.findIndex(s => s.includes('CREATE TABLE IF NOT EXISTS olbia.spend_categories')));
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS.slice(0, SCHEMA_STATEMENTS.length - migration.length)) await sql.query(statement);
}, 30_000);
afterAll(() => sql.close());
describe('native category migration', () => {
  it('preserves persisted labels, seeds unpersisted defaults once and resumes an interrupted migration', async () => {
    await sql.query(`INSERT INTO olbia.categories (source_pk,source_sk,row_id,id,name,sort_order,payload)
      VALUES ('CATEGORY_CATALOG','CAT#restaurantes','restaurantes','restaurantes','Comida',1,'{}')`);
    // Simulate a deployment interruption after the catalog copy, before defaults/version.
    for (const statement of migration.slice(0, 2)) await sql.query(statement);
    for (const statement of migration) await sql.query(statement);
    expect((await sql.query<{ count: number }>('SELECT count(*) AS count FROM olbia.spend_categories')).rows[0].count).toBe(DEFAULT_SPEND_CATEGORIES.length);
    expect((await sql.query("SELECT name,sort_order FROM olbia.spend_categories WHERE id='restaurantes'")).rows).toEqual([{ name: 'Comida', sort_order: 1 }]);
    await sql.query("UPDATE olbia.spend_categories SET name='Nueva etiqueta' WHERE id='restaurantes'");
    await sql.query("DELETE FROM olbia.spend_categories WHERE id='deportes'");
    for (const statement of migration) await sql.query(statement);
    expect((await sql.query("SELECT name FROM olbia.spend_categories WHERE id='restaurantes'")).rows).toEqual([{ name: 'Nueva etiqueta' }]);
    expect((await sql.query("SELECT id FROM olbia.spend_categories WHERE id='deportes'")).rows).toHaveLength(0);
    expect((await sql.query("SELECT name FROM olbia.categories WHERE id='restaurantes'")).rows).toEqual([{ name: 'Comida' }]);
  });
  it('enforces domain identity and required values natively and blocks retired document writers', async () => {
    for (const values of [['Invalid ID', 'Name', 1], ['empty', ' ', 1], ['missing', 'Name', null]]) {
      await expect(sql.query('INSERT INTO olbia.spend_categories VALUES ($1,$2,$3)', values)).rejects.toThrow();
    }
    await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
    const store = new OlbiaSqlStore({ query: (s, v) => sql.query(s, v), transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) }, 'metadata');
    await expect(store.send(new PutCommand({ TableName: 'metadata', Item: {
      PK: 'CATEGORY_CATALOG', SK: 'CAT#otros', id: 'otros', name: 'Stale', sortOrder: 1,
    } }))).rejects.toMatchObject({ name: 'ValidationException' });
    expect((await sql.query("SELECT name FROM olbia.spend_categories WHERE id='otros'")).rows).toEqual([{ name: 'Otros' }]);
    expect((await sql.query("SELECT source_item FROM olbia.projection_state WHERE source_pk='CATEGORY_CATALOG'")).rows).toHaveLength(0);
  });
});
