import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/test/helpers/migration-schema.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { withSqlClient, currentSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import * as readers from '../src/events/sql-reads.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const incomeFieldsForMonth = vi.fn();
vi.mock('../src/imports/cfdi-nomina-flow.js', () => ({ incomeFieldsForMonth }));
const { getMonthlyPlan, saveMonthlyPlan } = await import('../src/months/service.js');
let sql: PGlite;
const payment = (name: string, amountMinor = 100_00) => ({ id: `payment-${name.toLowerCase()}`, name, amountMinor, dueDay: 15 });
const seedPlan = async (owner: string, month: string, payments: readonly ReturnType<typeof payment>[]) => {
  await sql.query('INSERT INTO olbia.month_plans VALUES ($1,$2,$3)', [month,owner,`${month}-01T00:00:00.000Z`]);
  for (const [index,p] of payments.entries()) await sql.query('INSERT INTO olbia.planned_payments VALUES ($1,$2,$3,$4,$5,$6)', [month,p.id,p.name,p.amountMinor,p.dueDay,index]);
};
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
}, 30_000);
afterAll(() => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.month_plans,olbia.planned_payments');
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true'); vi.stubEnv('DSQL_PLANNING_READ_MODE','dynamodb');
  vi.spyOn(connection,'createPool').mockReturnValue({ query: (s: string,v?: unknown[]) => sql.query(s,v),
    transaction: (fn: (client: SqlClient) => Promise<unknown>) => sql.transaction(client => fn(client as unknown as SqlClient)),
  } as never);
  vi.spyOn(readers,'readerPool').mockImplementation(() => currentSqlClient() ?? sql);
  incomeFieldsForMonth.mockResolvedValue({ configured: true, incomeMinor: 5_000_00, depositedMinor: 5_000_00, estimatedMinor: 0,
    estimateActive: false, provisionalActive: false, provisionalMinor: 0, payslips: [] });
});
describe('SQL-native monthly fixed-expense inheritance', () => {
  it('inherits across gaps/year boundaries without materializing reads or exposing another identity', async () => {
    await seedPlan('owner-1','2026-11',[payment('Renta',12_800_00)]); await seedPlan('other-owner','2026-12',[payment('Otro')]);
    expect(await getMonthlyPlan('owner-1','2027-01')).toMatchObject({ upcomingPayments: [payment('Renta',12_800_00)], inheritedFromMonth: '2026-11' });
    expect((await sql.query('SELECT month FROM olbia.month_plans ORDER BY month')).rows).toEqual([{ month: '2026-11' },{ month: '2026-12' }]);
    expect(await getMonthlyPlan('owner-1','2026-10')).toMatchObject({ upcomingPayments: [] });
  });
  it('retains an explicit empty parent and carries that stop forward', async () => {
    await seedPlan('owner-1','2026-10',[payment('iCloud')]); await seedPlan('owner-1','2026-11',[]);
    const stopped = await getMonthlyPlan('owner-1','2026-11'); expect(stopped.upcomingPayments).toEqual([]); expect(stopped.inheritedFromMonth).toBeUndefined();
    expect(await getMonthlyPlan('owner-1','2026-12')).toMatchObject({ upcomingPayments: [], inheritedFromMonth: '2026-11' });
  });
  it('materializes only the edited month, preserves prior history and reorders existing child IDs atomically', async () => {
    await seedPlan('owner-1','2026-08',[payment('Netflix')]);
    const edited = [payment('Netflix',299_00),payment('Renta',12_800_00)];
    expect(await saveMonthlyPlan('owner-1','2026-09',{ currency: 'MXN', upcomingPayments: edited })).toMatchObject({ upcomingPayments: edited });
    expect(await getMonthlyPlan('owner-1','2026-10')).toMatchObject({ upcomingPayments: edited, inheritedFromMonth: '2026-09' });
    await saveMonthlyPlan('owner-1','2026-09',{ currency: 'MXN', upcomingPayments: [...edited].reverse() });
    expect((await getMonthlyPlan('owner-1','2026-09')).upcomingPayments).toEqual([...edited].reverse());
    expect((await getMonthlyPlan('owner-1','2026-08')).upcomingPayments).toEqual([payment('Netflix')]);
    await saveMonthlyPlan('owner-1','2026-09',{ currency: 'MXN', upcomingPayments: [] });
    expect(await getMonthlyPlan('owner-1','2026-10')).toMatchObject({ upcomingPayments: [], inheritedFromMonth: '2026-09' });
  });
  it('rejects duplicate identities before opening the domain transaction or touching stored plans', async () => {
    await seedPlan('owner-1','2026-09',[payment('Internet')]); const query = vi.spyOn(sql,'query');
    await expect(saveMonthlyPlan('owner-1','2026-09',{ currency: 'MXN', upcomingPayments: [payment('Renta'),{ ...payment('Renta'),name: 'Otro',amountMinor: 20000 }] })).rejects.toThrow('Hay pagos repetidos');
    expect(query).not.toHaveBeenCalled();
  });
  it('rolls parent/child replacement back together and preserves owner binding', async () => {
    await seedPlan('owner-1','2026-09',[payment('Internet')]); const before = await getMonthlyPlan('owner-1','2026-09');
    await expect(sql.transaction(client => withSqlClient(client as unknown as SqlClient, async () => {
      await saveMonthlyPlan('owner-1','2026-09',{ currency: 'MXN', upcomingPayments: [payment('Renta')] }); throw new Error('Interrupted');
    }))).rejects.toThrow('Interrupted');
    expect(await getMonthlyPlan('owner-1','2026-09')).toEqual(before);
    await expect(saveMonthlyPlan('different','2026-09',{ currency: 'MXN', upcomingPayments: [] })).rejects.toThrow('month is invalid');
    expect(await getMonthlyPlan('owner-1','2026-09')).toEqual(before);
  });
  it('propagates native plan SQL failure across legacy payroll flags without a plan fallback', async () => {
    vi.mocked(readers.readerPool).mockReturnValue({ query: async () => { throw new Error('SQL unavailable'); } });
    await expect(getMonthlyPlan('owner-1','2026-09')).rejects.toThrow('SQL unavailable');
  });
});
