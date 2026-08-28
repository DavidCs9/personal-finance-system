import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';

let database: typeof import('../src/http/clients.js').database;
let parseBulkEditInput: typeof import('../src/events/bulk-edits.js').parseBulkEditInput;
let previewBulkEdit: typeof import('../src/events/bulk-edits.js').previewBulkEdit;
let applyBulkEdit: typeof import('../src/events/bulk-edits.js').applyBulkEdit;
let undoBulkEdit: typeof import('../src/events/bulk-edits.js').undoBulkEdit;
let applyAgentTagEdit: typeof import('../src/events/bulk-edits.js').applyAgentTagEdit;
let undoAgentTagEdit: typeof import('../src/events/bulk-edits.js').undoAgentTagEdit;
let applyAgentCategoryEdit: typeof import('../src/events/bulk-edits.js').applyAgentCategoryEdit;
let undoAgentCategoryEdit: typeof import('../src/events/bulk-edits.js').undoAgentCategoryEdit;

beforeAll(async () => {
  ({ database } = await import('../src/http/clients.js'));
  ({ parseBulkEditInput, previewBulkEdit, applyBulkEdit, undoBulkEdit, applyAgentTagEdit, undoAgentTagEdit,
    applyAgentCategoryEdit, undoAgentCategoryEdit } =
    await import('../src/events/bulk-edits.js'));
});

afterEach(() => vi.restoreAllMocks());

const input = () => parseBulkEditInput({
  selection: { fromDay: '2026-08-21', toDay: '2026-08-25', statuses: ['accepted'] },
  change: { addTags: ['Viaje:Végas'] },
});

const eventItem = (id: string, merchantRaw: string, amountMinor: number, status = 'accepted') => ({
  PK: `EVENT#${id}`,
  SK: 'EVENT',
  payload: {
    id,
    merchantRaw,
    status,
    amount: { amountMinor, currency: 'MXN' },
    occurredAt: '2026-08-22T12:00:00.000Z',
    receivedAt: '2026-08-22T12:00:01.000Z',
    tags: id === 'event-2' ? ['ciudad:cdmx'] : undefined,
  },
});

describe('bulk edits', () => {
  it('normalizes and validates the requested change', () => {
    expect(input()).toEqual({
      selection: { fromDay: '2026-08-21', toDay: '2026-08-25', statuses: ['accepted'] },
      change: { addTags: ['viaje:vegas'] },
    });
    expect(() => parseBulkEditInput({
      selection: { fromDay: '2026-08-25', toDay: '2026-08-21' },
      change: { addTags: ['viaje:vegas'] },
    })).toThrow(/posterior/);
    expect(() => parseBulkEditInput({
      selection: { fromDay: '2026-08-21', toDay: '2026-08-25', statuses: ['rejected'] },
      change: { addTags: ['viaje:vegas'] },
    })).toThrow(/accepted/);
  });

  it('freezes accepted movement ids and amount in an owner-scoped preview', async () => {
    let saved: Record<string, unknown> | undefined;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [
          eventItem('event-1', 'Panda Express', 30_694),
          eventItem('event-2', 'Shell', 22_513),
          eventItem('rejected', 'Declined', 99_999, 'rejected'),
        ] };
      }
      if (command.constructor.name === 'PutCommand') {
        saved = command.input.Item;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const result = await previewBulkEdit('owner-1', input(), new Date('2026-08-26T00:00:00.000Z'));
    expect(result).toMatchObject({
      movementCount: 2,
      amountMinor: 53_207,
      change: { addTags: ['viaje:vegas'] },
    });
    expect(saved).toMatchObject({
      PK: 'BULK_EDIT#owner-1',
      entityType: 'bulk_edit_operation',
      payload: {
        owner: 'owner-1',
        status: 'pending',
        events: [
          { id: 'event-1', previousTags: [], nextTags: ['viaje:vegas'] },
          { id: 'event-2', previousTags: ['ciudad:cdmx'], nextTags: ['ciudad:cdmx', 'viaje:vegas'] },
        ],
      },
    });
  });

  it('applies and undoes the frozen snapshot transactionally', async () => {
    let operation: Record<string, any> | undefined;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [eventItem('event-1', 'Panda Express', 30_694)] };
      }
      if (command.constructor.name === 'PutCommand') {
        operation = command.input.Item.payload;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });
    const preview = await previewBulkEdit('owner-1', input(), new Date('2026-08-26T00:00:00.000Z'));
    expect(operation).toBeDefined();

    const transactions: any[] = [];
    vi.restoreAllMocks();
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'GetCommand') return { Item: { payload: operation } };
      if (command.constructor.name === 'TransactWriteCommand') {
        transactions.push(command.input);
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });
    const applied = await applyBulkEdit(
      'owner-1', preview.operationId, 'owner-1', new Date('2026-08-26T00:01:00.000Z'),
    );
    expect(applied.status).toBe('applied');
    expect((database.send as any).mock.calls.find(([command]: any[]) =>
      command.constructor.name === 'GetCommand')[0].input.ConsistentRead).toBe(true);
    expect(transactions[0].TransactItems).toHaveLength(3);
    expect(transactions[0].TransactItems[0].Update).toMatchObject({
      Key: { PK: 'EVENT#event-1', SK: 'EVENT' },
      ExpressionAttributeValues: { ':fromTags': [], ':toTags': ['viaje:vegas'] },
    });

    operation = { ...operation, status: 'applied', appliedAt: '2026-08-26T00:01:00.000Z' };
    const undone = await undoBulkEdit(
      'owner-1', preview.operationId, 'owner-1', new Date('2026-08-26T00:02:00.000Z'),
    );
    expect(undone.status).toBe('undone');
    expect(transactions[1].TransactItems[0].Update.ExpressionAttributeValues).toMatchObject({
      ':fromTags': ['viaje:vegas'],
      ':toTags': [],
    });
  });

  it('audits direct chat tag edits and keeps category operations outside that contract', async () => {
    const tagOperation = {
      operationId: 'tag-operation',
      owner: 'owner-1',
      status: 'pending',
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: Math.floor(new Date('2026-08-26T00:15:00.000Z').getTime() / 1000),
      selection: { fromDay: '2026-08-21', toDay: '2026-08-25', statuses: ['accepted'] },
      change: { addTags: ['viaje:vegas'] },
      events: [{
        id: 'event-1', merchantRaw: 'Panda Express', occurredAt: '2026-08-22T12:00:00.000Z',
        status: 'accepted', amountMinor: 30_694, previousTags: [], nextTags: ['viaje:vegas'],
        previousCategoryId: null, nextCategoryId: null,
      }],
      amountMinor: 30_694,
    };
    const transactions: any[] = [];
    let currentOperation: Record<string, unknown> = tagOperation;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'GetCommand') return { Item: { payload: currentOperation } };
      if (command.constructor.name === 'TransactWriteCommand') {
        transactions.push(command.input);
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    await applyAgentTagEdit('owner-1', 'tag-operation', new Date('2026-08-26T00:01:00.000Z'));
    expect(transactions[0].TransactItems[1].Put.Item.payload).toMatchObject({
      changedBy: 'owner-1',
      source: 'assistant_chat_tag_edit',
      reason: 'Tags aplicados desde el chat del asistente.',
    });

    currentOperation = { ...tagOperation, status: 'applied', appliedAt: '2026-08-26T00:01:00.000Z' };
    await undoAgentTagEdit('owner-1', 'tag-operation', new Date('2026-08-26T00:02:00.000Z'));
    expect(transactions[1].TransactItems[1].Put.Item.payload).toMatchObject({
      source: 'assistant_chat_tag_edit',
      reason: 'Tags restaurados desde el chat del asistente.',
    });

    currentOperation = {
      ...tagOperation,
      operationId: 'category-operation',
      change: { categoryId: 'food' },
    };
    await expect(applyAgentTagEdit(
      'owner-1', 'category-operation', new Date('2026-08-26T00:03:00.000Z'),
    )).rejects.toThrow(/sólo puede modificar tags/);
  });

  it('audits direct chat category edits without changing tags or merchant rules', async () => {
    const categoryOperation = {
      operationId: 'category-operation',
      owner: 'owner-1',
      status: 'pending',
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: Math.floor(new Date('2026-08-26T00:15:00.000Z').getTime() / 1000),
      selection: { fromDay: '2026-08-21', toDay: '2026-08-25', statuses: ['accepted'] },
      change: { categoryId: 'food' },
      events: [{
        id: 'event-1', merchantRaw: 'Panda Express', occurredAt: '2026-08-22T12:00:00.000Z',
        status: 'accepted', amountMinor: 30_694, previousTags: ['viaje:vegas'], nextTags: ['viaje:vegas'],
        previousCategoryId: 'other', nextCategoryId: 'food',
      }],
      amountMinor: 30_694,
    };
    const transactions: any[] = [];
    let currentOperation: Record<string, unknown> = categoryOperation;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'GetCommand') return { Item: { payload: currentOperation } };
      if (command.constructor.name === 'TransactWriteCommand') {
        transactions.push(command.input);
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    await applyAgentCategoryEdit('owner-1', 'category-operation', new Date('2026-08-26T00:01:00.000Z'));
    expect(transactions[0].TransactItems[0].Update.ExpressionAttributeValues).toMatchObject({
      ':fromTags': ['viaje:vegas'], ':toTags': ['viaje:vegas'], ':fromCategory': 'other', ':toCategory': 'food',
    });
    expect(transactions[0].TransactItems[1].Put.Item.payload).toMatchObject({
      source: 'assistant_chat_category_edit',
      reason: 'Categoría aplicada desde el chat del asistente.',
      changes: { categoryId: { previous: 'other', next: 'food' } },
    });
    expect(transactions[0].TransactItems[1].Put.Item.payload.changes).not.toHaveProperty('tags');

    currentOperation = { ...categoryOperation, status: 'applied', appliedAt: '2026-08-26T00:01:00.000Z' };
    await undoAgentCategoryEdit('owner-1', 'category-operation', new Date('2026-08-26T00:02:00.000Z'));
    expect(transactions[1].TransactItems[1].Put.Item.payload).toMatchObject({
      source: 'assistant_chat_category_edit',
      reason: 'Categoría restaurada desde el chat del asistente.',
    });

    currentOperation = { ...categoryOperation, operationId: 'tag-operation', change: { addTags: ['viaje:vegas'] } };
    await expect(applyAgentCategoryEdit(
      'owner-1', 'tag-operation', new Date('2026-08-26T00:03:00.000Z'),
    )).rejects.toThrow(/sólo puede modificar categorías/);
  });
});
