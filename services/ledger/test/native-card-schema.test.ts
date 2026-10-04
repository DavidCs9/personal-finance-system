import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_STATEMENTS, migrateCardProfiles } from './helpers/migration-schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';

let sql: PGlite, pool: TransactionPool, store: OlbiaSqlStore;
const card = { PK: 'USER#owner', SK: 'CARD#amex', owner: 'owner',
  createdAt: '2026-09-01T12:00:00.123Z', updatedAt: '2026-09-02T12:00:00.456Z',
  payload: { id: 'amex', name: 'Amex', cutOffDay: 31, paymentDueDay: 28, institution: 'american_express_mx' } };
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) };
  store = new OlbiaSqlStore({ ...pool, query: (s, v) => sql.query(s, v) }, 'metadata');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.liability_daily_captures,olbia.liability_capture_replacements,olbia.liability_captures,olbia.card_profiles,olbia.cards,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=9');
  await store.send(new PutCommand({ TableName: 'metadata', Item: card }));
});
describe('native card migration', () => {
  it('copies the latest committed edit with typed identity/timestamps and blocks late document writes', async () => {
    await store.send(new UpdateCommand({ TableName: 'metadata', Key: card,
      UpdateExpression: 'SET #payload.#name=:name', ExpressionAttributeNames: { '#payload': 'payload', '#name': 'name' },
      ExpressionAttributeValues: { ':name': 'Updated before copy' } }));
    const frozen = (await sql.query('SELECT * FROM olbia.projection_state')).rows;
    await migrateCardProfiles(pool);
    const profile = (await sql.query<Record<string, unknown>>('SELECT * FROM olbia.card_profiles')).rows[0];
    expect(profile).toMatchObject({ id: 'amex', owner: 'owner', name: 'Updated before copy', cut_off_day: 31,
      payment_due_day: 28, institution: 'american_express_mx', deleted_at: null });
    expect((profile.created_at as Date).toISOString()).toBe(card.createdAt);
    expect((profile.updated_at as Date).toISOString()).toBe(card.updatedAt);
    await expect(store.send(new PutCommand({ TableName: 'metadata', Item: card }))).rejects.toMatchObject({ name: 'MigrationPausedException' });
    expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual(frozen);
  });
  it('rolls back the copy, marker and barrier together on interruption and resumes without overwriting native changes', async () => {
    const barrier = (await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    const interrupted: TransactionPool = { transaction: callback => sql.transaction(async client => {
      await callback(client as unknown as SqlClient); throw new Error('Interrupted before commit');
    }) };
    await expect(migrateCardProfiles(interrupted)).rejects.toThrow('card-copy');
    expect((await sql.query('SELECT * FROM olbia.card_profiles')).rows).toHaveLength(0);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=9')).rows).toHaveLength(0);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(barrier);
    await migrateCardProfiles(pool);
    await sql.query("UPDATE olbia.card_profiles SET name='Native edit',deleted_at=CURRENT_TIMESTAMP");
    await migrateCardProfiles(pool);
    expect((await sql.query('SELECT name,deleted_at FROM olbia.card_profiles')).rows[0]).toMatchObject({ name: 'Native edit', deleted_at: expect.any(Date) });
  });
  it('fails closed on invalid source data and leaves the marker absent', async () => {
    await sql.query('UPDATE olbia.cards SET payment_due_day=32');
    await expect(migrateCardProfiles(pool)).rejects.toThrow('card-copy');
    expect((await sql.query('SELECT * FROM olbia.card_profiles')).rows).toHaveLength(0);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=9')).rows).toHaveLength(0);
  });
});
