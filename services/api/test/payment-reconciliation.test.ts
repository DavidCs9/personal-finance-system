import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentSqlClient, withSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import { nativeFixture } from './fixtures/native-ledger.js';
import * as readers from '../src/events/sql-reads.js';
import { InvalidMonthlyPlanError } from '../src/months/monthly-plan.js';

vi.mock('../src/imports/cfdi-nomina-flow.js', () => ({ incomeFieldsForMonth: async () => ({
  configured:false,incomeMinor:0,depositedMinor:0,estimatedMinor:0,estimateActive:false,
  provisionalActive:false,provisionalMinor:0,payslips:[],
}) }));
const { getMonthlyPlan, saveMonthlyPlan } = await import('../src/months/service.js');
const { parsePaymentReconciliationInput, PaymentReconciliationConflictError, savePaymentReconciliation } = await import('../src/months/reconciliation.js');
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
const month='2026-10';
const openai={id:'openai',name:'OpenAI',amountMinor:39900,dueDay:18};
const cloud={id:'cloud',name:'iCloud',amountMinor:1700,dueDay:17};
const plan = async (target=month,payments=[openai,cloud]) => fixture.run(() => saveMonthlyPlan('owner',target,{currency:'MXN',upcomingPayments:payments}));
const link = (paymentId:string,eventId:string|null,expectedEventId:string|null,target=month,owner='owner') =>
  fixture.run(() => savePaymentReconciliation(owner,target,paymentId,{eventId,expectedEventId}));
const journal = async () => (await fixture.sql.query<Record<string,unknown>>('SELECT * FROM olbia.planned_payment_charge_revisions ORDER BY created_at,id')).rows;
beforeAll(async () => { fixture=await nativeFixture(); },30000);
afterAll(async () => fixture.sql.close());
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql.exec('TRUNCATE olbia.month_plans,olbia.planned_payments,olbia.planned_payment_charges,olbia.planned_payment_charge_revisions');
  vi.spyOn(readers,'readerPool').mockImplementation(() => currentSqlClient() ?? fixture.sql);
});

describe('explicit monthly fixed-charge relationships', () => {
  it('requires explicit nullable current and desired identities', () => {
    const eventId=randomUUID();
    expect(parsePaymentReconciliationInput(JSON.stringify({eventId,expectedEventId:null}))).toEqual({eventId,expectedEventId:null});
    for (const value of [undefined,'not-json','[]','null','{}',JSON.stringify({eventId}),
      JSON.stringify({eventId:'not-an-id',expectedEventId:null}),JSON.stringify({eventId:null,expectedEventId:7})])
      expect(() => parsePaymentReconciliationInput(value)).toThrow(InvalidMonthlyPlanError);
  });

  it('links unequal amounts explicitly, preserves originals, and audits idempotent link/unlink/undo', async () => {
    await plan();
    const eventId=await fixture.create({merchantRaw:'OPENAI',amount:{amountMinor:45000,currency:'MXN'}});
    const observed=(await fixture.sql.query('SELECT * FROM olbia.ledger_observations')).rows;
    const result=await link(openai.id,eventId,null);
    expect(result.upcomingPayments).toEqual(expect.arrayContaining([expect.objectContaining({id:openai.id,
      reconciliation:{eventId,merchantRaw:'OPENAI',amountMinor:45000,grossAmountMinor:45000,
        occurredAt:'2026-10-02T12:00:00.123Z',valid:true}})]));
    await link(openai.id,eventId,null); // A transport retry of the same desired link is harmless.
    expect(await journal()).toHaveLength(1);
    await link(openai.id,null,eventId);
    expect((await fixture.sql.query('SELECT * FROM olbia.planned_payment_charges')).rows).toEqual([]);
    await link(openai.id,eventId,null);
    const changes=await journal();
    expect(changes.map(row=>row.reason).sort()).toEqual(['link','link','unlink']);
    expect(changes.some(row=>row.previous_movement_id===eventId && row.next_movement_id===null)).toBe(true);
    expect((await fixture.sql.query('SELECT * FROM olbia.ledger_observations')).rows).toEqual(observed);
  });

  it('prevents a stale edit or a charge reused by another fixed item from overwriting current intent', async () => {
    await plan();
    const first=await fixture.create(), second=await fixture.create();
    await link(openai.id,first,null);
    await expect(link(openai.id,second,null)).rejects.toBeInstanceOf(PaymentReconciliationConflictError);
    await expect(link(cloud.id,first,null)).rejects.toBeInstanceOf(PaymentReconciliationConflictError);
    await expect(link(openai.id,null,second)).rejects.toBeInstanceOf(PaymentReconciliationConflictError);
    expect((await fixture.sql.query('SELECT movement_id FROM olbia.planned_payment_charges')).rows).toEqual([{movement_id:first}]);
    expect(await journal()).toHaveLength(1);
    await link(openai.id,second,first);
    expect((await fixture.sql.query('SELECT movement_id FROM olbia.planned_payment_charges')).rows).toEqual([{movement_id:second}]);
  });

  it('materializes the full inherited list only on a real link and never carries its relationship forward', async () => {
    await plan('2026-09');
    await getMonthlyPlan('owner',month);
    expect((await fixture.sql.query('SELECT month FROM olbia.month_plans')).rows).toEqual([{month:'2026-09'}]);
    const id=await fixture.create();
    await link(openai.id,id,null);
    expect((await fixture.sql.query('SELECT id FROM olbia.planned_payments WHERE month=$1 ORDER BY sort_order',[month])).rows)
      .toEqual([{id:openai.id},{id:cloud.id}]);
    const future=await getMonthlyPlan('owner','2026-11');
    expect(future.inheritedFromMonth).toBe(month);
    expect(future.upcomingPayments).toEqual([openai,cloud]);
    expect((await getMonthlyPlan('owner','2026-09')).upcomingPayments).toEqual([openai,cloud]);
  });

  it('preserves an exact link across reordering, but audits invalidation after a material edit', async () => {
    await plan(); const id=await fixture.create(); await link(openai.id,id,null);
    const before=(await fixture.sql.query('SELECT * FROM olbia.planned_payment_charges')).rows;
    await plan(month,[cloud,openai]);
    expect((await fixture.sql.query('SELECT * FROM olbia.planned_payment_charges')).rows).toEqual(before);
    expect(await journal()).toHaveLength(1);
    await plan(month,[cloud,{...openai,amountMinor:45000}]);
    expect((await fixture.sql.query('SELECT * FROM olbia.planned_payment_charges')).rows).toEqual([]);
    expect(await journal()).toEqual(expect.arrayContaining([expect.objectContaining({reason:'payment_changed',
      previous_movement_id:id,next_movement_id:null,payment_snapshot:openai})]));
    for (const changed of [{...openai,name:'Otro servicio'},{...openai,dueDay:19}]) {
      await plan(month,[cloud,openai]); await link(openai.id,id,null);
      await plan(month,[cloud,changed]);
      expect((await fixture.sql.query('SELECT * FROM olbia.planned_payment_charges')).rows).toEqual([]);
    }
    expect((await journal()).filter(row=>row.reason==='payment_changed')).toHaveLength(3);
  });

  it('rejects deleting a linked payment before any plan-row mutation, until an explicit unlink', async () => {
    await plan(); const id=await fixture.create(); await link(openai.id,id,null);
    const before=await getMonthlyPlan('owner',month), history=await journal();
    const query=vi.spyOn(fixture.sql,'query');
    await expect(plan(month,[cloud])).rejects.toThrow('Desvincula el cobro');
    expect(query.mock.calls.some(([sql])=>/^DELETE FROM olbia\.(?:planned_payments|planned_payment_charges)/.test(sql))).toBe(false);
    expect(await getMonthlyPlan('owner',month)).toEqual(before); expect(await journal()).toEqual(history);
    await link(openai.id,null,id); await plan(month,[cloud]);
    expect((await getMonthlyPlan('owner',month)).upcomingPayments).toEqual([cloud]);
    expect(await journal()).toHaveLength(2);
  });

  it('invalidates reads after rejection, foreign currency, MSI conversion or month drift, including gross zero', async () => {
    for (const change of ["status='rejected'","currency='USD'","amount_minor=0","occurred_at='2026-11-01T12:00:00Z'",'msi']) {
      await plan(); const id=await fixture.create(); await link(openai.id,id,null);
      if (change==='msi') await fixture.sql.query("INSERT INTO olbia.installment_plans VALUES ($1,3,30000,10000,'manual','active',NULL)",[id]);
      else await fixture.sql.query(`UPDATE olbia.ledger_movements SET ${change} WHERE id=$1`,[id]);
      const result=await getMonthlyPlan('owner',month);
      expect(result.upcomingPayments).toEqual(expect.arrayContaining([expect.objectContaining({id:openai.id,
        reconciliation:expect.objectContaining({eventId:id,valid:false,invalidReason:expect.any(String)})})]));
      await expect(link(openai.id,id,id)).rejects.toBeInstanceOf(InvalidMonthlyPlanError);
      await link(openai.id,null,id);
    }
  });

  it('allows Mi parte zero with positive gross and uses Chihuahua month boundaries', async () => {
    await plan();
    const id=await fixture.create({personalAmountMinor:0,occurredAt:'2026-11-01T05:59:59.999Z'});
    const result=await link(openai.id,id,null);
    expect(result.upcomingPayments).toEqual(expect.arrayContaining([expect.objectContaining({id:openai.id,
      reconciliation:expect.objectContaining({eventId:id,valid:true,amountMinor:0,grossAmountMinor:10000})})]));
    const other=await fixture.create({occurredAt:'2026-11-01T06:00:00.000Z'});
    await expect(link(cloud.id,other,null)).rejects.toThrow('otro mes');
  });

  it('rolls back inherited materialization, relation and journal on an interrupted transaction', async () => {
    await plan('2026-09'); const id=await fixture.create();
    const before=await fixture.snapshot();
    await expect(fixture.sql.transaction(client => withSqlClient(client as unknown as SqlClient,async () => {
      await savePaymentReconciliation('owner',month,openai.id,{eventId:id,expectedEventId:null});
      throw new Error('Interrupted');
    }))).rejects.toThrow('Interrupted');
    expect(await fixture.snapshot()).toEqual(before);
    expect((await fixture.sql.query('SELECT month FROM olbia.month_plans')).rows).toEqual([{month:'2026-09'}]);
  });

  it('fails closed for absent payments, unknown movement identities and another owner', async () => {
    await plan(); const id=await fixture.create();
    await expect(link(openai.id,id,null,month,'different')).rejects.toThrow('no está disponible');
    await expect(link('absent',id,null)).rejects.toThrow('no está disponible');
    await expect(link(openai.id,randomUUID(),null)).rejects.toThrow('no está disponible');
    expect(await journal()).toEqual([]);
  });

  it('never exposes another owner\'s target-month relationship through an inherited source list', async () => {
    await plan('2026-09');
    await fixture.run(() => saveMonthlyPlan('different',month,{currency:'MXN',upcomingPayments:[openai]}));
    const id=await fixture.create();
    await link(openai.id,id,null,month,'different');
    const inherited=await getMonthlyPlan('owner',month);
    expect(inherited).toMatchObject({inheritedFromMonth:'2026-09',upcomingPayments:[openai,cloud]});
    await expect(link(openai.id,null,null)).rejects.toThrow('no está disponible');
    expect(await journal()).toHaveLength(1);
  });
});
