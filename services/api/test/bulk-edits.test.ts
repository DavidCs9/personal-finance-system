import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeFixture } from './fixtures/native-ledger.js';
import { readLedgerDetail } from '../../ledger/src/dsql/ledger-reads.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let bulk: typeof import('../src/events/bulk-edits.js');
let storage: typeof import('../src/events/bulk-storage.js');
let mutations: typeof import('../src/events/mutations.js');
const now = new Date('2026-10-02T13:00:00Z');
const range = { fromDay: '2026-10-02', toDay: '2026-10-02', statuses: ['accepted'] as const };
const tagPreview = (ids: string[], addTags = ['travel'], removeTags: string[] = []) =>
  bulk.previewAgentTagEdit('owner', bulk.parseAgentTagEditInput({ eventIds: ids, addTags, removeTags }), now);
const categoryPreview = (ids: string[], categoryId = 'shopping') =>
  bulk.previewAgentCategoryEdit('owner', bulk.parseAgentCategoryEditInput({ eventIds: ids, categoryId }), now);
beforeAll(async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true'); vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  bulk = await import('../src/events/bulk-edits.js'); storage = await import('../src/events/bulk-storage.js');
  mutations = await import('../src/events/mutations.js');
}, 30_000);
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
beforeEach(() => fixture.reset());

describe('native bulk operations and audit', () => {
  it('validates bounded selection and normalizes changes without document concepts', () => {
    expect(bulk.parseBulkEditInput({ selection: range, change: { addTags: ['Viaje:Végas'] } }))
      .toEqual({ selection: range, change: { addTags: ['viaje:vegas'] } });
    for (const selection of [{ ...range, toDay: '2026-10-01' }, { ...range, statuses: ['rejected'] }])
      expect(() => bulk.parseBulkEditInput({ selection, change: { addTags: ['travel'] } })).toThrow();
    expect(() => bulk.parseAgentTagEditInput({ fromDay: range.fromDay, toDay: range.toDay, addTags: ['travel'] })).toThrow('nunca sólo fechas');
    expect(() => bulk.parseAgentCategoryEditInput({ fromDay: range.fromDay, toDay: range.toDay, categoryId: 'shopping' })).toThrow();
  });
  it('freezes eligible native members in canonical order, preserving personal zero, exclusions and immutable preview facts', async () => {
    const first = await fixture.create({ personalAmountMinor: 0, merchantRaw: 'First', occurredAt: '2026-10-02T11:00:00Z' });
    const second = await fixture.create({ tags: ['shared'], merchantRaw: 'Second' });
    await fixture.create({ status: 'rejected' }); await fixture.create({ status: 'needs_review' });
    await fixture.create({ occurredAt: '2026-10-03T12:00:00Z' });
    const preview = await bulk.previewBulkEdit('owner', { selection: range, change: { addTags: ['travel'] } }, now);
    expect(preview).toMatchObject({ movementCount: 2, amountMinor: 10000, affected: [{ id: first }, { id: second }] });
    const operation = await storage.readBulkOperation('owner', preview.operationId);
    expect(operation!.events).toMatchObject([{ previousTags: [], nextTags: ['travel'], amountMinor: 0 },
      { previousTags: ['shared'], nextTags: ['shared', 'travel'] }]);
    await mutations.patchEvent(first, 'owner', '{"action":"set_category","categoryId":"shopping"}');
    expect(await storage.readBulkOperation('owner', preview.operationId)).toEqual(operation);
    expect((await fixture.sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
  });
  it('applies and undoes mixed tags/categories once with deterministic FK-backed revisions and unchanged original observations', async () => {
    const id = await fixture.create({ categoryId: 'otros', tags: ['shared'] });
    const observations = (await readLedgerDetail(fixture.pool, id))!.observations;
    const preview = await bulk.previewBulkEdit('owner', { selection: range,
      change: { addTags: ['travel'], categoryId: 'shopping' } }, now);
    expect(await bulk.applyBulkEdit('owner', preview.operationId, 'owner', now)).toMatchObject({ status: 'applied' });
    const applied = await fixture.snapshot();
    await bulk.applyBulkEdit('owner', preview.operationId, 'owner', new Date('2027-01-01T12:00:00Z'));
    expect(await fixture.snapshot()).toEqual(applied);
    expect(await readLedgerDetail(fixture.pool, id)).toMatchObject({ categoryId: 'shopping', tags: ['shared', 'travel'] });
    await bulk.undoBulkEdit('owner', preview.operationId, 'owner', now);
    const undone = await fixture.snapshot(); await bulk.undoBulkEdit('owner', preview.operationId, 'owner', now);
    expect(await fixture.snapshot()).toEqual(undone);
    const detail = await readLedgerDetail(fixture.pool, id);
    expect(detail).toMatchObject({ categoryId: 'otros', tags: ['shared'] }); expect(detail!.observations).toEqual(observations);
    expect((detail!.revisions as Record<string, unknown>[]).map(r => r.id)).toEqual(expect.arrayContaining([
      `${preview.operationId}-apply-${id}`, `${preview.operationId}-undo-${id}`,
    ]));
  });
  it('enforces source tag/category/status preconditions, including missing values, without partial earlier edits', async () => {
    for (const changed of ['tags', 'category', 'status']) {
      await fixture.reset();
      const first = await fixture.create({ categoryId: 'otros', tags: ['shared'] });
      const second = await fixture.create({ categoryId: 'otros', tags: ['shared'] });
      const preview = await bulk.previewBulkEdit('owner', { selection: range,
        change: { addTags: ['travel'], categoryId: 'shopping' } }, now);
      if (changed === 'tags') await fixture.sql.query('DELETE FROM olbia.ledger_tags WHERE movement_id=$1', [second]);
      if (changed === 'category') await fixture.sql.query('UPDATE olbia.ledger_movements SET category_id=NULL WHERE id=$1', [second]);
      if (changed === 'status') await fixture.sql.query("UPDATE olbia.ledger_movements SET status='rejected' WHERE id=$1", [second]);
      const before = await fixture.snapshot();
      await expect(bulk.applyBulkEdit('owner', preview.operationId, 'owner', now)).rejects.toThrow('cambiaron');
      expect(await fixture.snapshot()).toEqual(before);
      expect((await readLedgerDetail(fixture.pool, first))!.tags).toEqual(['shared']);
    }
  });
  it('audits assistant tags and categories separately and never creates merchant rules', async () => {
    const id = await fixture.create({ categoryId: 'otros', tags: ['shared'] });
    const tags = await tagPreview([id]); const category = await categoryPreview([id]);
    await expect(bulk.applyAgentTagEdit('owner', category.operationId, now)).rejects.toThrow('tags');
    await expect(bulk.applyAgentCategoryEdit('owner', tags.operationId, now)).rejects.toThrow('categorías');
    await bulk.applyAgentTagEdit('owner', tags.operationId, now); await bulk.undoAgentTagEdit('owner', tags.operationId, now);
    await bulk.applyAgentCategoryEdit('owner', category.operationId, now); await bulk.undoAgentCategoryEdit('owner', category.operationId, now);
    expect((await readLedgerDetail(fixture.pool, id))!.revisions).toHaveLength(4);
    expect((await fixture.sql.query('SELECT source FROM olbia.ledger_revisions ORDER BY source')).rows)
      .toEqual([{ source: 'assistant_chat_category_edit' }, { source: 'assistant_chat_category_edit' },
        { source: 'assistant_chat_tag_edit' }, { source: 'assistant_chat_tag_edit' }]);
    expect((await fixture.sql.query('SELECT * FROM olbia.merchant_rules')).rows).toEqual([]);
  });
  it.each(['tags', 'categories'] as const)('applies %s batches atomically and replays their status without new writes', async kind => {
    const ids = [await fixture.create(), await fixture.create()];
    const previews = await Promise.all(ids.map(id => kind === 'tags' ? tagPreview([id]) : categoryPreview([id])));
    const apply = kind === 'tags' ? bulk.applyAgentTagEdits : bulk.applyAgentCategoryEdits;
    const result = await apply('owner', previews.map(p => p.operationId), now);
    expect(result).toMatchObject({ operationCount: 2, movementCount: 2, amountMinor: 20000 });
    const before = await fixture.snapshot(); await apply('owner', previews.map(p => p.operationId), now);
    expect(await fixture.snapshot()).toEqual(before);
  });
  it('rejects owner mismatch, expired proposals, missing/rejected explicit IDs and overlapping batches', async () => {
    const id = await fixture.create(); const first = await tagPreview([id]); const second = await tagPreview([id], ['other']);
    const before = await fixture.snapshot();
    await expect(bulk.applyAgentTagEdits('owner', [first.operationId, second.operationId], now)).rejects.toThrow('solapan');
    await expect(bulk.applyAgentTagEdit('other-owner', first.operationId, now)).rejects.toThrow('no existe');
    await expect(bulk.applyAgentTagEdit('owner', first.operationId, new Date('2026-10-02T13:15:00Z'))).rejects.toThrow('expiró');
    await expect(tagPreview([randomUUID()])).rejects.toThrow('no existen');
    const rejected = await fixture.create({ status: 'rejected' });
    await expect(tagPreview([rejected])).rejects.toThrow('accepted');
    const after = await fixture.snapshot();
    expect(after.ledger_bulk_operations).toEqual(before.ledger_bulk_operations);
    expect(after.ledger_revisions).toEqual(before.ledger_revisions);
  });
  it('rolls back every member/revision when final operation status writing fails', async () => {
    const ids = [await fixture.create(), await fixture.create()]; const preview = await tagPreview(ids);
    const before = await fixture.snapshot(); const transaction = fixture.pool.transaction.bind(fixture.pool);
    let sawRevisions = false;
    const fault = vi.spyOn(fixture.pool, 'transaction').mockImplementation(fn => transaction(client => fn({ query: async (statement, values) => {
      if (statement.startsWith('UPDATE olbia.ledger_bulk_operations')) {
        sawRevisions = (await client.query('SELECT id FROM olbia.ledger_revisions')).rows.length === 2;
        throw new Error('Interrupted operation status');
      }
      return client.query(statement, values);
    } })));
    try { await expect(bulk.applyAgentTagEdit('owner', preview.operationId, now)).rejects.toThrow('Interrupted operation status'); }
    finally { fault.mockRestore(); }
    expect(sawRevisions).toBe(true); expect(await fixture.snapshot()).toEqual(before);
    await bulk.applyAgentTagEdit('owner', preview.operationId, now);
  });
  it('rejects an oversized relational tag replacement batch before any financial writes', async () => {
    const oldTags = Array.from({ length: 20 }, (_, n) => `tag-${String(n).padStart(2, '0')}`);
    const ids: string[] = [];
    for (let n = 0; n < 74; n++) ids.push(await fixture.create({ tags: oldTags }));
    const first = await tagPreview(ids.slice(0, 49), ['replacement'], ['tag-00']);
    const second = await tagPreview(ids.slice(49), ['replacement'], ['tag-00']);
    const before = await fixture.snapshot();
    await expect(bulk.applyAgentTagEdits('owner', [first.operationId, second.operationId], now)).rejects.toThrow('demasiados cambios');
    expect(await fixture.snapshot()).toEqual(before);
  });
});
