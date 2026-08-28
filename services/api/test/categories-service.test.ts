import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';

let database: typeof import('../src/http/clients.js').database;
let listCategories: typeof import('../src/categories/service.js').listCategories;

beforeAll(async () => {
  ({ database } = await import('../src/http/clients.js'));
  ({ listCategories } = await import('../src/categories/service.js'));
});

afterEach(() => vi.restoreAllMocks());

describe('category catalog', () => {
  it('adds new fixed categories while preserving persisted catalog entries', async () => {
    vi.spyOn(database as any, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [{
          PK: 'CATEGORY_CATALOG', SK: 'CAT#restaurantes', id: 'restaurantes',
          name: 'Comida', sortOrder: 1,
        }] };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const categories = await listCategories();
    expect(categories).toContainEqual({ id: 'restaurantes', name: 'Comida', sortOrder: 1 });
    expect(categories).toContainEqual({ id: 'deportes', name: 'Deportes', sortOrder: 75 });
  });
});
