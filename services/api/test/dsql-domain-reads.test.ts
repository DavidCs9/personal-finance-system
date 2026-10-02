import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEND_CATEGORIES, resolveCategoryId, cardRemindersForDay } from '@finance/domain';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { TABLE_NAMES, type SourceItem, type SourceKey } from '../../ledger/src/dsql/model.js';
import { reconcileKey, type TransactionPool, type SqlClient } from '../../ledger/src/dsql/projection.js';

process.env.METADATA_TABLE_NAME ??= 'test'; process.env.RAW_EMAIL_BUCKET_NAME ??= 'test';
const readers = await import('../src/events/sql-reads.js');
const { listCategories, listMerchantRules, resolveCategoryForMerchant } = await import('../src/categories/service.js');
const { readSqlCategories, readSqlMerchantRules } = await import('../src/categories/sql-reads.js');
const { listCards, saveCard } = await import('../src/cards/cards.js');
const { readSqlCards } = await import('../src/cards/sql-reads.js');
const { compareMonths } = await import('../src/agent/aggregates.js');
const { buildMonthlyCloseFacts } = await import('../src/reports/monthly-close.js');
const { verifyDomainReads } = await import('../src/categories/read-verification.js');
let sql: PGlite, pool: TransactionPool, records: Map<string, SourceItem>;
const identity = (key: SourceKey) => `${key.PK}|${key.SK}`;
const sync = (key: SourceKey) => reconcileKey(pool, async key => records.get(identity(key)), key);
const card = (id: string, day = 31): SourceItem => ({ PK: 'USER#owner', SK: `CARD#${id}`, owner: 'owner',
  createdAt: '2026-09-01T12:00:00.123Z', updatedAt: '2026-09-02T12:00:00.456Z',
  payload: { id, name: id, cutOffDay: day, paymentDueDay: day, institution: 'santander_mx', optionalMetadata: [0, null] } });
const movement = (id: string, receivedAt: string, extra = {}): SourceItem => ({ PK: `EVENT#${id}`, SK: 'EVENT', payload: {
  id, receivedAt, institution: 'santander_mx', eventType: 'card_purchase', status: 'accepted', merchantRaw: 'Á Shared Shop',
  amount: { amountMinor: 40000, currency: 'MXN' }, categoryId: 'shopping', ...extra,
} });
const rule = (key: string, pattern?: string): SourceItem => ({ PK: 'CATEGORY_RULES', SK: `RULE#${key}`, id: key,
  merchantKey: key, ...(pattern ? { pattern } : {}), categoryId: key === 'z' ? 'salud' : 'shopping', source: 'human', updatedAt: '2026-09-01', provenance: { preserved: true } });
const seed = async () => {
  await sql.query("UPDATE olbia.spend_categories SET name='Compras propias',sort_order=1 WHERE id='shopping'");
  for (const item of [{ PK: 'CATEGORY_CATALOG', SK: 'CAT#shopping', id: 'shopping', name: 'Compras propias', sortOrder: 1 },
    card('a'), card('b', 10), card('c', 28), rule('a', 'shop'), rule('z', 'shop'), rule('long', 'shared shop'),
    movement('zero', '2026-10-01T05:59:59.999Z', { personalAmountMinor: 0 }), movement('oct', '2026-10-01T06:00:00.000Z'),
    movement('pending', '2026-09-10T12:00:00Z', { status: 'pending_foreign' }),
    movement('review', '2026-09-10T12:00:00Z', { validation: { needsReview: true } }),
    movement('rejected', '2026-09-10T12:00:00Z', { status: 'rejected' }),
    movement('plan', '2026-08-01T12:00:00Z', { msi: { months: 2, principalMinor: 60000, cuotaMinor: 30000, status: 'active', installments: [
      { index: 1, month: '2026-09', amountMinor: 30000, status: 'spent' }, { index: 2, month: '2026-10', amountMinor: 30000, status: 'committed' } ] } }),
  ] as SourceItem[]) { records.set(identity(item), item); await sync(item); }
  for (const c of DEFAULT_SPEND_CATEGORIES) await sync({ PK: 'CATEGORY_CATALOG', SK: `CAT#${c.id}` });
};
beforeAll(async () => { sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) }; }, 30_000);
afterAll(async () => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  records = new Map(); await sql.exec(`TRUNCATE olbia.projection_state,${TABLE_NAMES.map(t => `olbia.${t}`).join(',')}`);
  vi.stubEnv('DSQL_DOMAIN_READ_MODE', 'guarded-sql'); vi.stubEnv('DSQL_LEDGER_READ_MODE', 'guarded-sql');
  vi.stubEnv('DSQL_PLANNING_READ_MODE', 'dynamodb'); vi.stubEnv('DSQL_WEALTH_READ_MODE', 'dynamodb');
  vi.spyOn(readers, 'readerPool').mockReturnValue(sql); vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command: any) => {
    const input = command.input, values = input.ExpressionAttributeValues ?? {};
    if (command.constructor.name === 'GetCommand') return { Item: records.get(identity(input.Key)) };
    if (command.constructor.name === 'PutCommand') { records.set(identity(input.Item), input.Item); return {}; }
    if (command.constructor.name === 'ScanCommand') return { Items: [...records.values()].filter(x => x.SK === 'EVENT') };
    if (command.constructor.name === 'QueryCommand') {
      if (values[':partition']) return { Items: [...records.values()].filter(x => x.SK === 'EVENT' && (x.payload as any).receivedAt.startsWith(String(values[':partition']).slice(-7))) };
      const matching = [...records.values()].filter(x => x.PK === values[':pk'] && x.SK.startsWith(values[':sk'] ?? values[':prefix'] ?? 'NONE'))
        .sort((a, b) => Buffer.compare(Buffer.from(a.SK), Buffer.from(b.SK)));
      // Two pages force strong pagination rather than only matching the first page.
      return input.ExclusiveStartKey ? { Items: matching.slice(1) } : { Items: matching.slice(0, 1), ...(matching.length > 1 ? { LastEvaluatedKey: { PK: matching[0].PK, SK: matching[0].SK } } : {}) };
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  });
});
describe('remaining domain SQL reads', () => {
  it('preserves effective defaults/overrides, paginated rules and source key order for exact/longest/equal-pattern precedence', async () => {
    await seed(); expect(await listCategories()).toEqual(await readSqlCategories(sql));
    expect(await listCategories()).toContainEqual({ id: 'shopping', name: 'Compras propias', sortOrder: 1 });
    expect(await listMerchantRules()).toEqual(await readSqlMerchantRules(sql));
    expect(resolveCategoryId('shop', await listMerchantRules())).toBe('shopping');
    expect(resolveCategoryId('shared shop', await listMerchantRules())).toBe('shopping');
    const exact = { ...rule('shared shop'), categoryId: 'salud' }; records.set(identity(exact), exact);
    expect(await resolveCategoryForMerchant('Shared Shop')).toBe('salud'); // authoritative classification reads source during lag
    await sync(exact); expect(resolveCategoryId('Shared Shop', await listMerchantRules())).toBe('salud');
    const commands = (DynamoDBDocumentClient.prototype.send as any).mock.calls.map(([c]: any[]) => c.input);
    expect(commands.filter((c: any) => c.KeyConditionExpression).every((c: any) => c.ConsistentRead)).toBe(true);
  });
  it('keeps the native catalog authoritative while legacy rules/cards handle lag and card limits', async () => {
    await seed(); const original = await readSqlCards('owner', sql); expect(original[0]).toMatchObject({ institution: 'santander_mx', createdAt: '2026-09-01T12:00:00.123Z' });
    records.delete('CATEGORY_CATALOG|CAT#shopping'); expect(await listCategories()).toContainEqual({ id: 'shopping', name: 'Compras propias', sortOrder: 1 });
    records.delete('CATEGORY_RULES|RULE#a'); expect((await listMerchantRules()).map(r => r.id)).not.toContain('a');
    await sql.query("DELETE FROM olbia.cards WHERE row_id='c'");
    // Use the real mocked SDK client so max-three validation exercises the source path, not a fake input.
    const { database } = await import('../src/http/clients.js');
    const query = vi.spyOn(sql, 'query');
    await expect(saveCard({ database, tableName: 'test', owner: 'owner', cardId: 'd', body: { name: 'd', cutOffDay: 1, paymentDueDay: 2 } })).rejects.toThrow('At most 3');
    expect(query).not.toHaveBeenCalled();
    expect(await listCards({ database, tableName: 'test', owner: 'owner' })).toHaveLength(3);
    records.delete('USER#owner|CARD#a'); expect((await listCards({ database, tableName: 'test', owner: 'owner' })).map(c => c.id)).toEqual(['b', 'c']);
  });
  it('independently catches promoted-column/content corruption even when configured fallback returns correct source results', async () => {
    await seed(); const movements = [...records.values()].filter(r => r.SK === 'EVENT').map(r => r.payload as Record<string, unknown>);
    const run = () => verifyDomainReads('owner', movements, ['2026-09', '2026-10'], new Date('2026-10-01T06:00:00Z'));
    expect(await run()).toMatchObject({ effectiveCategories: 13, rules: 3, cards: 3, mismatches: 0, reports: 4 });
    await sql.query("UPDATE olbia.merchant_category_rules SET category_id='salud' WHERE row_id='a'");
    expect((await run()).mismatches).toBeGreaterThan(0);
    await sql.query("UPDATE olbia.cards SET source_item=jsonb_set(source_item,'{payload,name}','\"Corrupt\"') WHERE row_id='a'");
    const { database } = await import('../src/http/clients.js'); expect((await listCards({ database, tableName: 'test', owner: 'owner' }))[0].name).toBe('a');
    expect((await run()).mismatches).toBeGreaterThan(0);
  });
  it('shares one selected movement feed in assistant comparison and four-month report on SQL failure; cards clamp to February once selected', async () => {
    await seed(); const query = vi.spyOn(sql, 'query').mockRejectedValue(new Error('SQL unavailable'));
    await expect(compareMonths('2026-10', '2026-09')).rejects.toThrow('SQL unavailable');
    expect(query.mock.calls.filter(([statement]) => statement === readers.monthReadStatement)).toHaveLength(1);
    query.mockClear(); await expect(buildMonthlyCloseFacts('owner', '2026-10', new Date('2026-11-01T13:00:00Z'))).rejects.toThrow('SQL unavailable');
    expect(query.mock.calls.filter(([statement]) => statement === readers.monthReadStatement)).toHaveLength(1);
    query.mockClear(); const { database } = await import('../src/http/clients.js');
    const cards = await listCards({ database, tableName: 'test', owner: 'owner' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(cardRemindersForDay(cards, '2026-02', 28).filter(r => r.cardId === 'a')).toHaveLength(2);
    expect(cardRemindersForDay(cards, '2028-02', 29).filter(r => r.cardId === 'a')).toHaveLength(2);
  });
  it('keeps each comparison month within its original MSI window even when the other month is distant', async () => {
    await seed();
    const distant = movement('distant', '2020-01-10T12:00:00Z', { msi: { months: 2, principalMinor: 60000, cuotaMinor: 30000, status: 'active', installments: [
      { index: 1, month: '2026-10', amountMinor: 30000, status: 'spent' }, { index: 2, month: '2026-11', amountMinor: 30000, status: 'committed' } ] } });
    records.set(identity(distant), distant); await sync(distant);
    expect((await compareMonths('2026-10', '2020-01')).monthTotalMinor).toBe(40000);
    await expect(compareMonths('invalid', '2026-10')).rejects.toThrow('Mes inválido');
  });
  it('never consults SQL to decide a movement mutation, including a source deletion during projection lag', async () => {
    await seed(); records.delete('EVENT#oct|EVENT');
    const query = vi.spyOn(sql, 'query');
    const { patchEvent } = await import('../src/events/mutations.js');
    expect(await patchEvent('oct', 'owner', '{"action":"reject"}')).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
  it('skips SQL entirely in rollback, selects source in shadow and propagates source failure', async () => {
    await seed(); const query = vi.spyOn(sql, 'query'); vi.stubEnv('DSQL_DOMAIN_READ_MODE', 'dynamodb');
    await listMerchantRules(); const { database } = await import('../src/http/clients.js'); await listCards({ database, tableName: 'test', owner: 'owner' });
    expect(query).not.toHaveBeenCalled(); vi.stubEnv('DSQL_DOMAIN_READ_MODE', 'shadow'); await listMerchantRules();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"SourceSelected":1'));
    vi.mocked(DynamoDBDocumentClient.prototype.send).mockRejectedValue(new Error('Source unavailable') as never);
    await expect(listMerchantRules()).rejects.toThrow('Source unavailable');
    expect(await listCategories()).toHaveLength(13);
  });
});
