import { randomUUID } from 'node:crypto';
import type { ReadSqlClient as SqlClient } from '../events/sql-reads.js';
import { InvalidMonthlyPlanError, type PlannedPaymentRecord } from './monthly-plan.js';

export interface StoredPaymentCharge {
  readonly month: string; readonly payment_id: string; readonly movement_id: string;
  readonly linked_at: string | Date; readonly linked_by: string;
}

export const readPaymentCharges = async (client: SqlClient, month: string): Promise<readonly StoredPaymentCharge[]> =>
  (await client.query('SELECT month,payment_id,movement_id,linked_at,linked_by FROM olbia.planned_payment_charges WHERE month=$1', [month])).rows as unknown as StoredPaymentCharge[];

export const assertPaymentChargeMembership = (links: readonly StoredPaymentCharge[], payments: readonly PlannedPaymentRecord[]): void => {
  if (links.some(link => !payments.some(payment => payment.id===link.payment_id)))
    throw new InvalidMonthlyPlanError('Desvincula el cobro antes de eliminar este gasto fijo.');
};

export const appendPaymentChargeRevision = async (client: SqlClient, input: {
  readonly month: string; readonly payment: PlannedPaymentRecord; readonly changedBy: string;
  readonly reason: 'link' | 'unlink' | 'payment_changed' | 'payment_removed';
  readonly previous: string | null; readonly next: string | null; readonly createdAt: string;
}): Promise<void> => {
  const { id,name,amountMinor,dueDay } = input.payment;
  await client.query(`INSERT INTO olbia.planned_payment_charge_revisions
    (id,month,payment_id,created_at,changed_by,reason,previous_movement_id,next_movement_id,payment_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),input.month,id,input.createdAt,input.changedBy,
    input.reason,input.previous,input.next,JSON.stringify({ id,name,amountMinor,dueDay })]);
};

/** Rebuild current children without deferred FKs; removed/changed links remain in immutable history. */
export const replaceMonthlyPaymentRows = async (client: SqlClient, owner: string, month: string,
  payments: readonly PlannedPaymentRecord[], at: string, retainedLinks?: readonly StoredPaymentCharge[]): Promise<void> => {
  const previous = (await client.query('SELECT id,name,amount_mxn_minor,due_day FROM olbia.planned_payments WHERE month=$1',[month])).rows;
  const links = retainedLinks ?? await readPaymentCharges(client,month);
  assertPaymentChargeMembership(links,payments);
  await client.query('DELETE FROM olbia.planned_payment_charges WHERE month=$1',[month]);
  await client.query('DELETE FROM olbia.planned_payments WHERE month=$1',[month]);
  for (const [order,payment] of payments.entries()) await client.query(`INSERT INTO olbia.planned_payments
    (month,id,name,amount_mxn_minor,due_day,sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
    [month,payment.id,payment.name,payment.amountMinor,payment.dueDay,order]);
  for (const link of links) {
    const old = previous.find(payment => payment.id===link.payment_id)!;
    const next = payments.find(payment => payment.id===link.payment_id);
    if (next && next.name===old.name && next.amountMinor===Number(old.amount_mxn_minor) && next.dueDay===old.due_day) {
      await client.query(`INSERT INTO olbia.planned_payment_charges
        (month,payment_id,movement_id,linked_at,linked_by) VALUES ($1,$2,$3,$4,$5)`,
        [month,link.payment_id,link.movement_id,link.linked_at,link.linked_by]);
    } else {
      await appendPaymentChargeRevision(client,{ month, payment:{ id:String(old.id),name:String(old.name),
        amountMinor:Number(old.amount_mxn_minor),dueDay:Number(old.due_day) },changedBy:owner,createdAt:at,
        reason: next ? 'payment_changed' : 'payment_removed',previous:link.movement_id,next:null });
    }
  }
};
