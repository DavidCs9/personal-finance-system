import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { nativeFixture } from './fixtures/native-ledger.js';
import { appendLedgerObservation, insertLedgerRevision } from '../../ledger/src/dsql/ledger-writes.js';
import { saveNativeCapture } from '../../ledger/src/dsql/ledger-capture.js';
import { readLedgerMovements } from '../../ledger/src/dsql/ledger-reads.js';
import { reconcileKey } from '../../ledger/src/dsql/projection.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import type { ObservedEventInput } from '../../ledger/src/observed-events.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let readers: typeof import('../src/events/sql-reads.js');
let queries: typeof import('../src/events/queries.js');
let verification: typeof import('../src/events/native-verification.js');
let summarize: typeof import('../src/months/summary.js')['summarizeMonthFeed'];
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const movement = (n: number, patch: Partial<ObservedEventInput> = {}): Partial<ObservedEventInput> => ({
  id: uid(n), occurredAt: undefined, receivedAt: '2026-10-01T02:00:00.123Z',
  amount: { amountMinor: 40000, currency: 'MXN' }, ...patch,
});
const msi = (patch = {}) => ({ months: 2, principalMinor: 60000, cuotaMinor: 30000, origin: 'manual', status: 'active',
  installments: [{ index: 1, month: '2026-09', amountMinor: 30000, status: 'spent' },
    { index: 2, month: '2026-10', amountMinor: 30000, status: 'committed' }], ...patch });
const plan = { configured: true, incomeMinor: 100000, upcomingPayments: [] };
const now = new Date('2026-09-30T20:00:00Z');
const checkState = () => readLedgerMovements(fixture.pool).then(movements =>
  verification.verifyNativeLedgerState(fixture.pool, movements, id => readers.readSqlDetail(id, fixture.pool)));
beforeAll(async () => {
  vi.stubEnv('METADATA_TABLE_NAME', 'test-metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'test-evidence');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  readers = await import('../src/events/sql-reads.js'); queries = await import('../src/events/queries.js');
  verification = await import('../src/events/native-verification.js');
  summarize = (await import('../src/months/summary.js')).summarizeMonthFeed;
}, 30_000);
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql.exec('TRUNCATE olbia.movements');
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(new Error('Retired financial document path') as never);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });

describe('native SQL financial reads', () => {
  it('uses actual cuota relationships beyond 24 months, while preserving financial boundaries, statuses, personal zero and range order', async () => {
    for (const item of [movement(8, { personalAmountMinor: 0, tags: ['shared'] }),
      movement(7, { status: 'rejected' }), movement(6, { status: 'pending_foreign', amount: { amountMinor: 1200, currency: 'USD' } }),
      movement(5, { status: 'deferred_msi' }), movement(4, { receivedAt: '2026-08-01T12:00:00Z', msi: msi() }),
      movement(3, { receivedAt: '2020-08-01T12:00:00Z', msi: msi() }),
      movement(2, { receivedAt: '2026-11-01T12:00:00Z', msi: msi() }),
      movement(1, { receivedAt: '2026-10-01T06:00:00Z' })]) await fixture.create(item);
    const feed = await queries.listEventsForMonth('2026-09');
    expect(feed.events.map(event => event.id)).toEqual([8, 7, 6, 5].map(uid));
    expect(feed.msiRelated.map(event => event.id)).toEqual([4, 3, 2].map(uid));
    const range = await queries.listEventsForMonths(['2026-09', '2026-10', '2026-09']);
    expect(range.events.map(event => event.id)).toEqual([8, 7, 6, 5, 1].map(uid));
    expect(range.msiRelated.map(event => event.id)).toEqual([4, 3, 2].map(uid));
    expect(await queries.listEventsForMonths([])).toEqual({ events: [], msiRelated: [] });
    expect(await queries.listEventsForMonth('2030-01')).toEqual({ events: [], msiRelated: [] });
    const summary = summarize('2026-09', plan, feed, now);
    expect(summary).toMatchObject({ discretionarySpentMinor: 0, msiSpentMinor: 90000, spentMinor: 90000, uncertainMinor: 0 });
    expect(await verification.verifyNativeMonthSummary(fixture.pool, '2026-09', feed, summary)).toEqual({ mismatches: 0 });
    expect(await checkState()).toMatchObject({ movements: 8, observations: 8, plans: 3, mismatches: 0, unsupportedActiveCurrencies: 0 });
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });

  it('preserves audit order separately from capture order and keeps original evidence reachable after current edits', async () => {
    const id = await fixture.create(movement(1, { parseWarnings: ['Original warning'], source: { bucket: 'original', key: 'email/one',
      sha256: 'a'.repeat(64), contentType: 'message/rfc822' } }));
    const observed = randomUUID();
    await fixture.pool.transaction(async client => {
      await appendLedgerObservation(client, { id: observed, movementId: id, captureSource: 'apple_pay_shortcut',
        observedAt: '2026-10-02T12:00:00.000Z', reconciliationAt: '2026-08-01T12:00:00.000Z', institution: 'santander_mx',
        eventType: 'card_purchase', amount: { amountMinor: 1200, currency: 'USD' }, merchantRaw: 'Original foreign assertion',
        source: { kind: 'shortcut', note: 'original' }, parserVersion: 'shortcut-v1', parseWarnings: ['Capture warning'] });
      for (const [revision, createdAt] of [['old', '2026-09-01T12:00:00.001Z'], ['new', '2026-09-02T12:00:00.002Z']])
        await insertLedgerRevision(client, { id: revision, movementId: id, createdAt, changedBy: 'owner', changes: { tags: { next: [] } } });
      await client.query('UPDATE olbia.ledger_movements SET personal_amount_minor=0 WHERE id=$1', [id]);
    });
    const detail = await queries.getEventDetail(id);
    expect(detail).toMatchObject({ id, personalAmountMinor: 0, hasRawEmail: true, observationCount: 2,
      captureSources: ['email', 'apple_pay_shortcut'], revisions: [{ id: 'new' }, { id: 'old' }] });
    expect((detail!.observations as Record<string, unknown>[]).map(row => row.id)).toEqual([
      (await readLedgerMovements(fixture.pool))[0].primaryObservationId, observed,
    ]);
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: { transformToString: async () => 'original email' } } as never);
    expect(await queries.readRawEmail(id)).toBe('original email');
    expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'original', Key: 'email/one' });
    expect(await checkState()).toMatchObject({ details: 1, observations: 2, revisions: 2, mismatches: 0 });
    expect(await queries.getEventDetail("missing' OR '1'='1")).toBeUndefined();
    expect(await queries.getEventDetail(uid(999))).toBeUndefined();
  });

  it('serves native-only creations, edits and month moves while ignoring stale recovery records and old mode flags', async () => {
    const id = await fixture.create(movement(1));
    const frozen = { PK: `EVENT#${id}`, SK: 'EVENT', reconciliationAt: '2026-10-01T02:00:00.123Z',
      payload: { id, receivedAt: '2026-10-01T02:00:00.123Z',
      amount: { amountMinor: 999999, currency: 'MXN' }, eventType: 'card_purchase', status: 'accepted', merchantRaw: 'Frozen', institution: 'santander_mx' } };
    await reconcileKey(fixture.pool, async () => frozen, frozen);
    await fixture.pool.query('UPDATE olbia.ledger_movements SET personal_amount_minor=0,received_at=$2 WHERE id=$1', [id, '2026-10-01T06:00:00Z']);
    const next = await fixture.create(movement(2));
    for (const mode of ['dynamodb', 'shadow', 'guarded-sql', 'invalid']) {
      vi.stubEnv('DSQL_LEDGER_READ_MODE', mode);
      expect((await queries.listEventsForMonth('2026-09')).events.map(row => row.id)).toEqual([next]);
      expect((await queries.listEventsForMonth('2026-10')).events).toMatchObject([{ id, personalAmountMinor: 0, amount: { amountMinor: 40000 } }]);
    }
    expect(await checkState()).toMatchObject({ movements: 2, mismatches: 0 });
    expect((await fixture.sql.query<{ payload: unknown }>('SELECT payload FROM olbia.movements')).rows[0].payload).toEqual(frozen.payload);
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });

  it('propagates native SQL failures without consulting recovery documents or financial SDK fallbacks', async () => {
    const id = await fixture.create(movement(1));
    vi.spyOn(fixture.pool, 'query').mockRejectedValue(new Error('SQL unavailable'));
    await expect(queries.listEventsForMonth('2026-09')).rejects.toThrow('SQL unavailable');
    await expect(queries.getEventDetail(id)).rejects.toThrow('SQL unavailable');
    await expect(queries.allStoredEvents()).rejects.toThrow('SQL unavailable');
    vi.mocked(fixture.pool.query).mockClear();
    expect(await queries.getEventDetail('invalid-id')).toBeUndefined();
    expect(await queries.listEventsForMonths([])).toEqual({ events: [], msiRelated: [] });
    expect(fixture.pool.query).not.toHaveBeenCalled();
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
  });

  it('independently detects missing history, wrong mapped money, changed quota totals and removed required relationships', async () => {
    const schedule = msi();
    const id = await fixture.create(movement(1, { msi: msi({ installments: [
      { ...schedule.installments[0], occurredOn: '2026-09-01', confirmedAt: '2026-09-01T12:00:00.123Z' }, schedule.installments[1],
    ] }) }));
    expect(await checkState()).toMatchObject({ mismatches: 0 });
    const movements = await readLedgerMovements(fixture.pool);
    const actual = (await readers.readSqlDetail(id, fixture.pool))!;
    expect((await verification.verifyNativeLedgerState(fixture.pool, movements, async () => ({ ...actual, observations: [] }))).mismatches).toBeGreaterThan(0);
    expect((await verification.verifyNativeLedgerState(fixture.pool, movements, async () => ({ ...actual, amount: { amountMinor: 1, currency: 'MXN' } }))).mismatches).toBeGreaterThan(0);
    const feed = await readers.readSqlFeed(['2026-09'], fixture.pool);
    const summary = summarize('2026-09', plan, feed, now);
    expect((await verification.verifyNativeMonthSummary(fixture.pool, '2026-09', feed, { ...summary, spentMinor: 0 })).mismatches).toBeGreaterThan(0);
    expect((await verification.verifyNativeMonthSummary(fixture.pool, '2026-09', { events: [], msiRelated: [] }, summary)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('ALTER TABLE olbia.installment_entries DROP CONSTRAINT installment_entries_evidence_fk');
    try { expect((await checkState()).mismatches).toBeGreaterThan(0); }
    finally { await fixture.sql.query(`ALTER TABLE olbia.installment_entries ADD CONSTRAINT installment_entries_evidence_fk
      FOREIGN KEY (evidence_import_kind,evidence_content_sha256,evidence_row_position)
      REFERENCES olbia.bank_import_rows(kind,content_sha256,position) MATCH FULL`); }
  });

  it('counts review uncertainty and spent cuotas while excluding rejected/deferred plans and incomplete commitments', async () => {
    await fixture.create(movement(1, { status: 'needs_review', personalAmountMinor: 1000 }));
    await fixture.create(movement(2, { status: 'needs_review', receivedAt: '2020-01-01T12:00:00Z', msi: msi({ needsScheduleCompletion: true }) }));
    await fixture.create(movement(3, { status: 'rejected', msi: msi() }));
    await fixture.create(movement(4, { status: 'deferred_msi', msi: msi() }));
    const cancelled = msi();
    await fixture.create(movement(5, { msi: msi({ status: 'cancelled', installments: [
      cancelled.installments[0], { ...cancelled.installments[1], status: 'cancelled' },
    ] }) }));
    const september = await queries.listEventsForMonth('2026-09');
    const summary = summarize('2026-09', plan, september, now);
    expect(summary).toMatchObject({ spentMinor: 61000, uncertainMinor: 31000 });
    expect(await verification.verifyNativeMonthSummary(fixture.pool, '2026-09', september, summary)).toEqual({ mismatches: 0 });
    const october = await queries.listEventsForMonth('2026-10');
    const later = summarize('2026-10', plan, october, now);
    expect(later.msiCommittedMinor).toBe(0);
    expect(await verification.verifyNativeMonthSummary(fixture.pool, '2026-10', october, later)).toEqual({ mismatches: 0 });
    expect(await checkState()).toMatchObject({ mismatches: 0 });
  });

  it('keeps pending foreign evidence valid but fails verification for an unsupported active foreign amount', async () => {
    const id = await fixture.create(movement(1, { status: 'pending_foreign', amount: { amountMinor: 1200, currency: 'USD' } }));
    expect(await checkState()).toMatchObject({ mismatches: 0, unsupportedActiveCurrencies: 0 });
    await fixture.pool.query("UPDATE olbia.ledger_movements SET status='accepted' WHERE id=$1", [id]);
    expect(await checkState()).toMatchObject({ mismatches: 1, unsupportedActiveCurrencies: 1 });
  });

  it('opens the linked bank email after shortcut-first promotion and preserves generic manual source access', async () => {
    const at = '2026-10-02T12:00:00.123Z';
    const apple: ObservedEventInput = { id: uid(1), institution: 'santander_mx', eventType: 'card_purchase',
      status: 'pending_foreign', amount: { amountMinor: 1200, currency: 'USD' }, merchantRaw: 'Adobe Systems',
      occurredAt: at, receivedAt: at, ingestedAt: at, parserVersion: 'shortcut', parseWarnings: [],
      source: { bucket: 'original', key: 'shortcut.json', sha256: 'a'.repeat(64), contentType: 'application/json' } };
    await fixture.pool.transaction(client => saveNativeCapture(client, { token: 'shortcut', captureSource: 'apple_pay_shortcut', event: apple, reconciliationAt: at }));
    const posted = { ...apple, id: uid(2), status: 'accepted', amount: { amountMinor: 24000, currency: 'MXN' },
      parserVersion: 'bank-email', source: { ...apple.source, key: 'posted.eml', contentType: 'message/rfc822' } };
    const result = await fixture.pool.transaction(client => saveNativeCapture(client, { token: 'email', captureSource: 'email', event: posted, reconciliationAt: at }));
    expect(result).toMatchObject({ eventId: uid(1), reconciled: true });
    const detail = await queries.getEventDetail(uid(1));
    expect(detail).toMatchObject({ captureSource: 'apple_pay_shortcut', hasRawEmail: true, source: { key: 'shortcut.json' }, observationCount: 2 });
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: { transformToString: async () => 'original source' } } as never);
    expect(await queries.readRawEmail(uid(1))).toBe('original source');
    expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'original', Key: 'posted.eml' });
    const manual = { ...posted, id: uid(3), merchantRaw: 'Manual capture', source: { ...apple.source, key: 'manual.json' } };
    await fixture.pool.transaction(client => saveNativeCapture(client, { token: 'manual', captureSource: 'manual', event: manual, reconciliationAt: at }));
    expect(await queries.readRawEmail(uid(3))).toBe('original source');
    expect(send.mock.calls[1][0].input).toMatchObject({ Bucket: 'original', Key: 'manual.json' });
    expect(await checkState()).toMatchObject({ movements: 2, observations: 3, mismatches: 0 });
    await fixture.pool.query(`UPDATE olbia.ledger_observations SET evidence_bucket=NULL,evidence_key=NULL,
      evidence_sha256=NULL,evidence_content_type=NULL WHERE movement_id=$1 AND capture_source='email'`, [uid(1)]);
    await expect(queries.readRawEmail(uid(1))).rejects.toThrow('Missing raw source');
    expect(send).toHaveBeenCalledTimes(2);
  });
});


it('stages old financial readers unchanged before activation and refuses every old path after marker 14', async () => {
  const {withStoreClient} = await import('../../ledger/src/dsql/store.js');
  const queries = await import('../src/events/queries.js');
  const {readSourceFeed} = await import('../src/events/source-reads.js');
  await write(movement('guarded'));
  const before = (await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows;
  expect(await readSqlFeed(['2026-09'], sql)).toMatchObject({events:[{id:'guarded'}]});
  expect(await readSqlDetail('guarded', sql)).toMatchObject({id:'guarded'});
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  vi.stubEnv('DSQL_LEDGER_READ_MODE','guarded-sql');
  const sdk = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async command => {
    const input = (command as {input:{ProjectionExpression?:string}}).input;
    return {Items:[input.ProjectionExpression === 'payload' ? {payload:movement('guarded')} :
      {PK:'EVENT#guarded',SK:'EVENT',payload:movement('guarded')}]} as never;
  });
  await withStoreClient(sql, async () => {
    expect(await queries.allStoredEvents()).toHaveLength(1);
    expect(await readCurrentMovementPayloads()).toHaveLength(1);
  });
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  sdk.mockClear();
  const statements:string[] = [];
  const client:SqlClient = {query:(statement,values)=>{statements.push(statement);return sql.query(statement,values);}};
  await withStoreClient(client, async () => {
    for (const read of [()=>readSqlFeed(['2026-09'],client),()=>readSqlDetail('guarded',client),
      ()=>queries.allStoredEvents(),()=>queries.listEventsForMonthsDynamo(['2026-09']),
      ()=>readCurrentMovementPayloads(),()=>readSourceFeed(['2026-09']),()=>readSourceDetail('guarded'),
      ()=>queries.getEventDetailDynamo('guarded'),()=>queries.listEventsForMonths(['2026-09']),()=>queries.getEventDetail('guarded')])
      await expect(read()).rejects.toMatchObject({name:'MigrationPausedException'});
  });
  expect(sdk).not.toHaveBeenCalled();
  expect(statements.every(statement=>statement==='SELECT version FROM olbia.schema_migrations WHERE version=14')).toBe(true);
  expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows).toEqual(before);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=14');
});
