import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nativeFixture } from './fixtures/native-ledger.js';
import { readFutureCommitments } from '../src/months/commitments.js';
import { InvalidMonthlyPlanError } from '../src/months/monthly-plan.js';

let fixture: Awaited<ReturnType<typeof nativeFixture>>;
const now = new Date('2026-10-04T18:00:00Z');
beforeAll(async () => { fixture = await nativeFixture(); }, 30_000);
afterAll(async () => { await fixture.sql.close(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql.exec('TRUNCATE olbia.month_plans,olbia.planned_payments,olbia.planned_payment_charges,olbia.planned_payment_charge_revisions');
});
const plan = async (month: string, amount?: number, owner='owner', day=31) => {
  await fixture.sql.query('INSERT INTO olbia.month_plans VALUES ($1,$2,$3)',[month,owner,now.toISOString()]);
  if (amount!==undefined) await fixture.sql.query('INSERT INTO olbia.planned_payments VALUES ($1,$2,$3,$4,$5,$6)',
    [month,'rent','Renta',amount,day,0]);
};
const msi = async (status='accepted', currency='MXN', incomplete=false) => {
  const id = await fixture.create({ status: status as 'accepted', amount: {amountMinor:30003,currency}, merchantRaw:`Plan ${status}` });
  await fixture.sql.query('INSERT INTO olbia.installment_plans VALUES ($1,3,30003,10001,$2,$3,$4)',
    [id,'manual','active',incomplete]);
  for (const [index,month,entryStatus] of [[1,'2026-10','spent'],[2,'2026-11','committed'],[3,'2026-12','committed']] as const)
    await fixture.sql.query('INSERT INTO olbia.installment_entries (movement_id,installment_index,month,amount_minor,status) VALUES ($1,$2,$3,$4,$5)',
      [id,index,month,10001,entryStatus]);
  return id;
};

describe('SQL future commitments', () => {
  it('combines pending MSI and inherited fixed payments without multiplying either source', async () => {
    await plan('2026-09',12345);
    await fixture.sql.query("INSERT INTO olbia.planned_payments VALUES ('2026-09','internet','Internet',6789,18,1)");
    await msi(); await msi('needs_review');
    await msi('rejected'); await msi('deferred_msi'); await msi('accepted','USD');
    const incomplete = await msi('accepted','MXN',true);
    // Null completion is also a complete/eligible schedule under the original query.
    const normal = await msi();
    await fixture.sql.query('UPDATE olbia.installment_plans SET needs_schedule_completion=NULL WHERE movement_id=$1',[normal]);
    await fixture.sql.query('UPDATE olbia.installment_entries SET status=$2 WHERE movement_id=$1 AND month=$3',[normal,'cancelled','2026-12']);
    const before = await fixture.snapshot();
    const result = await readFutureCommitments('owner',undefined,now,fixture.pool);
    expect(result.months).toHaveLength(12);
    expect(result.months[0]).toMatchObject({month:'2026-10',totalMinor:19134,msiMinor:0,fixedMinor:19134,installmentCount:0,changeMinor:null});
    expect(result.months[1]).toMatchObject({month:'2026-11',totalMinor:49137,msiMinor:30003,fixedMinor:19134,
      uncertainMinor:10001,installmentCount:3,changeMinor:null,fixedSourceMonth:'2026-09'});
    expect(result.months[1]!.items).toHaveLength(5);
    expect(result.months[1]!.items.find(item=>item.id===normal)).toMatchObject({endMonth:'2026-11'});
    expect(result.months[2]).toMatchObject({totalMinor:39136,msiMinor:20002,changeMinor:-10001});
    expect(result.months[3]).toMatchObject({totalMinor:19134,msiMinor:0,changeMinor:-20002});
    expect(result.incompletePlans).toEqual([{eventId:incomplete,name:'Plan accepted'}]);
    expect(await fixture.snapshot()).toEqual(before);
    const independent = (await fixture.sql.query<{month:string;total:string;count:number}>(`SELECT i.month,SUM(i.amount_minor) AS total,COUNT(*) AS count
      FROM olbia.installment_entries i JOIN olbia.installment_plans p ON p.movement_id=i.movement_id
      JOIN olbia.ledger_movements m ON m.id=i.movement_id WHERE i.status='committed'
      AND m.status IN ('accepted','needs_review') AND m.currency='MXN' AND p.needs_schedule_completion IS NOT TRUE
      AND i.month>='2026-10' GROUP BY i.month ORDER BY i.month`)).rows;
    for (const row of independent) expect(result.months.find(month=>month.month===row.month)).toMatchObject({msiMinor:Number(row.total),installmentCount:Number(row.count)});
  });

  it('respects future overrides, empty inheritance stops, owner scope, short months and calendar rollover', async () => {
    await plan('2026-09',10000);
    await plan('2026-12',20000);
    await plan('2027-03');
    await plan('2027-06',90000,'another-owner');
    const before = (await fixture.sql.query('SELECT * FROM olbia.month_plans ORDER BY month')).rows;
    const result = await readFutureCommitments('owner',undefined,now,fixture.pool);
    expect(result.months[1]!.items[0]).toMatchObject({dueDay:30,amountMinor:10000});
    expect(result.months[2]).toMatchObject({fixedMinor:20000,fixedSourceMonth:'2026-12',changeMinor:10000});
    expect(result.months[4]!.items[0]).toMatchObject({dueDay:28,amountMinor:20000});
    expect(result.months[5]).toMatchObject({totalMinor:0,items:[],fixedSourceMonth:'2027-03'});
    expect(result.months[8]).toMatchObject({totalMinor:0,items:[],fixedSourceMonth:'2027-03'});
    expect((await fixture.sql.query('SELECT * FROM olbia.month_plans ORDER BY month')).rows).toEqual(before);
    expect(result.nextStartMonth).toBe('2027-10');
    expect((await readFutureCommitments('owner',result.nextStartMonth,now,fixture.pool)).months[0]).toMatchObject({month:'2027-10',totalMinor:0});
  });

  it('returns every empty month and uses Chihuahua at the UTC month boundary', async () => {
    const result = await readFutureCommitments('owner',undefined,new Date('2026-11-01T02:00:00Z'),fixture.pool);
    expect(result.currentMonth).toBe('2026-10');
    expect(result.months).toHaveLength(12);
    expect(result.months.every(month=>month.totalMinor===0 && month.fixedSourceMonth===null && month.items.length===0)).toBe(true);
  });

  it('excludes an explicitly covered monthly fixed occurrence without inheriting its charge or reducing it by Mi parte', async () => {
    await plan('2026-09',399_00);
    await plan('2026-10',399_00);
    await fixture.sql.query("INSERT INTO olbia.planned_payments VALUES ('2026-10','internet','Internet',10000,18,1)");
    const id = await fixture.create({ amount: { amountMinor: 450_00, currency: 'MXN' }, personalAmountMinor: 200_00,
      occurredAt: '2026-10-18T12:00:00Z' });
    await fixture.sql.query(`INSERT INTO olbia.planned_payment_charges
      (month,payment_id,movement_id,linked_at,linked_by) VALUES ($1,$2,$3,$4,$5)`,
    ['2026-10','rent',id,now.toISOString(),'owner']);
    const read = () => readFutureCommitments('owner',undefined,now,fixture.pool);
    const linked = await read();
    expect(linked.months[0]).toMatchObject({ fixedMinor: 100_00, totalMinor: 100_00,
      items: [{ kind: 'fixed', id: 'internet', amountMinor: 100_00 }] });
    expect(linked.months[1]).toMatchObject({ fixedMinor: 499_00, totalMinor: 499_00, fixedSourceMonth: '2026-10' });
    for (const month of linked.months) expect(month.items.reduce((sum,item) => sum + item.amountMinor,0)).toBe(month.totalMinor);

    await fixture.sql.query('UPDATE olbia.ledger_movements SET personal_amount_minor=0,status=$2 WHERE id=$1',[id,'needs_review']);
    expect((await read()).months[0]).toMatchObject({ fixedMinor: 100_00, totalMinor: 100_00 });
    await fixture.sql.query('UPDATE olbia.ledger_movements SET status=$2 WHERE id=$1',[id,'rejected']);
    expect((await read()).months[0]).toMatchObject({ fixedMinor: 499_00, totalMinor: 499_00 });
    expect((await fixture.sql.query('SELECT movement_id FROM olbia.planned_payment_charges')).rows).toHaveLength(1);
    await fixture.sql.query('UPDATE olbia.ledger_movements SET status=$2 WHERE id=$1',[id,'accepted']);
    expect((await read()).months[0]).toMatchObject({ fixedMinor: 100_00, totalMinor: 100_00 });
  });

  it('only applies active MXN non-MSI charges in the relationship month using Chihuahua boundaries', async () => {
    await plan('2026-10',399_00);
    const id = await fixture.create({ occurredAt: '2026-11-01T02:00:00Z' });
    await fixture.sql.query(`INSERT INTO olbia.planned_payment_charges
      (month,payment_id,movement_id,linked_at,linked_by) VALUES ($1,$2,$3,$4,$5)`,
    ['2026-10','rent',id,now.toISOString(),'owner']);
    const currentFixed = async () => (await readFutureCommitments('owner',undefined,now,fixture.pool)).months[0]!.fixedMinor;
    expect(await currentFixed()).toBe(0);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET occurred_at='2026-11-01T07:00:00Z' WHERE id=$1",[id]);
    expect(await currentFixed()).toBe(399_00);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET occurred_at='2026-10-18T12:00:00Z',currency='USD' WHERE id=$1",[id]);
    expect(await currentFixed()).toBe(399_00);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET currency='MXN',status='deferred_msi' WHERE id=$1",[id]);
    expect(await currentFixed()).toBe(399_00);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET status='accepted',amount_minor=0 WHERE id=$1",[id]);
    expect(await currentFixed()).toBe(399_00);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET amount_minor=10000 WHERE id=$1",[id]);
    await fixture.sql.query('INSERT INTO olbia.installment_plans VALUES ($1,3,30000,10000,$2,$3,false)',[id,'manual','active']);
    expect(await currentFixed()).toBe(399_00);
  });

  it('rejects malformed, past and unbounded requests before querying SQL', async () => {
    const client = {query: async () => { throw new Error('Should not query'); }};
    for (const month of ['2026-13','2026-09','2040-01',"2026-10';DROP TABLE"]) {
      await expect(readFutureCommitments('owner',month,now,client)).rejects.toBeInstanceOf(InvalidMonthlyPlanError);
    }
  });
});
