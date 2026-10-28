import { withSqlTransaction } from '@finance/ledger/sql-runtime';
import { isLedgerMovementId } from '@finance/ledger/native-ledger';
import { getMonthlyPlan, saveMonthlyPlan } from './service.js';
import { isValidMonth, InvalidMonthlyPlanError, type PlannedPaymentRecord } from './monthly-plan.js';
import { readSqlPlanRecord, reconciliationFromRow, reconciliationMovementColumns } from './sql-reads.js';
import { appendPaymentChargeRevision, readPaymentCharges } from './reconciliation-storage.js';
import type { JsonObject } from '../http/response.js';

export class PaymentReconciliationConflictError extends Error {}
export interface PaymentReconciliationInput {
  readonly eventId: string | null;
  readonly expectedEventId: string | null;
  readonly expectedPayment: Pick<PlannedPaymentRecord, 'name' | 'amountMinor' | 'dueDay'>;
}

export const parsePaymentReconciliationInput = (body: string | undefined): PaymentReconciliationInput => {
  let value: unknown;
  try { value=JSON.parse(body ?? ''); } catch { throw new InvalidMonthlyPlanError('La conciliación no tiene un formato válido.'); }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new InvalidMonthlyPlanError('La conciliación no tiene un formato válido.');
  const input=value as Record<string,unknown>;
  for (const key of ['eventId','expectedEventId']) if (input[key]!==null && (typeof input[key]!=='string' || !isLedgerMovementId(input[key])))
    throw new InvalidMonthlyPlanError('Elige un movimiento y vuelve a consultar el vínculo actual.');
  if (!input.expectedPayment || typeof input.expectedPayment!=='object' || Array.isArray(input.expectedPayment))
    throw new InvalidMonthlyPlanError('Vuelve a consultar la programación del gasto fijo antes de conciliar.');
  const expected=input.expectedPayment as Record<string,unknown>;
  if (typeof expected.name!=='string' || !expected.name.trim() || expected.name.trim().length>100
    || !Number.isSafeInteger(expected.amountMinor) || Number(expected.amountMinor)<=0
    || !Number.isInteger(expected.dueDay) || Number(expected.dueDay)<1 || Number(expected.dueDay)>31)
    throw new InvalidMonthlyPlanError('La programación esperada del gasto fijo no es válida.');
  return { eventId:input.eventId as string|null, expectedEventId:input.expectedEventId as string|null,
    expectedPayment:{name:expected.name.trim(),amountMinor:Number(expected.amountMinor),dueDay:Number(expected.dueDay)} };
};

export const savePaymentReconciliation = async (owner: string, month: string, paymentId: string,
  input: PaymentReconciliationInput): Promise<JsonObject> => {
  if (!isValidMonth(month) || !paymentId || paymentId.length>128) throw new InvalidMonthlyPlanError('El mes o gasto fijo no es válido.');
  // Validate direct domain callers as well as HTTP input.
  const validated=parsePaymentReconciliationInput(JSON.stringify(input));
  return withSqlTransaction(async client => {
    const target=(await client.query('SELECT owner FROM olbia.month_plans WHERE month=$1',[month])).rows[0];
    if (target && target.owner!==owner) throw new InvalidMonthlyPlanError('El gasto fijo ya no está disponible en este mes.');
    const plan=await readSqlPlanRecord(owner,month,client);
    const payment=plan?.upcomingPayments.find(item => item.id===paymentId);
    if (!plan || !payment) throw new InvalidMonthlyPlanError('El gasto fijo ya no está disponible en este mes.');
    const expected=validated.expectedPayment;
    if (payment.name!==expected.name || payment.amountMinor!==expected.amountMinor || payment.dueDay!==expected.dueDay)
      throw new PaymentReconciliationConflictError('La programación de este fijo cambió. Actualiza este mes antes de conciliar de nuevo.');
    const current=(await readPaymentCharges(client,month)).find(link => link.payment_id===paymentId);
    const previous=current?.movement_id ?? null;
    if (previous!==validated.expectedEventId && previous!==validated.eventId)
      throw new PaymentReconciliationConflictError('El vínculo cambió. Actualiza este mes antes de conciliar de nuevo.');
    if (validated.eventId!==null) {
      const row=(await client.query(`SELECT ${reconciliationMovementColumns} FROM olbia.ledger_movements m WHERE m.id=$1`,[validated.eventId])).rows[0];
      const candidate=row && reconciliationFromRow(row,month);
      if (!candidate || !candidate.valid) throw new InvalidMonthlyPlanError(candidate?.invalidReason ?? 'El movimiento elegido ya no está disponible.');
      const used=(await client.query('SELECT month,payment_id FROM olbia.planned_payment_charges WHERE movement_id=$1',[validated.eventId])).rows[0];
      if (used && (used.month!==month || used.payment_id!==paymentId))
        throw new PaymentReconciliationConflictError('Ese movimiento ya está vinculado a otro gasto fijo.');
    }
    if (previous===validated.eventId) return getMonthlyPlan(owner,month);
    // A confirmed relationship belongs only to this month, never to an inherited source month.
    if (plan.month!==month) await saveMonthlyPlan(owner,month,{ currency:'MXN',upcomingPayments:plan.upcomingPayments });
    const at=new Date().toISOString();
    await client.query('DELETE FROM olbia.planned_payment_charges WHERE month=$1 AND payment_id=$2',[month,paymentId]);
    if (validated.eventId!==null) await client.query(`INSERT INTO olbia.planned_payment_charges
      (month,payment_id,movement_id,linked_at,linked_by) VALUES ($1,$2,$3,$4,$5)`,[month,paymentId,validated.eventId,at,owner]);
    await appendPaymentChargeRevision(client,{ month,payment,changedBy:owner,createdAt:at,
      reason: validated.eventId===null ? 'unlink' : 'link',previous,next:validated.eventId });
    await client.query('UPDATE olbia.month_plans SET updated_at=$2 WHERE month=$1',[month,at]);
    return getMonthlyPlan(owner,month);
  });
};
