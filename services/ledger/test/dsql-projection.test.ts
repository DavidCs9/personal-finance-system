import { PGlite } from '@electric-sql/pglite';
import { types as pgTypes } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SPEND_CATEGORIES, buildMsiSchedule } from '@finance/domain';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { projectRows, TABLE_NAMES, type SourceItem, type SourceKey } from '../src/dsql/model.js';
import { reconcileKey, processStream, sourceHash, type SqlClient, type TransactionPool } from '../src/dsql/projection.js';
import { verifyKey } from '../src/dsql/verification.js';

const key = { PK: 'EVENT#movement', SK: 'EVENT' };
const movement = (patch: Record<string, unknown> = {}): SourceItem => ({ ...key, entityType: 'observed_purchase',
  payload: { id: 'movement', institution: 'american_express_mx', eventType: 'card_purchase', status: 'pending_foreign',
    amount: { amountMinor: 123456, currency: 'USD' }, personalAmountMinor: 0, merchantRaw: 'Merchant',
    receivedAt: '2026-10-01T02:00:00Z', source: { bucket: 'real-evidence', key: 'original' },
    parseWarnings: ['pending'], ...patch },
});

let sql: PGlite;
let pool: TransactionPool;
let source: Map<string, SourceItem>;
const keyId = (value: SourceKey): string => JSON.stringify([value.PK, value.SK]);
const readSource = async (value: SourceKey): Promise<SourceItem | undefined> => source.get(keyId(value));
const setSource = (item: SourceItem): void => { source.set(keyId({ PK: item.PK, SK: item.SK }), item); };
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: (callback) => sql.transaction((client) => callback(client as unknown as SqlClient)) };
}, 30_000);
afterAll(async () => { await sql.close(); });
beforeEach(async () => {
  source = new Map();
  await sql.exec(`TRUNCATE olbia.projection_state,${TABLE_NAMES.map((name) => `olbia.${name}`).join(',')}`);
});

describe('SQL projection integrity', () => {
  it('preserves amounts, zero Mi parte, currency, status, evidence and Chihuahua month through duplicate replay', async () => {
    const item = movement(); setSource(item);
    await reconcileKey(pool, readSource, key); await reconcileKey(pool, readSource, key);
    const rows = (await sql.query('SELECT * FROM olbia.movements')).rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount_minor: 123456, personal_amount_minor: 0, currency: 'USD', status: 'pending_foreign', spend_month: '2026-09' });
    expect(rows[0].payload).toEqual(item.payload);
    expect(await verifyKey(pool, readSource, key)).toBe('equal');
  });

  it('atomically replaces old tags and MSI rows, retaining spent evidence and day precision', async () => {
    const plan = buildMsiSchedule({ principalMinor: 10001, months: 3, startMonth: '2026-09', origin: 'manual' });
    setSource(movement({ tags: ['work', 'travel'], msi: plan }));
    await reconcileKey(pool, readSource, key);
    const replacement = { ...plan, months: 2, installments: [
      { index: 1, month: '2026-09', amountMinor: 5000, status: 'spent', occurredOn: '2026-09-29', evidenceObservationId: 'evidence' },
      { index: 2, month: '2026-10', amountMinor: 5001, status: 'cancelled' },
    ] };
    setSource(movement({ tags: ['travel'], msi: replacement }));
    await reconcileKey(pool, readSource, key);
    expect((await sql.query('SELECT tag FROM olbia.movement_tags')).rows).toEqual([{ tag: 'travel' }]);
    const installments = (await sql.query('SELECT installment_index,month,payload FROM olbia.msi_installments ORDER BY installment_index')).rows;
    expect(installments).toHaveLength(2);
    expect(installments[0]).toMatchObject({ payload: replacement.installments[0] });
    expect(await verifyKey(pool, readSource, key)).toBe('equal');
    expect((await sql.query("SELECT * FROM olbia.movement_months WHERE month='2026-10'")).rows).toHaveLength(1);
    setSource(movement()); await reconcileKey(pool, readSource, key);
    expect((await sql.query('SELECT * FROM olbia.msi_installments')).rows).toEqual([]);
    expect((await sql.query('SELECT * FROM olbia.movement_tags')).rows).toEqual([]);
  });

  it('rolls back failures and never loses the last good projection', async () => {
    setSource(movement()); await reconcileKey(pool, readSource, key);
    const invalid = movement({ amount: { amountMinor: 1.5, currency: 'MXN' } }); setSource(invalid);
    await expect(reconcileKey(pool, readSource, key)).rejects.toThrow('Invalid projection integer');
    expect((await sql.query('SELECT currency FROM olbia.movements')).rows).toEqual([{ currency: 'USD' }]);
    setSource(movement({ status: 'accepted' }));
    const interrupted: TransactionPool = { transaction: (callback) => sql.transaction(async (client) => {
      await callback(client as unknown as SqlClient); throw new Error('before commit');
    }) };
    await expect(reconcileKey(interrupted, readSource, key)).rejects.toThrow('before commit');
    expect((await sql.query('SELECT status FROM olbia.movements')).rows).toEqual([{ status: 'pending_foreign' }]);
    await reconcileKey(pool, readSource, key);
    expect(await verifyKey(pool, readSource, key)).toBe('equal');
  });

  it('deletes derived rows with tombstones, preserving observations/revisions arriving independently', async () => {
    setSource(movement({ tags: ['trip'], msi: buildMsiSchedule({ principalMinor: 12000, months: 3, startMonth: '2026-10', origin: 'manual' }) }));
    const observation = { PK: key.PK, SK: 'OBSERVATION#2026-09-30#o', payload: { id: 'o', eventId: 'movement', amount: { amountMinor: 12000, currency: 'MXN' }, captureSource: 'email' } };
    const revision = { PK: key.PK, SK: 'REVISION#2026-09-30#r', payload: { id: 'r', observedPurchaseId: 'movement', createdAt: '2026-09-30T12:00:00Z', changes: { status: { previous: null, next: 'accepted' } } } };
    for (const item of [observation, revision]) { setSource(item); await reconcileKey(pool, readSource, item); }
    await reconcileKey(pool, readSource, key);
    source.delete(keyId(key)); await reconcileKey(pool, readSource, key); await reconcileKey(pool, readSource, key);
    expect((await sql.query('SELECT * FROM olbia.movements')).rows).toEqual([]);
    expect((await sql.query('SELECT * FROM olbia.msi_installments')).rows).toEqual([]);
    expect((await sql.query('SELECT deleted FROM olbia.projection_state WHERE source_sk=$1', ['EVENT'])).rows).toEqual([{ deleted: true }]);
    expect((await sql.query('SELECT * FROM olbia.movement_observations')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.movement_revisions')).rows).toHaveLength(1);
    expect(await verifyKey(pool, readSource, key)).toBe('equal');
  });

  it('projects owner card keys and retains effective default categories after override deletion', async () => {
    const card = { PK: 'USER#owner', SK: 'CARD#amex', owner: 'owner', payload: { id: 'amex', name: 'Amex', cutOffDay: 25, paymentDueDay: 15 } };
    setSource(card); await reconcileKey(pool, readSource, card);
    expect((await sql.query('SELECT owner,id FROM olbia.cards')).rows).toEqual([{ owner: 'owner', id: 'amex' }]);
    source.delete(keyId({ PK: card.PK, SK: card.SK })); await reconcileKey(pool, readSource, card);
    expect((await sql.query('SELECT * FROM olbia.cards')).rows).toEqual([]);
    for (const category of DEFAULT_SPEND_CATEGORIES) await reconcileKey(pool, readSource, { PK: 'CATEGORY_CATALOG', SK: `CAT#${category.id}` });
    expect((await sql.query('SELECT * FROM olbia.categories')).rows).toHaveLength(DEFAULT_SPEND_CATEGORIES.length);
    const category = { PK: 'CATEGORY_CATALOG', SK: 'CAT#otros', id: 'otros', name: 'Personal', sortOrder: 3 };
    setSource(category); await reconcileKey(pool, readSource, category);
    expect((await sql.query("SELECT name FROM olbia.categories WHERE id='otros'")).rows).toEqual([{ name: 'Personal' }]);
    source.delete(keyId({ PK: category.PK, SK: category.SK })); await reconcileKey(pool, readSource, category);
    expect((await sql.query("SELECT name FROM olbia.categories WHERE id='otros'")).rows).toEqual([{ name: 'Otros' }]);
  });

  it('detects same-checkpoint relational corruption, source lag, and racing source changes', async () => {
    setSource(movement()); await reconcileKey(pool, readSource, key);
    await sql.query("UPDATE olbia.movements SET amount_minor=999 WHERE id='movement'");
    expect(await verifyKey(pool, readSource, key)).toBe('mismatch');
    setSource(movement({ status: 'accepted' }));
    expect(await verifyKey(pool, readSource, key)).toBe('lag');
    await reconcileKey(pool, readSource, key);
    let read = 0;
    expect(await verifyKey(pool, async () => movement({ status: read++ ? 'rejected' : 'accepted' }), key)).toBe('lag');
  });

  it('preserves milliseconds from the native pg timestamp parser and still detects a one-millisecond discrepancy', async () => {
    const item = movement({ occurredAt: '2026-09-30T23:45:20.123Z', receivedAt: '2026-09-30T23:45:20.456Z' });
    const revision = { PK: key.PK, SK: 'REVISION#precision', payload: {
      id: 'precision', createdAt: '2026-09-30T23:45:20.789Z', changes: {},
    } };
    for (const sourceItem of [item, revision]) { setSource(sourceItem); await reconcileKey(pool, readSource, sourceItem); }
    const parseTimestamp = pgTypes.getTypeParser(1184);
    expect(parseTimestamp('2026-09-30 23:45:20.123+00')).toBeInstanceOf(Date);
    const nativeDates: TransactionPool = { transaction: (callback) => sql.transaction((client) => callback({
      query: async (statement, values) => {
        const result = await client.query(statement, values);
        return { rows: (result.rows as Record<string, unknown>[]).map((row) => Object.fromEntries(
          Object.entries(row).map(([column, value]) => [column,
            value != null && ['occurred_at', 'received_at', 'created_at'].includes(column)
              ? parseTimestamp((value instanceof Date ? value.toISOString() : String(value)).replace('T', ' ').replace(/Z$/, '+00')) : value]),
        )) };
      },
    })) };
    expect(await verifyKey(nativeDates, readSource, key)).toBe('equal');
    expect(await verifyKey(nativeDates, readSource, revision)).toBe('equal');
    await sql.query("UPDATE olbia.movements SET occurred_at='2026-09-30T23:45:20.124Z' WHERE id='movement'");
    expect(await verifyKey(nativeDates, readSource, key)).toBe('mismatch');
  });

  it('ignores stale stream images and resumes only from first failed sequence', async () => {
    setSource(movement({ status: 'accepted' }));
    const record = (sequence: string) => ({ dynamodb: { Keys: { PK: { S: key.PK }, SK: { S: key.SK } }, SequenceNumber: sequence, NewImage: { stale: true } } });
    const result = await processStream([record('1'), record('2'), record('3')], async (value) => {
      await reconcileKey(pool, readSource, value); throw new Error('response lost after commit');
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: '1' }]);
    expect((await sql.query('SELECT status FROM olbia.movements')).rows).toEqual([{ status: 'accepted' }]);
    expect(await processStream([record('1'), record('2'), record('3')], (value) => reconcileKey(pool, readSource, value))).toEqual({ batchItemFailures: [] });
    expect((await sql.query('SELECT * FROM olbia.movements')).rows).toHaveLength(1);
  });

  it('rejects duplicate MSI indices and unsafe amounts before modifying the target', () => {
    expect(() => projectRows(key, movement({ amount: { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'MXN' } }))).toThrow();
    expect(() => projectRows(key, movement({ msi: { months: 2, principalMinor: 10, cuotaMinor: 5, status: 'active', installments: [{ index: 1, month: '2026-10', amountMinor: 5, status: 'spent' }, { index: 1 }] } }))).toThrow('Duplicate installment');
  });
});

// An OCC store models DSQL's snapshot/write-conflict semantics to force adverse
// interleavings. Relational SQL itself is exercised above by actual PostgreSQL.
class OccPool implements TransactionPool {
  checkpoint?: { generation: string; hash: string | null; deleted: boolean };
  retries = 0;
  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    for (;;) {
      const snapshot = this.checkpoint;
      let next = snapshot;
      const client: SqlClient = { query: async (statement, args = []) => {
        if (statement.startsWith('SELECT generation')) return { rows: snapshot ? [{ generation: snapshot.generation }] : [] };
        if (statement.startsWith('INSERT INTO olbia.projection_state') || statement.startsWith('UPDATE olbia.projection_state')) {
          next = { generation: String(args[2]), hash: args[3] as string | null, deleted: args[5] as boolean };
        }
        return { rows: [] };
      } };
      const value = await callback(client);
      if (this.checkpoint !== snapshot) { this.retries++; continue; }
      this.checkpoint = next;
      return value;
    }
  }
}
const gate = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
describe('source/target concurrency protocol', () => {
  for (const table of ['plan', 'payroll']) it(`never overwrites a confirmed ${table} update or resurrects it during concurrent backfill`, async () => {
    const sourceKey = { PK: 'USER#owner', SK: table === 'plan' ? 'MONTH#2026-09' : 'PAYROLL#2026-09#UUID' };
    const make = (amountMinor: number): SourceItem => ({ ...sourceKey, owner: 'owner', month: '2026-09', uuid: 'UUID',
      payload: table === 'plan' ? { upcomingPayments: [{ id: 'bill', amountMinor }] } : {
        uuid: 'UUID', month: '2026-09', fechaPago: '2026-09-15', totalMinor: amountMinor,
        totalPercepcionesMinor: amountMinor, totalDeduccionesMinor: 0, totalOtrosPagosMinor: 0, lines: [],
      } });
    for (const removed of [false, true]) {
      const occ = new OccPool(); let live: SourceItem | undefined = make(100);
      await reconcileKey(occ, async () => live, sourceKey);
      const read = gate(), resume = gate(); let first = true;
      const backfill = reconcileKey(occ, async () => {
        const observed = live;
        if (first) { first = false; read.release(); await resume.promise; }
        return observed;
      }, sourceKey);
      await read.promise; live = removed ? undefined : make(200);
      await reconcileKey(occ, async () => live, sourceKey); resume.release(); await backfill;
      expect(occ.retries).toBe(1);
      expect(occ.checkpoint).toMatchObject({ hash: sourceHash(live), deleted: removed });
    }
  });
  for (const existing of [false, true]) it(`re-reads current DDB when an older worker commits last (existing=${existing})`, async () => {
    const occ = new OccPool(); let live = movement();
    if (existing) await reconcileKey(occ, async () => live, key);
    const read = gate(); const resume = gate(); let first = true;
    const oldWorker = reconcileKey(occ, async () => {
      const observed = live;
      if (first) { first = false; read.release(); await resume.promise; }
      return observed;
    }, key);
    await read.promise; live = movement({ status: 'accepted' });
    await reconcileKey(occ, async () => live, key); resume.release(); await oldWorker;
    expect(occ.retries).toBe(1); expect(occ.checkpoint?.hash).toBe(sourceHash(live));
  });
  it('a backfill racing a deletion cannot resurrect the deleted movement', async () => {
    const occ = new OccPool(); let live: SourceItem | undefined = movement();
    await reconcileKey(occ, async () => live, key);
    const read = gate(); const resume = gate(); let first = true;
    const loader = reconcileKey(occ, async () => {
      const observed = live; if (first) { first = false; read.release(); await resume.promise; } return observed;
    }, key);
    await read.promise; live = undefined; await reconcileKey(occ, async () => live, key); resume.release(); await loader;
    expect(occ.checkpoint).toMatchObject({ hash: null, deleted: true }); expect(occ.retries).toBe(1);
  });
  it('retries only the checkpoint first-insert unique race, and rereads source', async () => {
    let attempts = 0; let reads = 0;
    const occ = new OccPool();
    const collision: TransactionPool = { transaction: async (callback) => {
      const value = await occ.transaction(callback);
      if (attempts++ === 0) throw { code: '23505', constraint: 'projection_state_pkey' };
      return value;
    } };
    await reconcileKey(collision, async () => { reads++; return movement(); }, key);
    expect(reads).toBe(2);
    const invalid: TransactionPool = { transaction: async () => { throw { code: '23505', constraint: 'other_constraint' }; } };
    await expect(reconcileKey(invalid, async () => movement(), key)).rejects.toMatchObject({ constraint: 'other_constraint' });
  });
});
