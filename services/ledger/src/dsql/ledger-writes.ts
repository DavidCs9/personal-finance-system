import { normalizeEventTags, type MsiPlan } from '@finance/domain';
import type { CaptureSource,ObservedEventInput } from '../observed-events.js';
import type { SqlClient } from './projection.js';
import { ledgerMutationBudgetActive, reserveLedgerMutations } from './ledger-budget.js';

type Row=Record<string,unknown>;
export class InvalidLedgerWriteError extends Error {}
export class LedgerPreconditionError extends Error {}
const optional=(value:unknown)=>value===undefined?null:value;
const invalid=():never=>{throw new InvalidLedgerWriteError('Invalid financial ledger input');};
const assertMoney=(value:number)=>{if(!Number.isSafeInteger(value))invalid();};
const accountValues=(value:Readonly<Record<string,unknown>>|undefined):unknown[]=>{
  if(value && Object.keys(value).some(key=>!['accountId','displayName','institution','lastFour'].includes(key)))invalid();
  return [value!==undefined,optional(value?.accountId),optional(value?.displayName),optional(value?.institution),optional(value?.lastFour)];
};
const warnings=(values:readonly string[])=>{if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))invalid();};
const millis=(value:unknown)=>value instanceof Date?value.getTime():Date.parse(String(value));
const known=(value:object,fields:readonly string[])=>{if(Object.keys(value).some(key=>!fields.includes(key)))invalid();};

export interface NativeObservationInput {
  readonly id:string;readonly movementId:string;readonly captureSource:CaptureSource;
  readonly observedAt:string;readonly reconciliationAt:string;readonly institution:string;readonly eventType:string;
  readonly amount:ObservedEventInput['amount'];readonly merchantRaw:string;readonly occurredAt?:string;
  readonly account?:Readonly<Record<string,unknown>>;readonly source:Readonly<Record<string,unknown>>;
  readonly parserVersion:string;readonly parseWarnings:readonly string[];
  readonly bankTransactionId?:string;readonly rowNumber?:number;readonly note?:string;
}
export interface BankRowEvidence {
  readonly installmentIndex:number;readonly kind:'amex_statement'|'amex_activity'|'santander_statement'|'santander_csv';
  readonly contentSha256:string;readonly rowPosition:number;
}
export interface NativeClaimInput {
  readonly captureSource:CaptureSource;readonly token:string;readonly createdAt:string;
  readonly movementId:string;readonly observationId:string;readonly owner?:string;
  readonly rowIdentity?:string;readonly fingerprint?:string;readonly reconciled?:boolean;
}
export const readSourceClaim=async(client:SqlClient,kind:CaptureSource,token:string):Promise<Row|undefined>=>
  (await client.query('SELECT * FROM olbia.source_claims WHERE capture_source=$1 AND token=$2',[kind,token])).rows[0];
export const insertSourceClaim=async(client:SqlClient,input:NativeClaimInput):Promise<void>=>{
  reserveLedgerMutations(1);
  await client.query(`INSERT INTO olbia.source_claims
    (capture_source,token,created_at,owner,row_identity,fingerprint,reconciled,outcome,movement_id,observation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'linked',$8,$9)`,[input.captureSource,input.token,input.createdAt,
    optional(input.owner),optional(input.rowIdentity),optional(input.fingerprint),optional(input.reconciled),input.movementId,input.observationId]);
};
export const claimIgnoredEmail=async(client:SqlClient,token:string,createdAt:string):Promise<boolean>=>{
  reserveLedgerMutations(1);
  return (await client.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome)
    VALUES ('email',$1,$2,'suppressed') ON CONFLICT (capture_source,token) DO NOTHING RETURNING token`,[token,createdAt])).rows.length===1;
};

export const insertLedgerMovement=async(client:SqlClient,event:ObservedEventInput,primaryObservationId:string,reconciliationAt:string,
  evidence:readonly BankRowEvidence[]=[]):Promise<void>=>{
  known(event,['id','institution','eventType','status','account','amount','merchantRaw','occurredAt','receivedAt','ingestedAt',
    'source','parserVersion','parseWarnings','reconciledAt','categoryId','personalAmountMinor','tags','msi','bankTransactionId',
    'sourceMessageId','counterparty','trackingKey','folio','reference','transferType','counterpartyInstitution',
    'counterpartyAccountLastFour','billingPeriod','paymentMethodLastFour','captureSource','captureSources','observationCount',
    'primaryObservationId','hasRawEmail']);
  known(event.amount,['amountMinor','currency']);
  assertMoney(event.amount.amountMinor);warnings(event.parseWarnings);
  reserveLedgerMutations(1);
  await client.query(`INSERT INTO olbia.ledger_movements
    (id,primary_observation_id,institution,event_type,status,amount_minor,currency,merchant_raw,occurred_at,
      received_at,ingested_at,reconciliation_at,reconciled_at,account_present,account_id,account_name,
      account_institution,account_last_four,category_id,personal_amount_minor,bank_transaction_id,source_message_id,
      counterparty,tracking_key,folio,reference,transfer_type,counterparty_institution,counterparty_account_last_four,
      billing_period,payment_method_last_four)
    VALUES (${Array.from({length:31},(_,n)=>`$${n+1}`).join(',')})`,[
    event.id,primaryObservationId,event.institution,event.eventType,event.status,event.amount.amountMinor,event.amount.currency,
    event.merchantRaw,optional(event.occurredAt),event.receivedAt,event.ingestedAt,reconciliationAt,optional(event.reconciledAt),
    ...accountValues(event.account),optional(event.categoryId),optional(event.personalAmountMinor),optional(event.bankTransactionId),
    optional(event.sourceMessageId),optional(event.counterparty),optional(event.trackingKey),optional(event.folio),optional(event.reference),
    optional(event.transferType),optional(event.counterpartyInstitution),optional(event.counterpartyAccountLastFour),
    optional(event.billingPeriod),optional(event.paymentMethodLastFour)]);
  await replaceMovementWarnings(client,event.id,event.parseWarnings);
  if(event.tags!==undefined)await replaceMovementTags(client,event.id,normalizeEventTags(event.tags as readonly string[]));
  if(event.msi!==undefined)await replaceInstallmentPlan(client,event.id,event.msi as MsiPlan,evidence);
};

export const appendLedgerObservation=async(client:SqlClient,input:NativeObservationInput):Promise<void>=>{
  known(input.amount,['amountMinor','currency']);
  assertMoney(input.amount.amountMinor);warnings(input.parseWarnings);
  const metadata={...input.source};for(const key of ['bucket','key','sha256','contentType','kind'])delete metadata[key];
  reserveLedgerMutations(1+input.parseWarnings.length);
  await client.query(`INSERT INTO olbia.ledger_observations
    (id,movement_id,position,capture_source,observed_at,reconciliation_at,institution,event_type,amount_minor,
      currency,merchant_raw,occurred_at,account_present,account_id,account_name,account_institution,account_last_four,
      parser_version,bank_transaction_id,csv_row_number,note,evidence_bucket,evidence_key,evidence_sha256,
      evidence_content_type,source_kind,source_metadata)
    VALUES ($1,$2,(SELECT COALESCE(max(position),-1)+1 FROM olbia.ledger_observations WHERE movement_id=$2),
      ${Array.from({length:24},(_,n)=>`$${n+3}`).join(',')})`,[
    input.id,input.movementId,input.captureSource,input.observedAt,input.reconciliationAt,input.institution,input.eventType,
    input.amount.amountMinor,input.amount.currency,input.merchantRaw,optional(input.occurredAt),...accountValues(input.account),
    input.parserVersion,optional(input.bankTransactionId),optional(input.rowNumber),optional(input.note),
    optional(input.source.bucket),optional(input.source.key),optional(input.source.sha256),optional(input.source.contentType),
    optional(input.source.kind),JSON.stringify(metadata)]);
  for(const [position,message] of input.parseWarnings.entries())await client.query(
    'INSERT INTO olbia.ledger_observation_warnings VALUES ($1,$2,$3)',[input.id,position,message]);
};

export const replaceMovementWarnings=async(client:SqlClient,id:string,values:readonly string[]):Promise<void>=>{
  warnings(values);
  if(ledgerMutationBudgetActive())reserveLedgerMutations(values.length+Number((await client.query(
    'SELECT count(*) AS count FROM olbia.ledger_movement_warnings WHERE movement_id=$1',[id])).rows[0].count));
  await client.query('DELETE FROM olbia.ledger_movement_warnings WHERE movement_id=$1',[id]);
  for(const [position,message] of values.entries())await client.query('INSERT INTO olbia.ledger_movement_warnings VALUES ($1,$2,$3)',[id,position,message]);
};
export const replaceMovementTags=async(client:SqlClient,id:string,values:readonly string[]):Promise<void>=>{
  const tags=normalizeEventTags(values);
  if(ledgerMutationBudgetActive())reserveLedgerMutations(tags.length+Number((await client.query(
    'SELECT count(*) AS count FROM olbia.ledger_tags WHERE movement_id=$1',[id])).rows[0].count));
  await client.query('DELETE FROM olbia.ledger_tags WHERE movement_id=$1',[id]);
  for(const [position,tag] of tags.entries())await client.query('INSERT INTO olbia.ledger_tags VALUES ($1,$2,$3)',[id,position,tag]);
};
export const setMovementCategory=async(client:SqlClient,id:string,categoryId:string|null):Promise<void>=>{
  reserveLedgerMutations(1);
  if(!(await client.query('UPDATE olbia.ledger_movements SET category_id=$2 WHERE id=$1 RETURNING id',[id,categoryId])).rows.length)
    throw new LedgerPreconditionError('Movement no longer exists');
};
export const setMovementPersonalAmount=async(client:SqlClient,id:string,value:number|undefined):Promise<void>=>{
  if(value!==undefined)assertMoney(value);
  reserveLedgerMutations(1);
  const updated=await client.query(`UPDATE olbia.ledger_movements SET personal_amount_minor=$2 WHERE id=$1 AND
    ($2::bigint IS NULL OR (status<>'pending_foreign' AND NOT EXISTS
      (SELECT 1 FROM olbia.installment_plans p WHERE p.movement_id=$1))) RETURNING id`,[id,optional(value)]);
  if(!updated.rows.length)throw new LedgerPreconditionError('Movement is not available for Mi parte');
};
export const setMovementStatus=async(client:SqlClient,id:string,status:string,parseWarnings?:readonly string[]):Promise<void>=>{
  reserveLedgerMutations(1);
  const result=await client.query(`UPDATE olbia.ledger_movements SET status=$2 WHERE id=$1
    AND (status<>'pending_foreign' OR $2='rejected') RETURNING id`,[id,status]);
  if(!result.rows.length)throw new LedgerPreconditionError('Movement status changed or awaits posted MXN');
  if(parseWarnings!==undefined)await replaceMovementWarnings(client,id,parseWarnings);
};
export const markMovementReconciled=async(client:SqlClient,id:string,at:string):Promise<void>=>{
  reserveLedgerMutations(1);
  if(!(await client.query('UPDATE olbia.ledger_movements SET reconciled_at=$2 WHERE id=$1 RETURNING id',[id,at])).rows.length)
    throw new LedgerPreconditionError('Movement no longer exists');
};

export interface ManualPlanBankTermsExpected {
  readonly principalMinor:number;readonly cuotaMinor:number;readonly months:number;
  readonly startMonth:string;readonly occurredAt:string;readonly accountLastFour:string|null;
}
export interface ManualPlanBankTermsNext {
  readonly principalMinor:number;readonly account:Readonly<Record<string,unknown>>;
  readonly bankTransactionId?:string;readonly reconciledAt:string;
}

/** The caller appends bank evidence/history and replaces the plan in this same transaction. */
export const confirmManualPlanBankTerms=async(client:SqlClient,id:string,expected:ManualPlanBankTermsExpected,
  next:ManualPlanBankTermsNext):Promise<void>=>{
  assertMoney(expected.principalMinor);assertMoney(expected.cuotaMinor);assertMoney(next.principalMinor);
  if(expected.principalMinor<=0 || expected.cuotaMinor<=0 || next.principalMinor<=0
    || !Number.isInteger(expected.months) || expected.months<1 || expected.months>48
    || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(expected.startMonth)
    || !Number.isFinite(millis(expected.occurredAt)) || !Number.isFinite(millis(next.reconciledAt))
    || (expected.accountLastFour!==null && !/^\d{4}$/.test(expected.accountLastFour))
    || typeof next.account.accountId!=='string' || !next.account.accountId.trim()
    || typeof next.account.displayName!=='string' || !next.account.displayName.trim()
    || typeof next.account.institution!=='string' || !next.account.institution.trim()
    || typeof next.account.lastFour!=='string' || !/^\d{4}$/.test(next.account.lastFour)
    || (next.bankTransactionId!==undefined && (typeof next.bankTransactionId!=='string' || !next.bankTransactionId.trim())))invalid();
  if(expected.accountLastFour!==null && expected.accountLastFour!==next.account.lastFour)
    throw new LedgerPreconditionError('Bank evidence contradicts the observed card');
  const account=accountValues(next.account);
  reserveLedgerMutations(1);
  const updated=await client.query(`UPDATE olbia.ledger_movements AS m SET
    amount_minor=$2,account_present=$3,account_id=$4,account_name=$5,account_institution=$6,account_last_four=$7,
    bank_transaction_id=COALESCE($8,m.bank_transaction_id),reconciled_at=$9
    WHERE m.id=$1 AND m.status IN ('accepted','needs_review') AND m.currency='MXN'
      AND m.personal_amount_minor IS NULL AND m.institution=$6 AND m.amount_minor=$10
      AND m.occurred_at IS NOT DISTINCT FROM $14::timestamptz
      AND m.account_last_four IS NOT DISTINCT FROM $15::text
      AND EXISTS (SELECT 1 FROM olbia.ledger_observations o
        WHERE o.id=m.primary_observation_id AND o.movement_id=m.id AND o.capture_source='manual')
      AND EXISTS (SELECT 1 FROM olbia.installment_plans p WHERE p.movement_id=m.id
        AND p.principal_minor=$10 AND p.cuota_minor=$11 AND p.months=$12
        AND p.status IN ('active','completed') AND p.needs_schedule_completion IS DISTINCT FROM true
        AND (SELECT count(*) FROM olbia.installment_entries e WHERE e.movement_id=m.id)=p.months
        AND EXISTS (SELECT 1 FROM olbia.installment_entries first
          WHERE first.movement_id=m.id AND first.installment_index=1 AND first.month=$13)
        AND NOT EXISTS (SELECT 1 FROM olbia.installment_entries e WHERE e.movement_id=m.id
          AND (e.installment_index>p.months OR e.status='cancelled' OR e.evidence_import_kind IS NOT NULL
            OR e.evidence_content_sha256 IS NOT NULL OR e.evidence_row_position IS NOT NULL
            OR (substring(e.month,1,4)::integer-substring($13::text,1,4)::integer)*12
              +substring(e.month,6,2)::integer-substring($13::text,6,2)::integer<>e.installment_index-1)))
      AND NOT EXISTS (SELECT 1 FROM olbia.installment_evidence_candidates candidate WHERE candidate.movement_id=m.id)
    RETURNING m.id`,[id,next.principalMinor,...account,optional(next.bankTransactionId),next.reconciledAt,
      expected.principalMinor,expected.cuotaMinor,expected.months,expected.startMonth,expected.occurredAt,expected.accountLastFour]);
  if(!updated.rows.length)throw new LedgerPreconditionError('Manual MSI plan changed or already has bank evidence');
};

export const promoteForeignAuthorization=async(client:SqlClient,id:string,event:ObservedEventInput,reconciliationAt:string):Promise<void>=>{
  assertMoney(event.amount.amountMinor);
  if(event.amount.currency!=='MXN')invalid();
  reserveLedgerMutations(1);
  const updated=await client.query(`UPDATE olbia.ledger_movements SET amount_minor=$2,currency='MXN',status=$3,
    merchant_raw=$4,occurred_at=COALESCE($5,occurred_at),reconciliation_at=$6,reconciled_at=$7,
    account_present=CASE WHEN $8 THEN $8 ELSE account_present END,
    account_id=CASE WHEN $8 THEN $9 ELSE account_id END,account_name=CASE WHEN $8 THEN $10 ELSE account_name END,
    account_institution=CASE WHEN $8 THEN $11 ELSE account_institution END,account_last_four=CASE WHEN $8 THEN $12 ELSE account_last_four END
    WHERE id=$1 AND status='pending_foreign' RETURNING id`,[id,event.amount.amountMinor,event.status,event.merchantRaw,
    optional(event.occurredAt),reconciliationAt,event.ingestedAt,...accountValues(event.account)]);
  if(!updated.rows.length)throw new LedgerPreconditionError('Foreign authorization is no longer pending');
};

export interface NativeRevisionInput {
  readonly id:string;readonly movementId:string;readonly createdAt:string;readonly changedBy:string;
  readonly reason?:string;readonly operationId?:string;readonly source?:string;
  readonly changes:Readonly<Record<string,{readonly previous?:unknown;readonly next?:unknown}>>;
}
export const insertLedgerRevision=async(client:SqlClient,input:NativeRevisionInput):Promise<void>=>{
  reserveLedgerMutations(1);
  await client.query(`INSERT INTO olbia.ledger_revisions
    (id,movement_id,created_at,changed_by,reason,operation_id,source,changes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [input.id,input.movementId,input.createdAt,input.changedBy,optional(input.reason),optional(input.operationId),optional(input.source),JSON.stringify(input.changes)]);
};

export const replaceInstallmentPlan=async(client:SqlClient,id:string,plan:MsiPlan|undefined,evidence:readonly BankRowEvidence[]=[]):Promise<void>=>{
  const parent=(await client.query(`SELECT personal_amount_minor,status,
    EXISTS(SELECT 1 FROM olbia.installment_plans WHERE movement_id=$1) AS has_plan
    FROM olbia.ledger_movements WHERE id=$1`,[id])).rows[0];
  if(!parent)throw new LedgerPreconditionError('Movement no longer exists');
  if(plan && (parent.personal_amount_minor!==null || parent.status==='pending_foreign'))throw new LedgerPreconditionError('Movement is not available for MSI');
  const previous=(await client.query('SELECT * FROM olbia.installment_entries WHERE movement_id=$1',[id])).rows;
  const candidates=(await client.query('SELECT * FROM olbia.installment_evidence_candidates WHERE movement_id=$1',[id])).rows;
  const confirmations=new Map<number,BankRowEvidence>();
  for(const reference of evidence){if(confirmations.has(reference.installmentIndex))invalid();confirmations.set(reference.installmentIndex,reference);}
  if(plan){
    known(plan,['months','principalMinor','cuotaMinor','origin','status','needsScheduleCompletion','installments']);
    assertMoney(plan.principalMinor);assertMoney(plan.cuotaMinor);
    if(plan.installments.length!==plan.months || plan.installments.some((item,n)=>item.index!==n+1))invalid();
    for(const item of plan.installments)known(item,['index','month','amountMinor','status','occurredOn','confirmedAt','evidenceObservationId']);
  }
  const entries:Row[]=[];const retainedCandidates:Row[]=[];
  for(const item of plan?.installments??[]){
    const reference=confirmations.get(item.index);let provenance:Row={evidence_origin:null,evidence_import_kind:null,
      evidence_content_sha256:null,evidence_row_position:null};
    if(reference){
      const row=(await client.query('SELECT identity FROM olbia.bank_import_rows WHERE kind=$1 AND content_sha256=$2 AND position=$3',
        [reference.kind,reference.contentSha256,reference.rowPosition])).rows[0];
      if(!row || row.identity!==item.evidenceObservationId)invalid();
      provenance={evidence_origin:'bank_row',evidence_import_kind:reference.kind,evidence_content_sha256:reference.contentSha256,evidence_row_position:reference.rowPosition};
    }else if(item.evidenceObservationId!==undefined){
      const matches=previous.filter(row=>row.evidence_identity===item.evidenceObservationId &&
        millis(row.confirmed_at)===millis(item.confirmedAt));
      if(matches.length!==1)invalid();const old=matches[0];
      provenance={evidence_origin:old.evidence_origin,evidence_import_kind:old.evidence_import_kind,
        evidence_content_sha256:old.evidence_content_sha256,evidence_row_position:old.evidence_row_position};
      for(const candidate of candidates.filter(row=>row.installment_index===old.installment_index))
        retainedCandidates.push({...candidate,installment_index:item.index});
    }
    entries.push({item,provenance});
  }
  if([...confirmations.keys()].some(index=>!plan?.installments.some(item=>item.index===index)))invalid();
  reserveLedgerMutations(previous.length+candidates.length+Number(parent.has_plan)+
    (plan?1+entries.length+retainedCandidates.length:0));
  await client.query('DELETE FROM olbia.installment_evidence_candidates WHERE movement_id=$1',[id]);
  await client.query('DELETE FROM olbia.installment_entries WHERE movement_id=$1',[id]);
  await client.query('DELETE FROM olbia.installment_plans WHERE movement_id=$1',[id]);
  if(!plan)return;
  await client.query('INSERT INTO olbia.installment_plans VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id,plan.months,plan.principalMinor,plan.cuotaMinor,plan.origin,plan.status,optional(plan.needsScheduleCompletion)]);
  for(const entry of entries){
    const item=entry.item as MsiPlan['installments'][number],p=entry.provenance as Row;assertMoney(item.amountMinor);
    await client.query(`INSERT INTO olbia.installment_entries
      (movement_id,installment_index,month,amount_minor,status,occurred_on,confirmed_at,evidence_identity,evidence_origin,
        evidence_import_kind,evidence_content_sha256,evidence_row_position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id,item.index,item.month,item.amountMinor,item.status,optional(item.occurredOn),optional(item.confirmedAt),optional(item.evidenceObservationId),
      p.evidence_origin,p.evidence_import_kind,p.evidence_content_sha256,p.evidence_row_position]);
  }
  for(const row of retainedCandidates)await client.query('INSERT INTO olbia.installment_evidence_candidates VALUES ($1,$2,$3,$4,$5)',
    [id,row.installment_index,row.import_kind,row.content_sha256,row.row_position]);
};
