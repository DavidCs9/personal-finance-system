import { prepareNativeWealthFixture } from './fixtures/native-wealth.js';
import { NATIVE_WEALTH_TABLES } from '../../ledger/src/dsql/wealth-schema.js';
import { createHash } from 'node:crypto';
import * as connection from '../../ledger/src/dsql/connection.js';
import { readLedgerMovements } from '../../ledger/src/dsql/ledger-reads.js';
import { prepareNativeLedgerFixture, seedNativeMovement } from './fixtures/native-ledger.js';
import { NATIVE_LEDGER_TABLES } from '../../ledger/src/dsql/ledger-schema.js';
import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEND_CATEGORIES, resolveCategoryId, cardRemindersForDay } from '@finance/domain';
import { SCHEMA_STATEMENTS, migrateCardProfiles } from '../../ledger/src/dsql/schema.js';
import { TABLE_NAMES, type SourceItem, type SourceKey } from '../../ledger/src/dsql/model.js';
import { reconcileKey, type TransactionPool, type SqlClient } from '../../ledger/src/dsql/projection.js';

process.env.METADATA_TABLE_NAME ??= 'test'; process.env.RAW_EMAIL_BUCKET_NAME ??= 'test';
const application = await import('../../ledger/src/dsql/store.js');
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
const movementId = (label: string) => createHash('sha256').update(label).digest('hex').slice(0,32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const movement = (label: string, receivedAt: string, extra = {}): SourceItem => ({ PK: `EVENT#${movementId(label)}`, SK: 'EVENT', payload: {
  id: movementId(label), receivedAt, occurredAt: undefined, ingestedAt: receivedAt,
  source: { bucket: 'evidence', key: label, sha256: 'a'.repeat(64), contentType: 'message/rfc822' }, parserVersion: 'fixture', parseWarnings: [], institution: 'santander_mx', eventType: 'card_purchase', status: 'accepted', merchantRaw: 'Á Shared Shop',
  amount: { amountMinor: 40000, currency: 'MXN' }, categoryId: 'shopping', ...extra,
} });
const rule = (key: string, pattern?: string): SourceItem => ({ PK: 'CATEGORY_RULES', SK: `RULE#${key}`, id: key,
  merchantKey: key, ...(pattern ? { pattern } : {}), categoryId: key === 'z' ? 'salud' : 'shopping', source: 'human', updatedAt: '2026-09-01', provenance: { preserved: true } });
const seed = async () => {
  await sql.query("UPDATE olbia.spend_categories SET name='Compras propias',sort_order=1 WHERE id='shopping'");
  for (const item of [{ PK: 'CATEGORY_CATALOG', SK: 'CAT#shopping', id: 'shopping', name: 'Compras propias', sortOrder: 1 },
    card('a'), card('b', 10), card('c', 28), rule('a', 'shop'), rule('z', 'shop'), rule('long', 'shared shop'),
    movement('zero', '2026-10-01T05:59:59.999Z', { personalAmountMinor: 0 }), movement('oct', '2026-10-01T06:00:00.000Z'),
    movement('pending', '2026-09-10T12:00:00Z', { status: 'pending_foreign', amount: { amountMinor: 1200, currency: 'USD' } }),
    movement('review', '2026-09-10T12:00:00Z', { status: 'needs_review' }),
    movement('rejected', '2026-09-10T12:00:00Z', { status: 'rejected' }),
    movement('plan', '2026-08-01T12:00:00Z', { msi: { months: 2, principalMinor: 60000, cuotaMinor: 30000, origin: 'manual', status: 'active', installments: [
      { index: 1, month: '2026-09', amountMinor: 30000, status: 'spent' }, { index: 2, month: '2026-10', amountMinor: 30000, status: 'committed' } ] } }),
  ] as SourceItem[]) { records.set(identity(item), item); await sync(item);
    if(item.SK==='EVENT') await seedNativeMovement(pool,item.payload as never); }
  for (const c of DEFAULT_SPEND_CATEGORIES) await sync({ PK: 'CATEGORY_CATALOG', SK: `CAT#${c.id}` });
  await migrateCardProfiles(pool);
  await sql.query(`INSERT INTO olbia.merchant_rules SELECT merchant_key,id,payload->>'pattern',category_id,
    payload->>'source',(payload->>'updatedAt')::timestamptz FROM olbia.merchant_category_rules`);
};
beforeAll(async () => { sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await prepareNativeLedgerFixture(sql);
  await prepareNativeWealthFixture(sql);
  await sql.query('ALTER TABLE olbia.movements ADD CONSTRAINT movements_category_fk FOREIGN KEY (category_id) REFERENCES olbia.spend_categories(id)');
  for (const table of ['liability_snapshots','liability_versions']) {
    await sql.query(`ALTER TABLE olbia.${table} ADD CONSTRAINT ${table}_card_required CHECK (card_id IS NOT NULL)`);
    await sql.query(`ALTER TABLE olbia.${table} ADD CONSTRAINT ${table}_card_fk FOREIGN KEY (card_id) REFERENCES olbia.card_profiles(id)`);
  }
  pool = { transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) }; }, 30_000);
afterAll(async () => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  records = new Map(); await sql.exec(`TRUNCATE olbia.projection_state,olbia.merchant_rules,olbia.card_profiles,${[...TABLE_NAMES,...NATIVE_LEDGER_TABLES,...NATIVE_WEALTH_TABLES,'bank_imports','bank_import_rows','bank_import_candidates'].map(t => `olbia.${t}`).join(',')}`);
  await prepareNativeWealthFixture(sql);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=9');
  vi.spyOn(application, 'applicationStoreClient').mockReturnValue(sql);
  vi.stubEnv('DSQL_DOMAIN_READ_MODE', 'guarded-sql'); vi.stubEnv('DSQL_LEDGER_READ_MODE', 'guarded-sql');
  vi.stubEnv('DSQL_PLANNING_READ_MODE', 'dynamodb');
  vi.spyOn(readers, 'readerPool').mockImplementation(() => application.currentStoreTransaction() ?? sql); vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(connection, 'createPool').mockReturnValue({ query: (s: string, v?: unknown[]) => sql.query(s, v), transaction: (fn: (c: SqlClient) => Promise<unknown>) => sql.transaction(c => fn(c as unknown as SqlClient)) } as never);
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
  it('preserves catalog overrides and merchant-key order for exact/longest/equal-pattern precedence', async () => {
    await seed(); expect(await listCategories()).toEqual(await readSqlCategories(sql));
    expect(await listCategories()).toContainEqual({ id: 'shopping', name: 'Compras propias', sortOrder: 1 });
    expect(await listMerchantRules()).toEqual(await readSqlMerchantRules(sql));
    expect(resolveCategoryId('shop', await listMerchantRules())).toBe('shopping');
    expect(resolveCategoryId('shared shop', await listMerchantRules())).toBe('shopping');
    const exact = { ...rule('shared shop'), categoryId: 'salud' }; records.set(identity(exact), exact);
    expect(await resolveCategoryForMerchant('Shared Shop')).toBe('shopping'); // frozen source is no longer rule authority
    await sql.query(`INSERT INTO olbia.merchant_rules VALUES ('shared shop','exact',NULL,'salud','human',CURRENT_TIMESTAMP)`);
    expect(resolveCategoryId('Shared Shop', await listMerchantRules())).toBe('salud');
    const commands = (DynamoDBDocumentClient.prototype.send as any).mock.calls.map(([c]: any[]) => c.input);
    expect(commands.filter((c: any) => c.KeyConditionExpression).every((c: any) => c.ConsistentRead)).toBe(true);
  });
  it('keeps every native domain authoritative over frozen envelopes and enforces active card limits', async () => {
    await seed(); const original = await readSqlCards('owner', sql); expect(original[0]).toMatchObject({ institution: 'santander_mx', createdAt: '2026-09-01T12:00:00.123Z' });
    records.delete('CATEGORY_CATALOG|CAT#shopping'); expect(await listCategories()).toContainEqual({ id: 'shopping', name: 'Compras propias', sortOrder: 1 });
    records.delete('CATEGORY_RULES|RULE#a'); expect((await listMerchantRules()).map(r => r.id)).toContain('a');
    await sql.query("DELETE FROM olbia.cards WHERE row_id='c'");
    // Use the real mocked SDK client so max-three validation exercises the source path, not a fake input.
    const { database } = await import('../src/http/clients.js');
    const query = vi.spyOn(sql, 'query');
    await expect(saveCard({ owner: 'owner', cardId: 'd', body: { name: 'd', cutOffDay: 1, paymentDueDay: 2 } })).rejects.toThrow('At most 3');
    expect(query).toHaveBeenCalled();
    expect(await listCards('owner')).toHaveLength(3);
    records.delete('USER#owner|CARD#a'); expect((await listCards('owner')).map(c => c.id)).toEqual(['a', 'b', 'c']);
    await sql.query("UPDATE olbia.card_profiles SET deleted_at=CURRENT_TIMESTAMP WHERE id='a'");
    expect((await listCards('owner')).map(c => c.id)).toEqual(['b', 'c']);
  });
  it('independently catches missing native relationships while preserving current domain authority', async () => {
    await seed(); const movements = await readLedgerMovements(sql);
    const run = () => verifyDomainReads('owner', movements, ['2026-09', '2026-10'], new Date('2026-10-01T06:00:00Z'));
    expect(await run()).toMatchObject({ effectiveCategories: 13, rules: 3, cards: 3, mismatches: 0, reports: 4 });
    // Frozen projection corruption is detected by the separate maintenance gate.
    // The product reader uses the canonical typed rule column immediately.
    await sql.query("UPDATE olbia.merchant_rules SET category_id='salud' WHERE merchant_key='a'");
    expect(resolveCategoryId('shop', await listMerchantRules())).toBe('salud');
    await sql.query("ALTER TABLE olbia.ledger_movements DROP CONSTRAINT ledger_movements_category_id_fkey");
    expect((await run()).mismatches).toBeGreaterThan(0);
    await sql.query('ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_category_id_fkey FOREIGN KEY (category_id) REFERENCES olbia.spend_categories(id)');
    await sql.query("UPDATE olbia.cards SET source_item=jsonb_set(source_item,'{payload,name}','\"Corrupt\"') WHERE row_id='a'");
    const { database } = await import('../src/http/clients.js'); expect((await listCards('owner'))[0].name).toBe('a');
    expect((await run()).mismatches).toBe(0); // frozen evidence has a separate maintenance gate
    await sql.query('ALTER TABLE olbia.liability_captures DROP CONSTRAINT liability_captures_card_id_fkey');
    expect((await run()).mismatches).toBeGreaterThan(0);
    await sql.query('ALTER TABLE olbia.liability_captures ADD CONSTRAINT liability_captures_card_id_fkey FOREIGN KEY (card_id) REFERENCES olbia.card_profiles(id)');
  });
  it('shares one native movement feed in assistant comparison and four-month report and propagates SQL failure', async () => {
    await seed(); const query = vi.spyOn(sql, 'query').mockRejectedValue(new Error('SQL unavailable'));
    await expect(compareMonths('2026-10', '2026-09')).rejects.toThrow('SQL unavailable');
    expect(query.mock.calls.filter(([statement]) => statement === readers.monthReadStatement)).toHaveLength(1);
    query.mockClear(); await expect(buildMonthlyCloseFacts('owner', '2026-10', new Date('2026-11-01T13:00:00Z'))).rejects.toThrow('SQL unavailable');
    expect(query.mock.calls.filter(([statement]) => statement === readers.monthReadStatement)).toHaveLength(1);
    query.mockRestore();
    const cards = await listCards('owner');
    expect(cardRemindersForDay(cards, '2026-02', 28).filter(r => r.cardId === 'a')).toHaveLength(2);
    expect(cardRemindersForDay(cards, '2028-02', 29).filter(r => r.cardId === 'a')).toHaveLength(2);
  });
  it('includes actual cuotas from older purchases in each comparison month', async () => {
    await seed();
    const distant = movement('distant', '2020-01-10T12:00:00Z', { msi: { months: 2, principalMinor: 60000, cuotaMinor: 30000, origin: 'manual', status: 'active', installments: [
      { index: 1, month: '2026-10', amountMinor: 30000, status: 'spent' }, { index: 2, month: '2026-11', amountMinor: 30000, status: 'committed' } ] } });
    records.set(identity(distant), distant); await sync(distant); await seedNativeMovement(pool,distant.payload as never);
    expect((await compareMonths('2026-10', '2020-01')).monthTotalMinor).toBe(70000);
    await expect(compareMonths('invalid', '2026-10')).rejects.toThrow('Mes inválido');
  });
  it('treats an invalid native UUID as absent without consulting frozen source documents or casting it in SQL', async () => {
    await seed();
    const query = vi.spyOn(sql, 'query');
    const { patchEvent } = await import('../src/events/mutations.js');
    expect(await application.withStoreClient(sql, () => patchEvent('invalid-id', 'owner', '{"action":"reject"}'))).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps rules on SQL across legacy mode flags and propagates SQL failure without a source fallback', async () => {
    await seed(); const query = vi.spyOn(sql, 'query'); vi.stubEnv('DSQL_DOMAIN_READ_MODE', 'dynamodb');
    await listMerchantRules(); expect(query).toHaveBeenCalledTimes(1);
    query.mockClear(); const { database } = await import('../src/http/clients.js'); await listCards('owner');
    expect(query).toHaveBeenCalledTimes(1); vi.stubEnv('DSQL_DOMAIN_READ_MODE', 'shadow'); await listMerchantRules();
    vi.mocked(DynamoDBDocumentClient.prototype.send).mockRejectedValue(new Error('Source unavailable') as never);
    expect(await listMerchantRules()).toHaveLength(3);
    expect(await listCategories()).toHaveLength(13);
    query.mockRejectedValue(new Error('SQL unavailable'));
    await expect(listMerchantRules()).rejects.toThrow('SQL unavailable');
    await expect(listCards('owner')).rejects.toThrow('SQL unavailable');
  });
});
