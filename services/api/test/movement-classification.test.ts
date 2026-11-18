import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLedgerDetail, saveNativeCapture } from '@finance/ledger/native-ledger';
import { withSqlClient } from '@finance/ledger/sql-runtime';
import { nativeFixture } from './fixtures/native-ledger.js';
import { suggestMovementClassification } from '../src/categories/suggestions.js';
import { runAgentTool } from '../src/agent/tools.js';
import { patchEvent } from '../src/events/mutations.js';
import {
  applyAgentCategoryEdit, parseAgentCategoryEditInput, previewAgentCategoryEdit, undoAgentCategoryEdit,
} from '../src/events/bulk-edits.js';
import type { ObservedEventInput } from '../../ledger/src/observed-events.js';

vi.mock('../src/http/clients.js', () => ({ rawSourceBucketName: 'test-evidence', s3: { send: vi.fn() } }));

let fixture: Awaited<ReturnType<typeof nativeFixture>>;
const infer = vi.fn();
const at = '2026-11-18T15:00:00Z';
const edit = (id: string, change: Record<string, unknown>) =>
  fixture.run(() => patchEvent(id, 'owner', JSON.stringify(change)));
const detail = (id: string) => readLedgerDetail(fixture.pool, id);
const suggest = (id: string) => withSqlClient(fixture.pool, () => suggestMovementClassification(id, infer));
const rule = async (key: string, category: string, source = 'human', pattern: string | null = null) =>
  fixture.sql.query('INSERT INTO olbia.merchant_rules VALUES ($1,$1,$2,$3,$4,$5)', [key, pattern, category, source, at]);

beforeAll(async () => { fixture = await nativeFixture(); }, 30_000);
beforeEach(async () => { await fixture.reset(); infer.mockReset(); });
afterAll(async () => { await fixture?.sql.close(); });

describe('deterministic purchase classification', () => {
  it('learns normalized merchant and descriptive tags from confirmed edits, with one audit on repeated capture', async () => {
    for (const merchantRaw of ['GO-FAST Lavádo', 'Go Fast Lavado']) {
      const id = await fixture.create({ merchantRaw });
      await edit(id, { action: 'set_category', categoryId: 'transporte' });
      await edit(id, { action: 'set_tags', tags: ['auto:lavado', 'gasto:extraordinario', 'viaje:vegas'] });
    }
    const event: ObservedEventInput = {
      id: '1bcb52bf-e4dd-4a25-91ca-dbf1c92f0a33', merchantRaw: 'Go Fast / Lavado', institution: 'santander_mx',
      amount: { amountMinor: 15900, currency: 'MXN' }, eventType: 'card_purchase', status: 'accepted',
      receivedAt: at, ingestedAt: at, occurredAt: at, source: { kind: 'manual' }, parserVersion: 'test', parseWarnings: [],
    };
    const capture = () => fixture.pool.transaction(client =>
      saveNativeCapture(client, { event, token: 'classification-test', captureSource: 'manual', reconciliationAt: at }));
    expect(await capture()).toMatchObject({ created: true, eventId: event.id });
    expect(await capture()).toMatchObject({ duplicate: true, created: false, eventId: event.id });
    expect(await detail(event.id)).toMatchObject({
      categoryId: 'transporte', tags: ['auto:lavado'], amount: event.amount,
      revisions: [{ source: 'automatic_classification', reason: 'history', changes: {
        categoryId: { previous: null, next: 'transporte' }, tags: { previous: [], next: ['auto:lavado'] },
      } }],
      observations: [{ merchantRaw: event.merchantRaw, amount: event.amount }],
    });
    expect((await fixture.sql.query('SELECT id FROM olbia.merchant_rules')).rows).toEqual([]);
  });

  it('honors explicit null/category/tags, rule precedence, archived categories and conflicts', async () => {
    await rule('merchant', 'salud', 'human', 'merchant');
    await rule('local merchant', 'transporte');
    expect(await detail(await fixture.create({ merchantRaw: 'LOCAL-MERCHANT' }))).toMatchObject({ categoryId: 'transporte' });
    expect(await detail(await fixture.create({ merchantRaw: 'LOCAL-MERCHANT', categoryId: null, tags: [] })))
      .toMatchObject({ tags: [], revisions: [] });
    expect(await detail(await fixture.create({ merchantRaw: 'local merchant', categoryId: 'otros', tags: ['auto:lavado'] })))
      .toMatchObject({ categoryId: 'otros', tags: ['auto:lavado'], revisions: [] });
    await fixture.sql.query("INSERT INTO olbia.category_lifecycle VALUES ('transporte',true,1),('salud',true,1)");
    expect((await detail(await fixture.create({ merchantRaw: 'LOCAL MERCHANT' })))?.categoryId).toBeUndefined();

    await rule('mix store', 'shopping', 'seed');
    for (const categoryId of ['shopping', 'otros']) {
      const id = await fixture.create({ merchantRaw: 'Mix Store', categoryId: null });
      await edit(id, { action: 'set_category', categoryId });
    }
    expect((await detail(await fixture.create({ merchantRaw: 'MIX STORE' })))?.categoryId).toBeUndefined();
  });

  it('requires independent approvals and ignores undone edits', async () => {
    const merchantRaw = 'Garage Dos';
    const a = await fixture.create({ merchantRaw });
    const b = await fixture.create({ merchantRaw });
    const apply = async (ids: string[]) => fixture.run(async () => {
      const operation = await previewAgentCategoryEdit('owner', parseAgentCategoryEditInput({ eventIds: ids, categoryId: 'transporte' }));
      await applyAgentCategoryEdit('owner', operation.operationId);
      return operation.operationId;
    });
    const batch = await apply([a, b]);
    expect((await detail(await fixture.create({ merchantRaw })))?.categoryId).toBeUndefined();
    await fixture.run(() => undoAgentCategoryEdit('owner', batch));
    const first = await apply([a]);
    await apply([b]);
    expect(await detail(await fixture.create({ merchantRaw }))).toMatchObject({ categoryId: 'transporte' });
    await fixture.run(() => undoAgentCategoryEdit('owner', first));
    expect((await detail(await fixture.create({ merchantRaw })))?.categoryId).toBeUndefined();
  });

  it('stops suggesting a previously removed tag and stops auto-propagating it', async () => {
    const merchantRaw = 'Parking Tres';
    await rule('parking tres', 'transporte');
    for (let i = 0; i < 2; i++) {
      const id = await fixture.create({ merchantRaw });
      await edit(id, { action: 'set_tags', tags: ['auto:estacionamiento'] });
    }
    const reconsider = await fixture.create({ merchantRaw });
    expect(await detail(reconsider)).toMatchObject({ tags: ['auto:estacionamiento'] });
    await edit(reconsider, { action: 'set_tags', tags: [] });
    expect(await suggest(reconsider)).toMatchObject({ status: 'classified', tags: [] });
    expect(await detail(await fixture.create({ merchantRaw }))).toMatchObject({ tags: [] });
    expect(infer).not.toHaveBeenCalled();
  });
});

describe('on-demand review', () => {
  it('returns a known rule from the same SQL without calling Haiku or writing changes', async () => {
    const id = await fixture.create({ merchantRaw: 'Café del centro' });
    const current = await fixture.create({ merchantRaw: 'Café del centro', categoryId: 'restaurantes' });
    await rule('cafe del centro', 'restaurantes');
    const before = await fixture.snapshot();
    const suggestion = { status: 'suggested', source: 'rule', movementId: id,
      suggestion: { category: { id: 'restaurantes' }, addTags: [] } };
    expect(await suggest(id.slice(0, 8))).toMatchObject(suggestion);
    expect(await withSqlClient(fixture.pool, () => runAgentTool('owner', 'suggest_movement_classification',
      { movementRef: id.slice(0, 8) }))).toMatchObject(suggestion);
    expect(await suggest(current)).toMatchObject({ status: 'classified' });
    expect(infer).not.toHaveBeenCalled();
    expect(await fixture.snapshot()).toEqual(before);
  });

  it('calls Haiku once per requested unresolved charge, with only merchant/catalog, and filters the proposal', async () => {
    const id = await fixture.create({ merchantRaw: 'Lavado Test 123456789876', tags: ['evento:prueba'] });
    infer.mockResolvedValue({ categoryId: 'transporte', tags: ['auto:lavado', 'gasto:extraordinario', 'evento:prueba'] });
    const before = await fixture.snapshot();
    expect(await suggest(id)).toMatchObject({ status: 'suggested', source: 'haiku', movementId: id,
      categoryId: null, tags: ['evento:prueba'], suggestion: { category: { id: 'transporte' }, addTags: ['auto:lavado'] } });
    expect(infer).toHaveBeenCalledExactlyOnceWith({ merchant: 'lavado test', categories: expect.arrayContaining([{ id: 'transporte', name: 'Transporte' }]) });
    expect(await fixture.snapshot()).toEqual(before);
  });

  it('never calls Haiku for an explicit clear, zero amount, transfer or ambiguous reference', async () => {
    const id = await fixture.create({ merchantRaw: 'Unknown' });
    await edit(id, { action: 'set_category', categoryId: null });
    expect(await suggest(id)).toMatchObject({ status: 'reviewed', categoryId: null });
    const zero = await fixture.create({ amount: { amountMinor: 0, currency: 'MXN' } });
    const transfer = await fixture.create({ eventType: 'outgoing_transfer' });
    expect(await suggest(zero)).toMatchObject({ status: 'ineligible' });
    expect(await suggest(transfer)).toMatchObject({ status: 'ineligible' });
    for (const suffix of ['00', '01']) await fixture.create({ id: `11111111-1111-4111-8111-1111111111${suffix}` });
    expect(await suggest('11111111')).toEqual({ status: 'ambiguous_reference' });
    expect(infer).not.toHaveBeenCalled();
  });

  it('rejects an archived model category and degrades to manual review if the provider fails', async () => {
    const id = await fixture.create({ merchantRaw: 'Otro comercio' });
    await fixture.sql.query("INSERT INTO olbia.category_lifecycle VALUES ('otros',true,1)");
    infer.mockResolvedValueOnce({ categoryId: 'otros', tags: ['tipo:servicio'] }).mockRejectedValueOnce(new Error('timeout'));
    expect(await suggest(id)).toMatchObject({ status: 'no_suggestion', categoryId: null });
    expect(infer.mock.calls[0][0].categories).not.toContainEqual({ id: 'otros', name: 'Otros' });
    expect(await suggest(id)).toMatchObject({ status: 'unavailable' });
  });
});
