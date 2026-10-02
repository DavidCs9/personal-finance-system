import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeFixture } from './fixtures/native-ledger.js';
import { readLedgerDetail } from '../../ledger/src/dsql/ledger-reads.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let runTagMutationTool: typeof import('../src/agent/tag-mutation-tools.js').runTagMutationTool;
let readBulkOperation: typeof import('../src/events/bulk-storage.js').readBulkOperation;
beforeAll(async () => {
  vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  ({ runTagMutationTool } = await import('../src/agent/tag-mutation-tools.js'));
  ({ readBulkOperation } = await import('../src/events/bulk-storage.js'));
}, 30_000);
beforeEach(() => fixture.reset());
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
const capture = { occurredAt: '2026-08-22T12:00:00.000Z', receivedAt: '2026-08-22T12:00:01.000Z',
  amount: { amountMinor: 30694, currency: 'MXN' } };
const operationId = (result: unknown) => (result as { operationId: string }).operationId;

describe('tag and category mutation Gateway tools on native SQL', () => {
  it('freezes owner-scoped tag intent and routes apply/undo with complete audit history', async () => {
    const id = await fixture.create({ ...capture, merchantRaw: 'Panda Express' });
    const result = await runTagMutationTool('owner-1', 'preview_tag_edit', { eventId: id, addTags: ['Viaje:Végas'] });
    expect(result).toMatchObject({ dryRun: true, movementCount: 1, change: { addTags: ['viaje:vegas'] } });
    expect(result).not.toHaveProperty('change.categoryId');
    expect(await readBulkOperation('owner-1', operationId(result))).toMatchObject({ owner: 'owner-1',
      selection: { eventIds: [id] }, change: { addTags: ['viaje:vegas'] } });
    expect(await readBulkOperation('other-owner', operationId(result))).toBeUndefined();
    await expect(runTagMutationTool('other-owner', 'apply_tag_edit', { operationId: operationId(result) })).rejects.toThrow();
    await runTagMutationTool('owner-1', 'apply_tag_edit', { operationId: operationId(result) });
    expect(await readLedgerDetail(fixture.pool, id)).toMatchObject({ tags: ['viaje:vegas'],
      revisions: [{ source: 'assistant_chat_tag_edit' }] });
    await runTagMutationTool('owner-1', 'undo_tag_edit', { operationId: operationId(result) });
    expect(await readLedgerDetail(fixture.pool, id)).toMatchObject({ tags: [], revisions: [{}, {}] });
  });

  it('requires a precise tag selector and honours merchant/source tag filters', async () => {
    await expect(runTagMutationTool('owner-1', 'preview_tag_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', addTags: ['viaje:vegas'],
    })).rejects.toThrow(/nunca sólo fechas/);
    const first = await fixture.create({ ...capture, merchantRaw: 'UBER   EATS', tags: ['viaje:vegas'] });
    await fixture.create({ ...capture, merchantRaw: 'Uber Eats', tags: ['trabajo'] });
    await fixture.create({ ...capture, merchantRaw: 'Padel House', tags: ['viaje:vegas'] });
    const result = await runTagMutationTool('owner-1', 'preview_tag_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', addTags: ['ciudad:cdmx'],
      merchantRaw: 'uber eats', sourceTags: ['Viaje:Végas'],
    });
    expect(result).toMatchObject({ affected: [{ id: first }], movementCount: 1 });
    expect(await readBulkOperation('owner-1', operationId(result))).toMatchObject({ selection: {
      merchantRaw: 'uber eats', sourceTags: ['viaje:vegas'],
    } });
  });

  it('requires real preview operation identities for apply and undo', async () => {
    for (const tool of ['apply_tag_edit', 'undo_tag_edit', 'apply_category_edit', 'undo_category_edit'])
      await expect(runTagMutationTool('owner-1', tool, { operationId: ' ' })).rejects.toThrow(/operationId/);
    for (const tool of ['apply_tag_edits', 'apply_category_edits'])
      await expect(runTagMutationTool('owner-1', tool, {})).rejects.toThrow(/operationIds/);
  });

  it('freezes category-only intent and applies/undoes without changing tags or learning a merchant rule', async () => {
    const id = await fixture.create({ ...capture, merchantRaw: 'Panda Express', categoryId: 'otros', tags: ['viaje:vegas'] });
    const result = await runTagMutationTool('owner-1', 'preview_category_edit', {
      categoryId: 'shopping', eventId: id, addTags: ['should-be-ignored'],
    });
    expect(result).toMatchObject({ dryRun: true, movementCount: 1, change: { categoryId: 'shopping' },
      affected: [{ id, merchantRaw: 'Panda Express' }] });
    expect(result).not.toHaveProperty('change.addTags');
    expect(await readBulkOperation('owner-1', operationId(result))).toMatchObject({ owner: 'owner-1',
      change: { categoryId: 'shopping' }, selection: { eventIds: [id] }, events: [{
        previousTags: ['viaje:vegas'], nextTags: ['viaje:vegas'], previousCategoryId: 'otros', nextCategoryId: 'shopping',
      }] });
    await runTagMutationTool('owner-1', 'apply_category_edit', { operationId: operationId(result) });
    expect(await readLedgerDetail(fixture.pool, id)).toMatchObject({ categoryId: 'shopping', tags: ['viaje:vegas'] });
    await runTagMutationTool('owner-1', 'undo_category_edit', { operationId: operationId(result) });
    expect(await readLedgerDetail(fixture.pool, id)).toMatchObject({ categoryId: 'otros', tags: ['viaje:vegas'] });
    expect((await fixture.sql.query('SELECT * FROM olbia.merchant_rules')).rows).toEqual([]);
  });

  it('requires a precise category selector and honours merchant/source filters', async () => {
    await expect(runTagMutationTool('owner-1', 'preview_category_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', categoryId: 'shopping',
    })).rejects.toThrow(/nunca sólo fechas/);
    const first = await fixture.create({ ...capture, merchantRaw: 'UBER   EATS' });
    await fixture.create({ ...capture, merchantRaw: 'Uber Eats', categoryId: 'shopping' });
    await fixture.create({ ...capture, merchantRaw: 'Padel House' });
    const result = await runTagMutationTool('owner-1', 'preview_category_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', categoryId: 'shopping', merchantRaw: 'uber eats', onlyUncategorized: true,
    });
    expect(result).toMatchObject({ affected: [{ id: first }], movementCount: 1 });
    expect(await readBulkOperation('owner-1', operationId(result))).toMatchObject({ selection: {
      merchantRaw: 'uber eats', onlyUncategorized: true,
    } });
  });

  it('rejects tools outside the dedicated mutation contract', async () => {
    await expect(runTagMutationTool('owner-1', 'set_category', {})).rejects.toThrow(/desconocida/);
  });
});
