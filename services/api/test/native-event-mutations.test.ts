import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMsiSchedule, markInstallmentSpent } from '@finance/domain';
import { readLedgerDetail } from '../../ledger/src/dsql/ledger-reads.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { nativeFixture } from './fixtures/native-ledger.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let mutations: typeof import('../src/events/mutations.js');
let categories: typeof import('../src/categories/service.js');
const patch = (id: string, action: Record<string, unknown>) => mutations.patchEvent(id, 'owner', JSON.stringify(action));
beforeAll(async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true'); vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  mutations = await import('../src/events/mutations.js'); categories = await import('../src/categories/service.js');
}, 30_000);
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
beforeEach(() => fixture.reset());

describe('actual event edits on the native ledger', () => {
  it('keeps full history and original warnings through category, tags, personal zero, verify, reject and clear actions', async () => {
    const id = await fixture.create({ status: 'needs_review', parseWarnings: ['Original parser warning'] });
    const original = (await readLedgerDetail(fixture.pool, id))!.observations;
    await patch(id, { action: 'set_category', categoryId: 'shopping', updateRule: true });
    await patch(id, { action: 'set_tags', tags: ['Shared', ' Travel ', 'shared'] });
    const shared = await patch(id, { action: 'set_personal_amount', personalAmountMinor: 0 });
    expect(shared).toMatchObject({ personalAmountMinor: 0, categoryId: 'shopping', tags: ['shared', 'travel'] });
    expect(shared!.revisions).toHaveLength(3); expect(shared!.observations).toEqual(original);
    expect(await categories.listMerchantRules()).toHaveLength(1);
    await patch(id, { action: 'verify' });
    await patch(id, { action: 'clear_personal_amount' });
    const rejected = await patch(id, { action: 'reject' });
    expect(rejected).toMatchObject({ status: 'rejected', parseWarnings: [], personalAmountMinor: undefined });
    expect(rejected!.revisions).toHaveLength(6); expect(rejected!.observations).toEqual(original);
    const before = await fixture.snapshot();
    await patch(id, { action: 'reject' }); await patch(id, { action: 'clear_personal_amount' });
    await patch(id, { action: 'set_tags', tags: ['shared', 'travel'] });
    expect(await fixture.snapshot()).toEqual(before);
    expect((await fixture.sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
  });
  it('rolls back all category/history changes when the requested merchant rule fails', async () => {
    const id = await fixture.create({ categoryId: 'otros' }); const before = await fixture.snapshot();
    await expect(categories.setEventCategory(id, 'owner', 'shopping', { updateRule: true, source: 'invalid' as never })).rejects.toThrow('Origen');
    expect(await fixture.snapshot()).toEqual(before);
  });
  it('rejects pending foreign financial edits while allowing rejection and independent tags', async () => {
    const id = await fixture.create({ status: 'pending_foreign', amount: { amountMinor: 5000, currency: 'USD' } });
    for (const action of [{ action: 'verify' }, { action: 'set_personal_amount', personalAmountMinor: 0 }, { action: 'set_msi', months: 3 }])
      await expect(patch(id, action)).rejects.toThrow(/MXN/);
    await patch(id, { action: 'set_tags', tags: ['foreign'] });
    expect(await patch(id, { action: 'reject' })).toMatchObject({ status: 'rejected', tags: ['foreign'], amount: { currency: 'USD' } });
  });
  it('sets, cancels, completes and clears MSI while preserving confirmed source evidence and Mi parte exclusions', async () => {
    const id = await fixture.create();
    await patch(id, { action: 'set_msi', months: 3 });
    await expect(patch(id, { action: 'set_personal_amount', personalAmountMinor: 0 })).rejects.toThrow('MSI');
    await patch(id, { action: 'cancel_msi_remaining' });
    expect((await readLedgerDetail(fixture.pool, id))!.msi).toMatchObject({ status: 'cancelled' });
    await patch(id, { action: 'clear_msi' });
    await patch(id, { action: 'set_personal_amount', personalAmountMinor: 0 });
    await expect(patch(id, { action: 'set_msi', months: 3 })).rejects.toThrow('total pagado');
    await patch(id, { action: 'clear_personal_amount' });
    const plan = buildMsiSchedule({ principalMinor: 10000, months: 3, startMonth: '2026-10', origin: 'statement_unplanned', needsScheduleCompletion: true });
    await mutations.persistEventMsi(id, 'owner', undefined, plan, 'Original plan');
    const completed = await patch(id, { action: 'complete_msi_schedule', months: 4, startMonth: '2026-09' });
    expect(completed!.msi).toMatchObject({ months: 4, origin: 'manual' });
    expect((completed!.msi as Record<string, unknown>).needsScheduleCompletion).toBeUndefined();
  });
  it('requires native bank coordinates when recording an MSI confirmation through the actual mutation service', async () => {
    const id = await fixture.create(); const at = '2026-10-02T12:00:00.123Z', hash = 'a'.repeat(64);
    await fixture.sql.query(`INSERT INTO olbia.bank_imports
      (kind,content_sha256,owner,status,created_at,evidence_bucket,evidence_key,evidence_content_type)
      VALUES ('amex_statement',$1,'owner','failed',$2,'evidence','original.pdf','application/pdf')`, [hash, at]);
    await fixture.sql.query(`INSERT INTO olbia.bank_import_rows
      (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,row_kind)
      VALUES ('amex_statement',$1,0,'row-identity','2026-10-02','Original',3333,'matched','msi')`, [hash]);
    const plan = markInstallmentSpent(buildMsiSchedule({ principalMinor: 10000, months: 3, startMonth: '2026-10', origin: 'manual' }),
      1, { amountMinor: 3333, confirmedAt: at, evidenceObservationId: 'row-identity' });
    const before = await fixture.snapshot();
    await expect(mutations.persistEventMsi(id, 'owner', undefined, plan, 'Confirmation')).rejects.toThrow();
    expect(await fixture.snapshot()).toEqual(before);
    await mutations.persistEventMsi(id, 'owner', undefined, plan, 'Confirmation', [
      { installmentIndex: 1, kind: 'amex_statement', contentSha256: hash, rowPosition: 0 },
    ]);
    await patch(id, { action: 'set_msi', months: 4, startMonth: '2026-09' });
    expect((await fixture.sql.query('SELECT evidence_content_sha256,evidence_row_position FROM olbia.installment_entries WHERE installment_index=1')).rows)
      .toEqual([{ evidence_content_sha256: hash, evidence_row_position: 0 }]);
  });
  it('retains deferral history, refuses absent/invalid IDs and rolls back an edit if audit insertion fails', async () => {
    const id = await fixture.create();
    expect(await mutations.markDeferredMsi(id, 'owner', 'original-deferral')).toBe(true);
    expect(await mutations.markDeferredMsi(id, 'owner', 'original-deferral')).toBe(false);
    expect(await patch('invalid-id', { action: 'reject' })).toBeUndefined();
    expect(await categories.setEventCategory('invalid-id', 'owner', 'shopping')).toBeUndefined();
    const before = await fixture.snapshot();
    const transaction = fixture.pool.transaction.bind(fixture.pool);
    const fault = vi.spyOn(fixture.pool, 'transaction').mockImplementation(fn => transaction(client => fn({ query: (statement, values) => {
      if (statement.startsWith('INSERT INTO olbia.ledger_revisions')) throw new Error('Interrupted revision');
      return client.query(statement, values);
    } })));
    try { await expect(patch(id, { action: 'set_tags', tags: ['temporary'] })).rejects.toThrow('Interrupted revision'); }
    finally { fault.mockRestore(); }
    expect(await fixture.snapshot()).toEqual(before);
  });
});
