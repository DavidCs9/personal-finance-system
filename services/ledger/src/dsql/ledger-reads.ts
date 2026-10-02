import type { SqlClient } from './projection.js';

type Row=Record<string,unknown>;
const timestamp=(value:unknown):string=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();
const amount=(value:unknown):number=>{
  const result=Number(value);if(!Number.isSafeInteger(result))throw new Error('Invalid native financial amount');return result;
};
const object=(value:unknown):Row=>value as Row;
const records=(value:unknown):Row[]=>value as Row[];
const optional=(record:Row,field:string,value:unknown)=>{if(value!==null && value!==undefined)record[field]=value;};
const accountFrom=(row:Row):Row|undefined=>{
  if(!row.account_present)return undefined;
  const account:Row={};for(const [field,column] of Object.entries({accountId:'account_id',displayName:'account_name',
    institution:'account_institution',lastFour:'account_last_four'}))optional(account,field,row[column]);
  return account;
};
const sourceFrom=(row:Row,prefix=''):Row=>{
  const source={...object(row[`${prefix}source_metadata`])};
  for(const [field,column] of Object.entries({kind:'source_kind',bucket:'evidence_bucket',key:'evidence_key',
    sha256:'evidence_sha256',contentType:'evidence_content_type'}))optional(source,field,row[`${prefix}${column}`]);
  return source;
};
const observationFrom=(row:Row):Row=>{
  const result:Row={id:row.id,eventId:row.movement_id,captureSource:row.capture_source,observedAt:timestamp(row.observed_at),
    reconciliationAt:timestamp(row.reconciliation_at),institution:row.institution,eventType:row.event_type,
    amount:{amountMinor:amount(row.amount_minor),currency:row.currency},merchantRaw:row.merchant_raw,
    source:sourceFrom(row),parserVersion:row.parser_version,parseWarnings:row.warnings};
  optional(result,'account',accountFrom(row));
  if(row.occurred_at!==null)result.occurredAt=timestamp(row.occurred_at);
  optional(result,'bankTransactionId',row.bank_transaction_id);optional(result,'rowNumber',row.csv_row_number);optional(result,'note',row.note);
  return result;
};
const revisionFrom=(row:Row):Row=>{
  const result:Row={id:row.id,observedPurchaseId:row.movement_id,createdAt:timestamp(row.created_at),changedBy:row.changed_by,changes:row.changes};
  optional(result,'reason',row.reason);optional(result,'source',row.source);optional(result,'operationId',row.operation_id);return result;
};
const planFrom=(row:Row):Row=>{
  const result:Row={months:row.months,principalMinor:amount(row.principal_minor),cuotaMinor:amount(row.cuota_minor),
    origin:row.origin,status:row.status,installments:records(row.installments).map(installment=>{
      const entry:Row={index:installment.installment_index,month:installment.month,amountMinor:amount(installment.amount_minor),status:installment.status};
      if(installment.occurred_on!==null)entry.occurredOn=String(installment.occurred_on).slice(0,10);
      if(installment.confirmed_at!==null)entry.confirmedAt=timestamp(installment.confirmed_at);
      // Retain the public legacy field at the API boundary; SQL stores typed provenance.
      optional(entry,'evidenceObservationId',installment.evidence_identity);
      return entry;
    })};
  optional(result,'needsScheduleCompletion',row.needs_schedule_completion);return result;
};

const nativeSelection=`SELECT m.*,
  p.capture_source AS primary_capture_source,p.parser_version AS primary_parser_version,
  p.source_kind AS primary_source_kind,p.source_metadata AS primary_source_metadata,
  p.evidence_bucket AS primary_evidence_bucket,p.evidence_key AS primary_evidence_key,
  p.evidence_sha256 AS primary_evidence_sha256,p.evidence_content_type AS primary_evidence_content_type,
  (SELECT COALESCE(jsonb_agg(o.capture_source ORDER BY o.position),'[]'::jsonb)
    FROM olbia.ledger_observations o WHERE o.movement_id=m.id) AS capture_sources,
  (SELECT count(*) FROM olbia.ledger_observations o WHERE o.movement_id=m.id) AS observation_count,
  EXISTS(SELECT 1 FROM olbia.ledger_observations o WHERE o.movement_id=m.id AND o.capture_source='email') AS has_raw_email,
  (SELECT COALESCE(jsonb_agg(t.tag ORDER BY t.position),'[]'::jsonb) FROM olbia.ledger_tags t WHERE t.movement_id=m.id) AS tags,
  (SELECT COALESCE(jsonb_agg(w.message ORDER BY w.position),'[]'::jsonb)
    FROM olbia.ledger_movement_warnings w WHERE w.movement_id=m.id) AS warnings,
  (SELECT to_jsonb(plan)||jsonb_build_object('installments',
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.installment_index),'[]'::jsonb)
      FROM olbia.installment_entries i WHERE i.movement_id=plan.movement_id))
    FROM olbia.installment_plans plan WHERE plan.movement_id=m.id) AS installment_plan
  FROM olbia.ledger_movements m JOIN olbia.ledger_observations p
    ON p.movement_id=m.id AND p.id=m.primary_observation_id`;

export const movementFromNative=(row:Row):Row=>{
  const result:Row={id:row.id,institution:row.institution,eventType:row.event_type,status:row.status,
    amount:{amountMinor:amount(row.amount_minor),currency:row.currency},merchantRaw:row.merchant_raw,
    receivedAt:timestamp(row.received_at),ingestedAt:timestamp(row.ingested_at),source:sourceFrom(row,'primary_'),
    parserVersion:row.primary_parser_version,parseWarnings:row.warnings,tags:row.tags,
    captureSource:row.primary_capture_source,captureSources:row.capture_sources,observationCount:amount(row.observation_count),
    primaryObservationId:row.primary_observation_id,hasRawEmail:row.has_raw_email};
  optional(result,'account',accountFrom(row));
  if(row.occurred_at!==null)result.occurredAt=timestamp(row.occurred_at);
  if(row.reconciled_at!==null)result.reconciledAt=timestamp(row.reconciled_at);
  if(row.personal_amount_minor!==null)result.personalAmountMinor=amount(row.personal_amount_minor);
  for(const [field,column] of Object.entries({categoryId:'category_id',bankTransactionId:'bank_transaction_id',sourceMessageId:'source_message_id',
    counterparty:'counterparty',trackingKey:'tracking_key',folio:'folio',reference:'reference',transferType:'transfer_type',
    counterpartyInstitution:'counterparty_institution',counterpartyAccountLastFour:'counterparty_account_last_four',
    billingPeriod:'billing_period',paymentMethodLastFour:'payment_method_last_four'}))optional(result,field,row[column]);
  if(row.installment_plan!==null)result.msi=planFrom(object(row.installment_plan));
  return result;
};

/** Months match actual financial relationships, without synthetic index keys or document pagination. */
export const readLedgerMovements=async(client:SqlClient,selection:{ids?:readonly string[];months?:readonly string[]}={}):Promise<Row[]>=>{
  const rows=(await client.query(`${nativeSelection}
    WHERE ($1::uuid[] IS NULL OR m.id=ANY($1::uuid[])) AND ($2::text[] IS NULL OR
      to_char(COALESCE(m.occurred_at,m.received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM')=ANY($2::text[]) OR
      EXISTS(SELECT 1 FROM olbia.installment_entries i WHERE i.movement_id=m.id AND i.month=ANY($2::text[])))
    ORDER BY m.received_at,m.id`,[selection.ids??null,selection.months??null])).rows;
  return rows.map(movementFromNative);
};

export const readLedgerDetail=async(client:SqlClient,id:string):Promise<Row|undefined>=>{
  const row=(await client.query(`SELECT financial.*,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC,r.id DESC),'[]'::jsonb)
      FROM olbia.ledger_revisions r WHERE r.movement_id=financial.id) AS revisions,
    (SELECT COALESCE(jsonb_agg(to_jsonb(o)||jsonb_build_object('warnings',
      (SELECT COALESCE(jsonb_agg(w.message ORDER BY w.position),'[]'::jsonb)
        FROM olbia.ledger_observation_warnings w WHERE w.observation_id=o.id))
      ORDER BY o.reconciliation_at DESC,o.id DESC),'[]'::jsonb)
      FROM olbia.ledger_observations o WHERE o.movement_id=financial.id) AS observations
    FROM (${nativeSelection} WHERE m.id=$1::uuid) financial`,[id])).rows[0];
  return row?{...movementFromNative(row),revisions:records(row.revisions).map(revisionFrom),
    observations:records(row.observations).map(observationFrom)}:undefined;
};
