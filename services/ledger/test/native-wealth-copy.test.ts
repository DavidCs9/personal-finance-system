import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS, NATIVE_WEALTH_TABLES } from '../src/dsql/wealth-schema.js';
import { prepareWealthCopy, readRetainedWealth, migrateWealth } from '../src/dsql/wealth-copy.js';
import { projectRows, type SourceItem } from '../src/dsql/model.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';

let sql: PGlite, pool: TransactionPool;
const previousId = '10000000-0000-4000-8000-000000000001';
const priorLiabilityId = '10000000-0000-4000-8000-000000000002';
const day = '2026-10-02', before = `${day}T12:00:00.000Z`, after = `${day}T12:00:00.001Z`;
const evidence = (key: string) => ({ bucket: 'test-evidence', key, sha256: '1'.repeat(64), contentType: 'application/json' });
const holding = (value = 100) => ({ id: 'cash', symbol: 'USD', name: 'Cash', quantity: -0.12345678912345678,
  currency: 'USD', valueNativeMinor: -100, valueMxnMinor: value });
const asset = (version = false): SourceItem => ({ PK: 'USER#owner',
  SK: version ? `WEALTH_VER#ibkr#${day}#${before}` : `WEALTH_SNAP#ibkr#${day}`,
  owner: 'owner', accountId: 'ibkr', day, capturedAt: version ? before : after, source: 'flex', currency: 'MXN',
  totalMxnMinor: version ? -100 : 200, holdings: [holding(version ? -100 : 200)], fxRate: 17.123456789123456,
  fxSource: 'banxico_sf43718', evidence: evidence(version ? 'prior-asset' : 'current-asset'),
  ...(version ? { versionId: previousId, supersededAt: after } : {}) });
const liability = (version = false): SourceItem => ({ PK: 'USER#owner',
  SK: version ? `LIAB_VER#amex#${day}#${before}` : `LIAB_SNAP#amex#${day}`,
  owner: 'owner', cardId: 'amex', day, capturedAt: version ? before : after, source: 'manual', currency: 'MXN',
  totalMxnMinor: version ? 100 : 0, evidence: evidence(version ? 'prior-liability' : 'current-liability'),
  ...(version ? { versionId: priorLiabilityId, supersededAt: after } : {}) });
const retainedTables = ['wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions'];
const insertRetained = async (item: SourceItem) => {
  for (const row of projectRows({ PK: item.PK, SK: item.SK }, item)) {
    const columns = Object.keys(row.values);
    await sql.query(`INSERT INTO olbia.${row.table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
      columns.map(c => { const v = row.values[c]; return v && typeof v === 'object' ? JSON.stringify(v) : v; }));
  }
};
const retainedSnapshot = async () => Object.fromEntries(await Promise.all(retainedTables.map(async table =>
  [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2,3`)).rows])));
const seed = async () => { for (const item of [asset(), asset(true), liability(), liability(true)]) await insertRetained(item); };
beforeAll(async () => {
  sql = new PGlite(); for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_WEALTH_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query("INSERT INTO olbia.card_profiles VALUES ('amex','owner','Amex',25,15,'american_express_mx',$1,$1,NULL)", [before]);
  pool = { transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) };
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${[...NATIVE_WEALTH_TABLES, ...retainedTables].map(t => `olbia.${t}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version IN (14,15)');
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

describe('native immutable wealth foundation', () => {
  it('keeps an explicit empty provider capture canonical and derives zero without manufacturing holdings', async () => {
    await insertRetained({ ...asset(), totalMxnMinor: 0, holdings: [] });
    await migrateWealth(pool);
    expect((await sql.query('SELECT * FROM olbia.asset_daily_captures')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.asset_holdings')).rows).toEqual([]);
    expect((await sql.query(`SELECT COALESCE(SUM(h.value_mxn_minor),0)::bigint AS total
      FROM olbia.asset_daily_captures d LEFT JOIN olbia.asset_holdings h ON h.capture_id=d.capture_id`)).rows)
      .toEqual([{ total: 0 }]);
  });
  it('copies each capture once, preserves original audit UUIDs, signed/fractional facts and paid zero, deriving totals from holdings', async () => {
    await seed(); const before = await retainedSnapshot();
    await migrateWealth(pool); await migrateWealth(pool);
    expect(await retainedSnapshot()).toEqual(before);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows).toHaveLength(1);
    expect((await sql.query('SELECT id FROM olbia.asset_captures ORDER BY captured_at')).rows[0]).toEqual({ id: previousId });
    expect((await sql.query('SELECT id FROM olbia.liability_captures ORDER BY captured_at')).rows[0]).toEqual({ id: priorLiabilityId });
    expect((await sql.query(`SELECT c.captured_at,h.quantity,h.value_native_minor,h.value_mxn_minor,c.fx_rate
      FROM olbia.asset_captures c JOIN olbia.asset_holdings h ON h.capture_id=c.id ORDER BY c.captured_at`)).rows)
      .toMatchObject([{ quantity: holding().quantity, value_native_minor: -100, value_mxn_minor: -100, fx_rate: 17.123456789123456 },
        { quantity: holding().quantity, value_mxn_minor: 200 }]);
    expect((await sql.query(`SELECT SUM(h.value_mxn_minor)::bigint AS total FROM olbia.asset_daily_captures d
      JOIN olbia.asset_holdings h ON h.capture_id=d.capture_id`)).rows).toEqual([{ total: 200 }]);
    expect((await sql.query(`SELECT c.amount_mxn_minor FROM olbia.liability_daily_captures d
      JOIN olbia.liability_captures c ON c.id=d.capture_id`)).rows).toEqual([{ amount_mxn_minor: 0 }]);
    expect((await sql.query(`SELECT previous_capture_id FROM olbia.asset_capture_replacements`)).rows).toEqual([{ previous_capture_id: previousId }]);
    expect((await sql.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='olbia'
      AND table_name='asset_captures' AND column_name IN ('total_mxn_minor','payload','source_item','source_pk','source_sk')`)).rows).toEqual([]);
  });
  it('rejects wrong account/day pointers and replacement edges, duplicate holding identity, nonfinite quantities and unsupported asset identity', async () => {
    await seed(); await migrateWealth(pool);
    const capture = (await sql.query('SELECT * FROM olbia.asset_captures ORDER BY captured_at DESC LIMIT 1')).rows[0] as Record<string, unknown>;
    await expect(sql.query("INSERT INTO olbia.asset_daily_captures VALUES ('bitso','2026-10-03',$1)", [capture.id])).rejects.toThrow();
    await expect(sql.query("INSERT INTO olbia.asset_capture_replacements VALUES ('bitso',$1,$2,$3)", [day, previousId, capture.id])).rejects.toThrow();
    await expect(sql.query('INSERT INTO olbia.asset_holdings SELECT capture_id,9,id,symbol,name,quantity,currency,value_native_minor,value_mxn_minor FROM olbia.asset_holdings LIMIT 1')).rejects.toThrow();
    await expect(sql.query("INSERT INTO olbia.asset_holdings VALUES ($1,9,'bad','BAD','Bad','NaN','USD',0,0)", [capture.id])).rejects.toThrow();
    await expect(sql.query("INSERT INTO olbia.asset_accounts VALUES ('fondo_ahorro','Fondo','Nómina','payroll_savings','derived',3)")).rejects.toThrow();
  });
  it('fails closed for incomplete evidence, unknown facts, wrong source totals and unresolved prior successors', async () => {
    await seed(); const input = await readRetainedWealth(sql as unknown as SqlClient);
    for (const change of [
      (p: Record<string, unknown>) => { p.unknown = 'unreviewed'; },
      (p: Record<string, unknown>) => { p.totalMxnMinor = 999; },
      (p: Record<string, unknown>) => { delete p.evidence; },
    ]) {
      const bad = structuredClone(input); change(bad.assets[0].source_item as Record<string, unknown>);
      expect(() => prepareWealthCopy(bad)).toThrow('Retained wealth mapping is inconsistent');
    }
    const bad = structuredClone(input);
    (bad.assetVersions[0].source_item as Record<string, unknown>).supersededAt = `${day}T13:00:00Z`;
    expect(() => prepareWealthCopy(bad)).toThrow();
  });
  it('rolls back all native rows and activation on failure, rejects partial rows and refuses activation without accepted ledger authority', async () => {
    await seed(); const retained = await retainedSnapshot();
    const interrupted: TransactionPool = { transaction: fn => sql.transaction(async client => {
      await fn(client as unknown as SqlClient); throw new Error('Before commit');
    }) };
    await expect(migrateWealth(interrupted)).rejects.toThrow('Before commit');
    for (const table of NATIVE_WEALTH_TABLES) expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows).toEqual([]);
    expect(await retainedSnapshot()).toEqual(retained);
    await sql.query("INSERT INTO olbia.asset_accounts VALUES ('bitso','Bitso','Bitso','crypto','api',0)");
    await expect(migrateWealth(pool)).rejects.toThrow('Retained wealth mapping is inconsistent');
    await sql.query('DELETE FROM olbia.asset_accounts');
    await sql.query('DELETE FROM olbia.schema_migrations WHERE version=14');
    await expect(migrateWealth(pool)).rejects.toThrow('Retained wealth mapping is inconsistent');
  });
});
