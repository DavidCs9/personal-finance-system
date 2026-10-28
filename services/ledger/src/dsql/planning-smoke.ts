import { randomUUID } from 'node:crypto';
import type { SqlClient } from './projection.js';

/** Deployment caller guarantees rollback; never use this helper as a financial mutation. */
export const smokeNativePlanning = async (client: SqlClient, owner: string, movementId: string): Promise<void> => {
  const plan=(await client.query('SELECT month FROM olbia.month_plans WHERE owner=$1 ORDER BY month LIMIT 1',[owner])).rows[0];
  if (!plan) throw new Error('No native month plan for smoke');
  const upserted=(await client.query(`INSERT INTO olbia.month_plans (month,owner,updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
    ON CONFLICT (month) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING month`,[plan.month,owner])).rows[0];
  if (upserted?.month!==plan.month) throw new Error('Native plan upsert failed');
  const at=new Date().toISOString(),paymentId=`sql-verification-${randomUUID()}`;
  // Retained history is never deleted. These current rows are restored by the caller's rollback.
  await client.query('DELETE FROM olbia.planned_payment_charges WHERE month=$1',[plan.month]);
  await client.query('DELETE FROM olbia.planned_payments WHERE month=$1',[plan.month]);
  await client.query(`INSERT INTO olbia.planned_payments (month,id,name,amount_mxn_minor,due_day,sort_order)
    VALUES ($1,$2,'SQL verification',1,31,0)`,[plan.month,paymentId]);
  await client.query(`INSERT INTO olbia.planned_payment_charges (month,payment_id,movement_id,linked_at,linked_by)
    VALUES ($1,$2,$3,$4,$5)`,[plan.month,paymentId,movementId,at,owner]);
  const read=(await client.query(`SELECT p.amount_mxn_minor,c.movement_id FROM olbia.planned_payments p
    JOIN olbia.planned_payment_charges c ON c.month=p.month AND c.payment_id=p.id
    WHERE p.month=$1 AND p.id=$2`,[plan.month,paymentId])).rows[0];
  if (Number(read?.amount_mxn_minor)!==1 || read?.movement_id!==movementId) throw new Error('Native payment relationship failed');
  const insertRevision=`INSERT INTO olbia.planned_payment_charge_revisions
    (id,month,payment_id,created_at,changed_by,reason,previous_movement_id,next_movement_id,payment_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const assertion=JSON.stringify({id:paymentId,name:'SQL verification',amountMinor:1,dueDay:31});
  await client.query(insertRevision,[randomUUID(),plan.month,paymentId,at,owner,'link',null,movementId,assertion]);
  await client.query('DELETE FROM olbia.planned_payment_charges WHERE month=$1 AND payment_id=$2',[plan.month,paymentId]);
  await client.query(insertRevision,[randomUUID(),plan.month,paymentId,at,owner,'unlink',movementId,null,assertion]);
  await client.query('DELETE FROM olbia.planned_payments WHERE month=$1 AND id=$2',[plan.month,paymentId]);
  const history=(await client.query('SELECT id FROM olbia.planned_payment_charge_revisions WHERE month=$1 AND payment_id=$2',[plan.month,paymentId])).rows;
  if (history.length!==2 || !(await client.query('SELECT month FROM olbia.month_plans WHERE month=$1',[plan.month])).rows.length)
    throw new Error('Native payment history or empty parent lost');
};
