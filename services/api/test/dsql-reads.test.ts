import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { reconcileKey, type SqlClient, type TransactionPool } from '../../ledger/src/dsql/projection.js';
import { TABLE_NAMES, type SourceItem } from '../../ledger/src/dsql/model.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';
const { readSqlFeed, readSqlDetail } = await import('../src/events/sql-reads.js');
const { feedFromPayloads } = await import('../src/events/month-feed.js');
const { readSourceDetail, readCurrentMovementPayloads } = await import('../src/events/source-reads.js');
const { selectLedgerRead, samePublicResult, ledgerReadMode } = await import('../src/events/read-selection.js');
const { summarizeMonthFeed } = await import('../src/months/summary.js');

type Payload = Record<string, unknown>;
const movement = (id: string, patch: Payload = {}): Payload => ({
  id, institution: 'santander_mx', eventType: 'card_purchase', status: 'accepted',
  amount: { amountMinor: 40000, currency: 'MXN' }, merchantRaw: 'Actual source pattern',
  receivedAt: '2026-10-01T02:00:00.123Z', source: { bucket: 'original', key: `email/${id}`, contentType: 'message/rfc822' }, ...patch,
});
const msi = (month: string) => ({ months: 2, principalMinor: 60000, cuotaMinor: 30000, status: 'active',
  installments: [{ index: 1, month, amountMinor: 30000, status: 'spent' },
    { index: 2, month: '2026-10', amountMinor: 30000, status: 'committed' }] });
let sql: PGlite;
let pool: TransactionPool;
const write = async (payload: Payload, sk = 'EVENT', id = String(payload.id)) => {
  const item: SourceItem = { PK: `EVENT#${id}`, SK: sk, payload };
  await reconcileKey(pool, async () => item, item);
};
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) };
}, 30_000);
beforeEach(async () => { await sql.exec(`TRUNCATE olbia.projection_state,${TABLE_NAMES.map(table => `olbia.${table}`).join(',')}`); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await sql.close(); });

describe('DSQL public ledger reads', () => {
  it('preserves month boundaries, states, Mi parte, MSI spent/committed semantics and the existing range order', async () => {
    const items = [
      movement('zero', { personalAmountMinor: 0, tags: ['shared'] }),
      movement('pending', { status: 'pending_foreign', amount: { amountMinor: 1200, currency: 'USD' } }),
      movement('rejected', { status: 'rejected' }),
      movement('deferred', { status: 'deferred_msi' }),
      movement('prior', { receivedAt: '2026-08-01T12:00:00Z', msi: msi('2026-09') }),
      movement('future-index', { receivedAt: '2026-11-01T12:00:00Z', msi: msi('2026-09') }),
      movement('outside-window', { receivedAt: '2024-08-01T12:00:00Z', msi: msi('2026-09') }),
      movement('october', { receivedAt: '2026-10-01T06:00:00Z' }),
    ];
    for (const payload of items) await write(payload);
    const september = await readSqlFeed(['2026-09'], sql);
    expect(september.events.map(event => event.id)).toEqual(['zero', 'rejected', 'pending', 'deferred']);
    expect(september.msiRelated.map(event => event.id)).toEqual(['prior', 'future-index']);
    expect(september).toEqual(feedFromPayloads(['2026-09'], items));
    expect(await readSqlFeed(['2026-09', '2026-10', '2026-09'], sql)).toEqual(feedFromPayloads(['2026-09', '2026-10'], items));
    expect(await readSqlFeed(['2030-01'], sql)).toEqual({ events: [], msiRelated: [] });
    expect(await readSqlFeed([], sql)).toEqual({ events: [], msiRelated: [] });
    const summary = summarizeMonthFeed('2026-09', { configured: true, incomeMinor: 100000, upcomingPayments: [] }, september, new Date('2026-09-30T20:00:00Z'));
    expect(summary.discretionarySpentMinor).toBe(0);
    expect(summary.msiSpentMinor).toBe(60000);
    expect(summary.spentMinor).toBe(60000);
  });

  it('loads detail, revisions and observations in source sort-key order and keeps evidence reachable', async () => {
    await write(movement('detail'));
    await write({ id: 'old', createdAt: '2026-09-01T12:00:00.001Z', changes: { tags: [] } }, 'REVISION#01', 'detail');
    await write({ id: 'new', createdAt: '2026-09-02T12:00:00.002Z', changes: { tags: ['work'] } }, 'REVISION#02', 'detail');
    await write({ id: 'observed', captureSource: 'bank_email', source: { bucket: 'original', key: 'bank-mail' } }, 'OBSERVATION#01', 'detail');
    const detail = await readSqlDetail('detail', sql);
    expect(detail).toMatchObject({ id: 'detail', hasRawEmail: true, observationCount: 1,
      revisions: [{ id: 'new' }, { id: 'old' }], observations: [{ id: 'observed' }] });
    expect(await readSqlDetail("missing' OR '1'='1", sql)).toBeUndefined();
  });

  it('returns confirmed creations, edits, month moves and deletions while SQL is behind, then selects SQL after convergence', async () => {
    const stale = movement('edited');
    await write(stale);
    const current = [movement('edited', { receivedAt: '2026-10-01T06:00:00Z', personalAmountMinor: 1000, tags: ['updated'] }), movement('new')];
    const report = vi.fn();
    const read = () => selectLedgerRead({ mode: 'guarded-sql', sql: () => readSqlFeed(['2026-09'], sql),
      source: async () => feedFromPayloads(['2026-09'], current), report });
    expect((await read()).events.map(event => event.id)).toEqual(['new']);
    expect(report).toHaveBeenLastCalledWith('mismatch', 'dynamodb');
    for (const payload of current) await write(payload);
    await read();
    expect(report).toHaveBeenLastCalledWith('equal', 'sql');
    const deleted = await selectLedgerRead({ mode: 'guarded-sql', sql: () => readSqlDetail('edited', sql), source: async () => undefined, report });
    expect(deleted).toBeUndefined();
    expect(report).toHaveBeenLastCalledWith('mismatch', 'dynamodb');
    const revised = { ...await readSqlDetail('new', sql), revisions: [{ id: 'just-confirmed' }] };
    expect(await selectLedgerRead({ mode: 'guarded-sql', sql: () => readSqlDetail('new', sql), source: async () => revised, report })).toEqual(revised);
    expect(report).toHaveBeenLastCalledWith('mismatch', 'dynamodb');
  });

  it('fails back on SQL errors, propagates source failures, and restores DynamoDB without connecting SQL', async () => {
    const source = vi.fn(async () => ({ amountMinor: 1 }));
    const unavailable = vi.fn(() => { throw new Error('private token/driver row'); });
    const report = vi.fn();
    expect(await selectLedgerRead({ mode: 'guarded-sql', sql: unavailable, source, report })).toEqual({ amountMinor: 1 });
    expect(report).toHaveBeenCalledWith('sql-error', 'dynamodb');
    expect(report.mock.calls.flat().join()).not.toContain('private');
    await expect(selectLedgerRead({ mode: 'guarded-sql', sql: source, source: async () => { throw new Error('source unavailable'); } })).rejects.toThrow('source unavailable');
    unavailable.mockClear();
    await selectLedgerRead({ mode: 'dynamodb', sql: unavailable, source });
    expect(unavailable).not.toHaveBeenCalled();
    vi.stubEnv('DSQL_LEDGER_READ_MODE', 'typo');
    expect(ledgerReadMode()).toBe('dynamodb');
    await selectLedgerRead({ mode: 'shadow', sql: source, source, report });
    expect(report).toHaveBeenLastCalledWith('equal', 'dynamodb');
    expect(samePublicResult({ a: null, b: 0 }, { b: 0, a: null })).toBe(true);
    expect(samePublicResult({ a: null }, {})).toBe(false);
    expect(samePublicResult([1, 2], [2, 1])).toBe(false);
  });

  it('paginates strong base-table scans through empty pages and source detail through all provenance pages', async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { PK: 'unrelated', SK: 'page' } } as never)
      .mockResolvedValueOnce({ Items: [{ payload: movement('latest') }] } as never);
    expect((await readCurrentMovementPayloads()).map(event => event.id)).toEqual(['latest']);
    expect(send.mock.calls.map(([command]) => command.input)).toMatchObject([
      { ConsistentRead: true, FilterExpression: 'begins_with(PK,:prefix) AND SK=:event' },
      { ConsistentRead: true, ExclusiveStartKey: { PK: 'unrelated', SK: 'page' } },
    ]);
    send.mockReset();
    send.mockResolvedValueOnce({ Items: [{ SK: 'REVISION#02', payload: { id: 'new' } }], LastEvaluatedKey: { PK: 'EVENT#latest', SK: 'REVISION#02' } } as never)
      .mockResolvedValueOnce({ Items: [{ SK: 'OBSERVATION#01', payload: { id: 'obs' } }, { SK: 'EVENT', payload: movement('latest') }] } as never);
    expect(await readSourceDetail('latest')).toMatchObject({ id: 'latest', revisions: [{ id: 'new' }], observations: [{ id: 'obs' }] });
    expect(send.mock.calls.map(([command]) => command.input)).toMatchObject([
      { ConsistentRead: true, ScanIndexForward: false }, { ConsistentRead: true, ExclusiveStartKey: { PK: 'EVENT#latest', SK: 'REVISION#02' } },
    ]);
  });
});
