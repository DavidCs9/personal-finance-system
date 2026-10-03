import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardRemindersForDay } from '@finance/domain';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { withSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import * as readers from '../src/events/sql-reads.js';
import { saveCard, deleteCard, listCards } from '../src/cards/cards.js';

let sql: PGlite;
const save = (cardId: string, name = cardId) => saveCard({ owner: 'owner', cardId,
  body: { name, cutOffDay: 31, paymentDueDay: 31, institution: 'american_express_mx' } });
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  for (const table of ['liability_snapshots','liability_versions']) {
    await sql.query(`ALTER TABLE olbia.${table} ADD CONSTRAINT ${table}_card_required CHECK (card_id IS NOT NULL)`);
    await sql.query(`ALTER TABLE olbia.${table} ADD CONSTRAINT ${table}_card_fk FOREIGN KEY (card_id) REFERENCES olbia.card_profiles(id)`);
  }
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
}, 30_000);
afterAll(() => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.liability_daily_captures,olbia.liability_capture_replacements,olbia.liability_captures,olbia.card_profiles,olbia.liability_snapshots,olbia.liability_versions,olbia.projection_state,olbia.cards');
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true'); vi.stubEnv('DSQL_DOMAIN_READ_MODE','dynamodb');
  vi.spyOn(connection, 'createPool').mockReturnValue({ query: (s: string, v?: unknown[]) => sql.query(s, v),
    transaction: (callback: (client: SqlClient) => Promise<unknown>) => sql.transaction(client => callback(client as unknown as SqlClient)),
  } as never);
  vi.spyOn(readers, 'readerPool').mockReturnValue(sql);
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(new Error('Retired document path') as never);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T12:00:00.123Z'));
});
describe('SQL-native card domain', () => {
  it('preserves creation time across edits, maps optional issuer and propagates SQL failure without document fallback', async () => {
    const first = await save('amex','  Amex  ');
    expect(first).toMatchObject({ name: 'Amex', createdAt: '2026-10-01T12:00:00.123Z', institution: 'american_express_mx' });
    vi.setSystemTime(new Date('2026-10-02T12:00:00.456Z'));
    const edited = await saveCard({ owner: 'owner', cardId: 'amex', body: { name: 'Updated', cutOffDay: 10, paymentDueDay: 28 } });
    expect(edited).toEqual({ ...first, name: 'Updated', cutOffDay: 10, paymentDueDay: 28, institution: undefined, updatedAt: '2026-10-02T12:00:00.456Z' });
    expect(await listCards('owner')).toEqual([edited]);
    expect(await listCards("owner' OR '1'='1")).toEqual([]);
    expect((await sql.query('SELECT * FROM olbia.cards')).rows).toHaveLength(0);
    expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toHaveLength(0);
    vi.mocked(readers.readerPool).mockReturnValue({ query: async () => { throw new Error('SQL unavailable'); } });
    await expect(listCards('owner')).rejects.toThrow('SQL unavailable');
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });
  it('retains liability identity/history on removal, counts active profiles only, and reactivation respects max three', async () => {
    const original = await save('a'); await save('b'); await save('c');
    await sql.query(`INSERT INTO olbia.liability_snapshots (source_pk,source_sk,row_id,owner,card_id,total_mxn_minor)
      VALUES ('USER#owner','LIAB_SNAP#a#2026-10-01','capture','owner','a',0)`);
    await sql.query(`INSERT INTO olbia.liability_versions (source_pk,source_sk,row_id,owner,card_id,total_mxn_minor)
      VALUES ('USER#owner','LIAB_VER#a#2026-10-01','version','owner','a',100)`);
    const history = (await sql.query('SELECT * FROM olbia.liability_snapshots')).rows;
    const versions = (await sql.query('SELECT * FROM olbia.liability_versions')).rows;
    await expect(save('d')).rejects.toThrow('At most 3');
    await deleteCard({ owner: 'owner', cardId: 'a' });
    await deleteCard({ owner: 'owner', cardId: 'a' });
    expect((await listCards('owner')).map(c => c.id)).toEqual(['b','c']);
    expect((await sql.query('SELECT * FROM olbia.liability_snapshots')).rows).toEqual(history);
    expect((await sql.query('SELECT * FROM olbia.liability_versions')).rows).toEqual(versions);
    await save('d'); await expect(save('a')).rejects.toThrow('At most 3');
    await deleteCard({ owner: 'owner', cardId: 'd' });
    vi.setSystemTime(new Date('2026-10-02T12:00:00.456Z'));
    const restored = await save('a'); expect(restored.createdAt).not.toBe(original.createdAt);
    expect((await sql.query("SELECT deleted_at FROM olbia.card_profiles WHERE id='a'")).rows).toEqual([{ deleted_at: null }]);
    expect(cardRemindersForDay(await listCards('owner'), '2026-02', 28).filter(r => r.cardId === 'a')).toHaveLength(2);
    expect(cardRemindersForDay(await listCards('owner'), '2028-02', 29).filter(r => r.cardId === 'a')).toHaveLength(2);
    await expect(sql.query("DELETE FROM olbia.card_profiles WHERE id='a'")).rejects.toThrow();
  });
  it('rolls back profile removal and recreation with their complete domain transaction', async () => {
    await save('a'); await save('b'); await save('c');
    const before = (await sql.query('SELECT * FROM olbia.card_profiles ORDER BY id')).rows;
    await expect(sql.transaction(client => withSqlClient(client as unknown as SqlClient, async () => {
      await deleteCard({ owner: 'owner', cardId: 'a' }); await save('d');
      throw new Error('Interrupted operation');
    }))).rejects.toThrow('Interrupted operation');
    expect((await sql.query('SELECT * FROM olbia.card_profiles ORDER BY id')).rows).toEqual(before);
    await deleteCard({ owner: 'different', cardId: 'a' });
    await expect(saveCard({ owner: 'different', cardId: 'a', body: { name: 'Changed', cutOffDay: 1, paymentDueDay: 2 } })).rejects.toThrow('Card not found');
    expect((await sql.query('SELECT * FROM olbia.card_profiles ORDER BY id')).rows).toEqual(before);
  });
  it('enforces required parent relationships on both current and historical captures and native profile validity', async () => {
    for (const table of ['liability_snapshots','liability_versions']) for (const parent of [null,'missing']) {
      await expect(sql.query(`INSERT INTO olbia.${table} (source_pk,source_sk,row_id,card_id) VALUES ('owner','capture','capture',$1)`, [parent])).rejects.toThrow();
    }
    for (const values of [['bad id','Name',1,1,null],['valid',' ',1,1,null],['valid','Name',32,1,null],['valid','Name',1,0,null],['valid','Name',1,1,'amazon_web_services']]) {
      await expect(sql.query(`INSERT INTO olbia.card_profiles (id,owner,name,cut_off_day,payment_due_day,institution,created_at,updated_at)
        VALUES ($1,'owner',$2,$3,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, values)).rejects.toThrow();
    }
    await expect(save('invalid id')).rejects.toThrow('cardId is invalid');
    await expect(saveCard({ owner: 'owner', cardId: 'valid', body: { name: 'Valid', cutOffDay: 0, paymentDueDay: 1 } })).rejects.toThrow('cutOffDay');
  });
});
