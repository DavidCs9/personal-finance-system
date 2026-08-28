import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';

let database: typeof import('../src/http/clients.js').database;
let runTagMutationTool: typeof import('../src/agent/tag-mutation-tools.js').runTagMutationTool;

beforeAll(async () => {
  ({ database } = await import('../src/http/clients.js'));
  ({ runTagMutationTool } = await import('../src/agent/tag-mutation-tools.js'));
});

afterEach(() => vi.restoreAllMocks());

describe('tag and category mutation Gateway tools', () => {
  it('creates an owner-scoped, tags-only frozen operation from an exact movement ID', async () => {
    let saved: Record<string, unknown> | undefined;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'BatchGetCommand') {
        return { Responses: { 'test-metadata-table': [{
          PK: 'EVENT#event-1',
          SK: 'EVENT',
          payload: {
            id: 'event-1',
            merchantRaw: 'Panda Express',
            status: 'accepted',
            amount: { amountMinor: 30_694, currency: 'MXN' },
            occurredAt: '2026-08-22T12:00:00.000Z',
          },
        }] } };
      }
      if (command.constructor.name === 'PutCommand') {
        saved = command.input.Item;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const result = await runTagMutationTool('owner-1', 'preview_tag_edit', {
      eventId: 'event-1',
      addTags: ['Viaje:Végas'],
    });

    expect(result).toMatchObject({
      dryRun: true,
      movementCount: 1,
      change: { addTags: ['viaje:vegas'] },
    });
    expect(result).not.toHaveProperty('change.categoryId');
    expect(saved).toMatchObject({
      PK: 'BULK_EDIT#owner-1',
      payload: {
        owner: 'owner-1',
        selection: { eventIds: ['event-1'] },
        change: { addTags: ['viaje:vegas'] },
      },
    });
  });

  it('requires a precise tag selector and honours merchant/source tag filters', async () => {
    await expect(runTagMutationTool('owner-1', 'preview_tag_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', addTags: ['viaje:vegas'],
    })).rejects.toThrow(/nunca sólo fechas/);

    let saved: Record<string, unknown> | undefined;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [
          {
            PK: 'EVENT#event-1', SK: 'EVENT', payload: {
              id: 'event-1', merchantRaw: 'UBER   EATS', status: 'accepted', tags: ['viaje:vegas'],
              amount: { amountMinor: 30_694 }, occurredAt: '2026-08-22T12:00:00.000Z',
            },
          },
          {
            PK: 'EVENT#event-2', SK: 'EVENT', payload: {
              id: 'event-2', merchantRaw: 'Uber Eats', status: 'accepted', tags: ['trabajo'],
              amount: { amountMinor: 10_000 }, occurredAt: '2026-08-22T12:00:00.000Z',
            },
          },
          {
            PK: 'EVENT#event-3', SK: 'EVENT', payload: {
              id: 'event-3', merchantRaw: 'Padel House', status: 'accepted', tags: ['viaje:vegas'],
              amount: { amountMinor: 8_000 }, occurredAt: '2026-08-22T12:00:00.000Z',
            },
          },
        ] };
      }
      if (command.constructor.name === 'PutCommand') {
        saved = command.input.Item;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const result = await runTagMutationTool('owner-1', 'preview_tag_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', addTags: ['ciudad:cdmx'],
      merchantRaw: 'uber eats', sourceTags: ['Viaje:Végas'],
    });
    expect(result).toMatchObject({ affected: [{ id: 'event-1' }], movementCount: 1 });
    expect(saved).toMatchObject({ payload: { selection: {
      merchantRaw: 'uber eats', sourceTags: ['viaje:vegas'],
    } } });
  });

  it('requires a real preview operation id for apply and undo', async () => {
    await expect(runTagMutationTool('owner-1', 'apply_tag_edit', {})).rejects.toThrow(/operationId/);
    await expect(runTagMutationTool('owner-1', 'apply_tag_edits', {})).rejects.toThrow(/operationIds/);
    await expect(runTagMutationTool('owner-1', 'undo_tag_edit', { operationId: ' ' })).rejects.toThrow(/operationId/);
    await expect(runTagMutationTool('owner-1', 'apply_category_edit', {})).rejects.toThrow(/operationId/);
    await expect(runTagMutationTool('owner-1', 'undo_category_edit', { operationId: ' ' })).rejects.toThrow(/operationId/);
  });

  it('creates an owner-scoped, category-only frozen operation from exact movement IDs', async () => {
    let saved: Record<string, unknown> | undefined;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'BatchGetCommand') {
        return { Responses: { 'test-metadata-table': [{
          PK: 'EVENT#event-1', SK: 'EVENT', payload: {
            id: 'event-1', merchantRaw: 'Panda Express', status: 'accepted',
            amount: { amountMinor: 30_694 }, occurredAt: '2026-08-22T12:00:00.000Z',
            receivedAt: '2026-08-22T12:00:01.000Z', categoryId: 'other', tags: ['viaje:vegas'],
          },
        }] } };
      }
      if (command.constructor.name === 'PutCommand') {
        saved = command.input.Item;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const result = await runTagMutationTool('owner-1', 'preview_category_edit', {
      categoryId: 'food',
      eventId: 'event-1',
      addTags: ['should-be-ignored'],
    });

    expect(result).toMatchObject({
      dryRun: true,
      movementCount: 1,
      change: { categoryId: 'food' },
      affected: [{ id: 'event-1', merchantRaw: 'Panda Express' }],
    });
    expect(result).not.toHaveProperty('change.addTags');
    expect(saved).toMatchObject({
      PK: 'BULK_EDIT#owner-1',
      payload: {
        owner: 'owner-1',
        change: { categoryId: 'food' },
        selection: { eventIds: ['event-1'] },
        events: [{ previousTags: ['viaje:vegas'], nextTags: ['viaje:vegas'], previousCategoryId: 'other', nextCategoryId: 'food' }],
      },
    });
  });

  it('requires a precise category selector and honours merchant/source filters', async () => {
    await expect(runTagMutationTool('owner-1', 'preview_category_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', categoryId: 'food',
    })).rejects.toThrow(/nunca sólo fechas/);

    let saved: Record<string, unknown> | undefined;
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [
          {
            PK: 'EVENT#event-1', SK: 'EVENT', payload: {
              id: 'event-1', merchantRaw: 'UBER   EATS', status: 'accepted',
              amount: { amountMinor: 30_694 }, occurredAt: '2026-08-22T12:00:00.000Z',
            },
          },
          {
            PK: 'EVENT#event-2', SK: 'EVENT', payload: {
              id: 'event-2', merchantRaw: 'Uber Eats', status: 'accepted', categoryId: 'transport',
              amount: { amountMinor: 10_000 }, occurredAt: '2026-08-22T12:00:00.000Z',
            },
          },
          {
            PK: 'EVENT#event-3', SK: 'EVENT', payload: {
              id: 'event-3', merchantRaw: 'Padel House', status: 'accepted',
              amount: { amountMinor: 8_000 }, occurredAt: '2026-08-22T12:00:00.000Z',
            },
          },
        ] };
      }
      if (command.constructor.name === 'PutCommand') {
        saved = command.input.Item;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const result = await runTagMutationTool('owner-1', 'preview_category_edit', {
      fromDay: '2026-08-21', toDay: '2026-08-25', categoryId: 'food',
      merchantRaw: 'uber eats', onlyUncategorized: true,
    });
    expect(result).toMatchObject({ affected: [{ id: 'event-1' }], movementCount: 1 });
    expect(saved).toMatchObject({ payload: { selection: { merchantRaw: 'uber eats', onlyUncategorized: true } } });
  });

  it('rejects tools outside the dedicated mutation contract', async () => {
    await expect(runTagMutationTool('owner-1', 'set_category', {})).rejects.toThrow(/desconocida/);
  });
});
