import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nativeFixture } from './fixtures/native-ledger.js';
import { readSqlFeed } from '../src/events/sql-reads.js';
import { readSqlPlanRecord } from '../src/months/sql-reads.js';
import { verifyNativeMonthSummary } from '../src/events/native-verification.js';

process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-originals';
const { summarizeMonthFeed } = await import('../src/months/summary.js');
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
const now = new Date('2026-09-24T18:00:00Z');
beforeAll(async () => { fixture = await nativeFixture(); }, 30_000);
afterAll(async () => { await fixture.sql.close(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql.exec('TRUNCATE olbia.month_plans,olbia.planned_payments,olbia.planned_payment_charges,olbia.planned_payment_charge_revisions');
});

const seed = async () => {
  await fixture.sql.query('INSERT INTO olbia.month_plans VALUES ($1,$2,$3)',['2026-09','owner',now.toISOString()]);
  await fixture.sql.query(`INSERT INTO olbia.planned_payments VALUES
    ('2026-09','service','Service',39900,18,0),('2026-09','other-fixed','Other fixed',10000,30,1)`);
  await fixture.create({ amount: { amountMinor: 1000_00, currency: 'MXN' }, occurredAt: '2026-09-10T12:00:00Z' });
  const id = await fixture.create({ amount: { amountMinor: 450_00, currency: 'MXN' }, personalAmountMinor: 200_00,
    occurredAt: '2026-09-18T12:00:00Z', merchantRaw: 'A differently named bank charge' });
  await fixture.sql.query(`INSERT INTO olbia.planned_payment_charges (month,payment_id,movement_id,linked_at,linked_by)
    VALUES ('2026-09','service',$1,$2,'owner')`,[id,now.toISOString()]);
  return id;
};
const read = async (month='2026-09') => {
  const feed = await readSqlFeed([month],fixture.pool);
  const plan = await readSqlPlanRecord('owner',month,fixture.pool);
  const summary = summarizeMonthFeed(month,{ configured:true,incomeMinor:10000_00,
    upcomingPayments:plan?.upcomingPayments ?? [] },feed,now);
  const verdict = await verifyNativeMonthSummary(fixture.pool,month,feed,summary,'owner');
  return { feed,summary,verdict };
};

describe('independent native SQL fixed-charge oracle', () => {
  it('verifies B/D/U/F from typed rows and rejects corrupted domain totals', async () => {
    await seed();
    const { feed,summary,verdict } = await read();
    expect(summary).toMatchObject({ spentMinor:1200_00,discretionarySpentMinor:1000_00,fixedSpentMinor:200_00,
      billScheduledMinor:499_00,billUpcomingMinor:100_00,upcomingMinor:100_00 });
    expect(verdict).toEqual({mismatches:0});
    for (const corruption of [
      {fixedSpentMinor:450_00}, {discretionarySpentMinor:1200_00}, {billScheduledMinor:100_00},
      {billUpcomingMinor:499_00}, {upcomingMinor:499_00}, {spentMinor:1000_00},
    ]) expect((await verifyNativeMonthSummary(fixture.pool,'2026-09',feed,{...summary,...corruption},'owner')).mismatches)
      .toBeGreaterThan(0);
    expect((await verifyNativeMonthSummary(fixture.pool,'2026-09',feed,summary,'another-owner')).mismatches).toBeGreaterThan(0);
  });

  it('preserves complete coverage for personal zero and restores programming after rejection or invalidation', async () => {
    const id = await seed();
    await fixture.sql.query('UPDATE olbia.ledger_movements SET personal_amount_minor=0 WHERE id=$1',[id]);
    const zero = await read();
    expect(zero.summary).toMatchObject({spentMinor:1000_00,fixedSpentMinor:0,billUpcomingMinor:100_00});
    expect(zero.verdict).toEqual({mismatches:0});
    await fixture.sql.query("UPDATE olbia.ledger_movements SET status='rejected' WHERE id=$1",[id]);
    const rejected = await read();
    expect(rejected.summary).toMatchObject({spentMinor:1000_00,fixedSpentMinor:0,billUpcomingMinor:499_00});
    expect(rejected.verdict).toEqual({mismatches:0});
    await fixture.sql.query("UPDATE olbia.ledger_movements SET status='accepted',personal_amount_minor=20000 WHERE id=$1",[id]);
    const restored = await read();
    expect(restored.summary).toMatchObject({spentMinor:1200_00,fixedSpentMinor:200_00,billUpcomingMinor:100_00});
    expect(restored.verdict).toEqual({mismatches:0});
    await fixture.sql.query('UPDATE olbia.ledger_movements SET amount_minor=0,personal_amount_minor=NULL WHERE id=$1',[id]);
    const zeroGross = await read();
    expect(zeroGross.summary).toMatchObject({spentMinor:1000_00,fixedSpentMinor:0,billUpcomingMinor:499_00});
    expect(zeroGross.verdict).toEqual({mismatches:0});
    expect((await fixture.sql.query('SELECT movement_id FROM olbia.planned_payment_charges')).rows).toHaveLength(1);
  });

  it('keeps inherited programming complete without inheriting a source-month charge', async () => {
    await seed();
    const {summary,verdict} = await read('2026-10');
    expect(summary).toMatchObject({spentMinor:0,fixedSpentMinor:0,discretionarySpentMinor:0,
      billScheduledMinor:499_00,billUpcomingMinor:499_00});
    expect(verdict).toEqual({mismatches:0});
  });
});
