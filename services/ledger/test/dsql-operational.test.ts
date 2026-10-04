import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { entityForKey, projectRows, type SourceItem } from '../src/dsql/model.js';
import { reconcileKey, processStream, type SqlClient, type TransactionPool } from '../src/dsql/projection.js';
import { verifyKey } from '../src/dsql/verification.js';

const at = '2026-10-01T10:20:30.123Z';
const records: SourceItem[] = [
  { PK: 'DEDUPE#email', SK: 'CLAIM', entityType: 'source_dedupe_claim', eventId: 'event', observationId: 'observation', createdAt: at },
  { PK: 'EXCEPTION_DEDUPE#hash', SK: 'CLAIM', entityType: 'ingestion_exception_claim', sourceDedupeKey: 'source', extractorVersion: 'original', createdAt: at },
  { PK: 'EXCEPTION#id', SK: 'EXCEPTION', entityType: 'ingestion_exception', GSI1PK: 'EXCEPTIONS', GSI1SK: at, payload: { id: 'id', receivedAt: at, retry: { status: 'queued', requestId: 'req' }, source: { key: 'original' } } },
  { PK: 'RETRY#legacy', SK: 'DISPATCH', entityType: 'ingestion_retry', status: 'dispatched', createdAt: at, dispatchedAt: at, job: { source: { key: 'legacy' } } },
  { PK: 'RETRY#id', SK: 'DISPATCH#req', entityType: 'ingestion_retry', status: 'pending', createdAt: at, job: { retryExceptionId: 'id', source: { key: 'original' } } },
  { PK: 'USER#owner', SK: 'IMPORT#AMEX#hash', entityType: 'amex_statement_import', status: 'processing', createdAt: at, source: { key: 'original.pdf' }, textractJobId: 'native' },
  { PK: 'BULK_EDIT#owner', SK: 'OP#op', entityType: 'bulk_edit_operation', expiresAt: 1, payload: { operationId: 'op', owner: 'owner', status: 'pending', createdAt: at, expiresAt: 1, events: [{ id: 'event', previousCategoryId: null, nextCategoryId: 'food' }] } },
  { PK: 'USER#owner', SK: 'MONTHLY_CLOSE#2026-09', entityType: 'monthly_close_report', status: 'prepared', preparedAt: at, email: { html: '<html/>', text: 'original', subject: 'original' }, contentSha256: 'original' },
  { PK: 'USER#owner', SK: 'PUSH#sub', entityType: 'push_subscription', subscriptionId: 'sub', active: true, endpoint: 'https://native.example/sub', keys: { auth: 'native', p256dh: 'native' }, createdAt: at },
  { PK: 'USER#owner', SK: 'ASSISTANT_THREAD#thread', entityType: 'assistant_thread', sessionId: 'thread', title: 'original', expiresAt: 1, createdAt: at, updatedAt: at },
];
let sql: PGlite, pool: TransactionPool;
beforeAll(async () => { sql = new PGlite(); for (const ddl of SCHEMA_STATEMENTS) await sql.query(ddl);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) }; }, 30_000);
afterAll(async () => sql.close());
describe('operational projection and recovery', () => {
  it('replays every operational family, retains complete envelopes and removes rows with tombstones even after stale INSERT delivery', async () => {
    for (const original of records) {
      const item = { ...original, unknownField: { retained: [0, null, false, 'original'] } };
      let current: SourceItem | undefined = item;
      const read = async () => current;
      for (let i = 0; i < 2; i++) await reconcileKey(pool, read, item);
      const table = entityForKey(item)!;
      const rows = (await sql.query(`SELECT * FROM olbia.${table} WHERE source_pk=$1 AND source_sk=$2`, [item.PK, item.SK])).rows;
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ source_item: item });
      expect(await verifyKey(pool, read, item)).toBe('equal');
      current = undefined;
      const result = await processStream([{ eventName: 'INSERT', dynamodb: { Keys: { PK: { S: item.PK }, SK: { S: item.SK } }, SequenceNumber: 'old' } } as never], key => reconcileKey(pool, read, key));
      expect(result.batchItemFailures).toEqual([]);
      expect((await sql.query(`SELECT * FROM olbia.${table} WHERE source_pk=$1 AND source_sk=$2`, [item.PK, item.SK])).rows).toEqual([]);
      expect(await verifyKey(pool, read, item)).toBe('equal');
    }
  });
  it('preserves bulk apply/undo history after physical TTL removal without confusing the preview deadline', async () => {
    const original = records.find(item => item.PK.startsWith('BULK_EDIT#'))!; let current = original;
    const read = async () => current;
    await reconcileKey(pool, read, original);
    for (const state of ['applied', 'undone']) {
      const { expiresAt: _ttl, ...rest } = current;
      current = { ...rest, payload: { ...(rest.payload as object), status: state, [state === 'applied' ? 'appliedAt' : 'undoneAt']: at } };
      await reconcileKey(pool, read, current);
      expect((await sql.query('SELECT status,expires_at,payload FROM olbia.bulk_edit_operations')).rows).toEqual([{ status: state, expires_at: null, payload: current.payload }]);
      expect(await verifyKey(pool, read, current)).toBe('equal');
    }
  });
  it('converges workflow state updates, TTL renewal/removal and lost commit replay; partial SQL failure preserves last good state', async () => {
    for (const original of records.filter(item => ['ingestion_exceptions', 'ingestion_retries', 'import_records', 'delivery_records', 'assistant_threads'].includes(entityForKey(item)!))) {
      let current = original; const read = async () => current;
      await reconcileKey(pool, read, original);
      current = { ...original, expiresAt: 2000000000, status: 'sent', updatedAt: at,
        ...(original.payload ? { payload: { ...(original.payload as object), retry: { status: 'completed', completedAt: at } } } : {}) };
      const interrupted: TransactionPool = { transaction: callback => sql.transaction(async client => { await callback(client as unknown as SqlClient); throw new Error('before commit'); }) };
      await expect(reconcileKey(interrupted, read, current)).rejects.toThrow('before commit');
      expect(await verifyKey(pool, async () => original, original)).toBe('equal');
      await reconcileKey(pool, read, current); await reconcileKey(pool, read, current);
      expect(await verifyKey(pool, read, current)).toBe('equal');
      const { expiresAt: _ttl, ...rest } = current; current = rest;
      await reconcileKey(pool, read, current); expect(await verifyKey(pool, read, current)).toBe('equal');
    }
  });
  it('rejects malformed TTL and key mismatches instead of coercing them or replacing prior retained content', () => {
    expect(() => projectRows(records.at(-1)!, { ...records.at(-1)!, expiresAt: 1.5 })).toThrow('Invalid projection integer');
    expect(() => projectRows(records[0], { ...records[0], PK: 'other' })).toThrow('key mismatch');
    expect(entityForKey({ PK: 'USER#owner', SK: 'NATIVE_MEMORY#event' })).toBeUndefined();
  });
});

// DSQL snapshot/write-conflict model forces old current-source reads to commit last.
class OperationalOccPool implements TransactionPool {
  checkpoint?: { generation: string; hash: unknown; deleted: unknown };
  retries = 0;
  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    for (;;) {
      const snapshot = this.checkpoint; let next = snapshot;
      const value = await callback({ query: async (statement, args = []) => {
        if (statement.startsWith('SELECT generation')) return { rows: snapshot ? [{ generation: snapshot.generation }] : [] };
        if (statement.startsWith('UPDATE olbia.projection_state') || statement.startsWith('INSERT INTO olbia.projection_state'))
          next = { generation: String(args[2]), hash: args[3], deleted: args[5] };
        return { rows: [] };
      } });
      if (snapshot !== this.checkpoint) { this.retries++; continue; }
      this.checkpoint = next; return value;
    }
  }
}
describe('operational concurrent backfill', () => {
  for (const original of records) it(`rereads latest ${entityForKey(original)} after concurrent update, expiry renewal or deletion`, async () => {
    for (const deleted of [false, true]) {
      const occ = new OperationalOccPool(); let live: SourceItem | undefined = original;
      await reconcileKey(occ, async () => live, original);
      let releaseRead!: () => void, releaseResume!: () => void, first = true;
      const read = new Promise<void>(resolve => { releaseRead = resolve; });
      const resume = new Promise<void>(resolve => { releaseResume = resolve; });
      const stale = reconcileKey(occ, async () => {
        const snapshot = live;
        if (first) { first = false; releaseRead(); await resume; }
        return snapshot;
      }, original);
      await read; live = deleted ? undefined : { ...original, expiresAt: 2000000000, updatedAt: at, unknownTransition: 'retained' };
      await reconcileKey(occ, async () => live, original); const acceptedHash = occ.checkpoint?.hash;
      releaseResume(); await stale;
      expect(occ.retries).toBe(1); expect(occ.checkpoint).toMatchObject({ hash: acceptedHash, deleted });
    }
  });
});
