import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { nativeCategoryReadGrant, nativeCategoryWriteGrants } from '../src/dsql/category-schema.js';
let sql: PGlite;
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await sql.query("INSERT INTO olbia.spend_categories VALUES ('personal','Personal',1)");
  await sql.query("INSERT INTO olbia.category_lifecycle VALUES ('personal',false,1)");
  await sql.query(`INSERT INTO olbia.category_catalog_changes VALUES
    ('00000000-0000-4000-8000-000000000001','personal',1,'owner','create',$1,CURRENT_TIMESTAMP,NULL,'{"id":"personal"}')`, ['a'.repeat(64)]);
  for (const role of ['catalog_reader','catalog_writer']) {
    await sql.query(`CREATE ROLE ${role}`);
    await sql.query(`GRANT USAGE ON SCHEMA olbia TO ${role}`);
    await sql.query(nativeCategoryReadGrant(role));
  }
  for (const statement of nativeCategoryWriteGrants('catalog_writer')) await sql.query(statement);
}, 30_000);
afterAll(() => sql.close());
describe('native category lifecycle and immutable history permissions', () => {
  it('retains native identity, revision and history constraints', async () => {
    await expect(sql.query("INSERT INTO olbia.category_lifecycle VALUES ('missing',false,1)")).rejects.toMatchObject({ code: '23503' });
    await expect(sql.query("UPDATE olbia.category_lifecycle SET revision=0")).rejects.toMatchObject({ code: '23514' });
    await expect(sql.query("DELETE FROM olbia.spend_categories WHERE id='personal'")).rejects.toMatchObject({ code: '23503' });
    await expect(sql.query(`INSERT INTO olbia.category_catalog_changes SELECT
      '00000000-0000-4000-8000-000000000002',category_id,revision,changed_by,action,request_fingerprint,created_at,previous_value,next_value
      FROM olbia.category_catalog_changes`)).rejects.toMatchObject({ code: '23505' });
  });
  it('keeps readers read-only and writers unable to alter history or delete lifecycle', async () => {
    for (const role of ['catalog_reader','catalog_writer']) {
      await sql.query(`SET ROLE ${role}`);
      try {
        expect((await sql.query('SELECT * FROM olbia.category_catalog_changes')).rows).toHaveLength(1);
        await expect(sql.query('DELETE FROM olbia.category_catalog_changes')).rejects.toMatchObject({ code: '42501' });
        await expect(sql.query("UPDATE olbia.category_catalog_changes SET changed_by='other'")).rejects.toMatchObject({ code: '42501' });
        await expect(sql.query('DELETE FROM olbia.category_lifecycle')).rejects.toMatchObject({ code: '42501' });
        await expect(sql.query("UPDATE olbia.category_lifecycle SET category_id='other'")).rejects.toMatchObject({ code: '42501' });
        if (role === 'catalog_reader') await expect(sql.query('UPDATE olbia.category_lifecycle SET archived=true')).rejects.toMatchObject({ code: '42501' });
        else await sql.query('UPDATE olbia.category_lifecycle SET archived=true,revision=2');
      } finally { await sql.query('RESET ROLE'); }
    }
  });
});
