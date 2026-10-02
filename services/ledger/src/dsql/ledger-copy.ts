import { NATIVE_LEDGER_TABLES } from './ledger-schema.js';
import type { SqlClient, TransactionPool } from './projection.js';

type Row=Record<string,unknown>;
type NativeTable=typeof NATIVE_LEDGER_TABLES[number];
export interface RetainedLedger {
  readonly movements: readonly Row[];
  readonly observations: readonly Row[];
  readonly revisions: readonly Row[];
  readonly claims: readonly Row[];
  readonly operations: readonly Row[];
  /** Native rows joined to their import's original evidence bucket/key. */
  readonly bankRows: readonly Row[];
}
export interface LedgerCopy {
  readonly rows: Record<NativeTable,Row[]>;
  readonly backfilledCsvClaims: number;
  readonly mutationCount: number;
}
const invalid=():never=>{throw new Error('Retained ledger mapping is inconsistent');};
const object=(value:unknown):Row=>value && typeof value==='object' && !Array.isArray(value)?value as Row:invalid();
const list=(value:unknown):unknown[]=>Array.isArray(value)?value:invalid();
const text=(value:unknown):string=>typeof value==='string'?value:invalid();
const nullable=(value:unknown)=>value===undefined?null:value;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const known=(row:Row,fields:readonly string[])=>{if(Object.keys(row).some(k=>!fields.includes(k)))invalid();};
const date=(value:unknown):number=>{const result=Date.parse(text(value));return Number.isFinite(result)?result:invalid();};
const day=(value:unknown):string=>value instanceof Date?value.toISOString().slice(0,10):text(value).slice(0,10);
const account=(value:unknown):Row=>{
  if(value===undefined)return {account_present:false,account_id:null,account_name:null,account_institution:null,account_last_four:null};
  const a=object(value);known(a,['accountId','displayName','institution','lastFour']);
  return {account_present:true,account_id:nullable(a.accountId),account_name:nullable(a.displayName),
    account_institution:nullable(a.institution),account_last_four:nullable(a.lastFour)};
};
const money=(value:unknown):Row=>{
  const amount=object(value);known(amount,['amountMinor','currency']);
  if(!Number.isSafeInteger(amount.amountMinor))invalid();
  return {amount_minor:amount.amountMinor,currency:amount.currency};
};
const file=(value:unknown):Row=>{
  const original=object(value),metadata={...original};
  for(const key of ['bucket','key','sha256','contentType','kind'])delete metadata[key];
  return {evidence_bucket:nullable(original.bucket),evidence_key:nullable(original.key),
    evidence_sha256:nullable(original.sha256),evidence_content_type:nullable(original.contentType),
    source_kind:nullable(original.kind),source_metadata:metadata};
};

/** One-time, fail-closed decoding of frozen recovery data. Runtime operations never use this shape. */
export const prepareLedgerCopy=(input:RetainedLedger):LedgerCopy=>{
  const rows=Object.fromEntries(NATIVE_LEDGER_TABLES.map(table=>[table,[]])) as unknown as Record<NativeTable,Row[]>;
  const captures=new Map<string,Row>();const captureGroups=new Map<string,Row[]>();
  for(const retained of input.observations){
    const p=object(retained.payload);known(p,['id','eventId','captureSource','observedAt','reconciliationAt','institution',
      'eventType','account','amount','merchantRaw','occurredAt','source','parserVersion','parseWarnings','bankTransactionId','rowNumber','note']);
    const id=text(p.id),parent=text(p.eventId);if(captures.has(id))invalid();
    captures.set(id,p);const group=captureGroups.get(parent)??[];group.push(p);captureGroups.set(parent,group);
  }
  for(const group of captureGroups.values())group.sort((a,b)=>date(a.observedAt)-date(b.observedAt)||Buffer.compare(Buffer.from(text(a.id)),Buffer.from(text(b.id))));
  const movementIds=new Set<string>();
  for(const retained of input.movements){
    const p=object(retained.payload);known(p,['id','institution','eventType','status','account','amount','merchantRaw',
      'occurredAt','receivedAt','ingestedAt','source','parserVersion','parseWarnings','captureSource','captureSources',
      'observationCount','primaryObservationId','hasRawEmail','reconciledAt','categoryId','personalAmountMinor','tags','msi',
      'bankTransactionId','sourceMessageId','counterparty','trackingKey','folio','reference','transferType',
      'counterpartyInstitution','counterpartyAccountLastFour','billingPeriod','paymentMethodLastFour']);
    const id=text(p.id);if(movementIds.has(id))invalid();movementIds.add(id);
    const primary=captures.get(text(p.primaryObservationId)),group=captureGroups.get(id);
    if(!primary || !group || primary.eventId!==id || p.captureSource!==primary.captureSource ||
      p.parserVersion!==primary.parserVersion || !same(p.source,primary.source) || date(p.receivedAt)!==date(primary.observedAt) ||
      !same(p.captureSources,group.map(c=>c.captureSource)) || p.observationCount!==group.length ||
      p.hasRawEmail!==group.some(c=>c.captureSource==='email'))invalid();
    const financial:Row={id,primary_observation_id:p.primaryObservationId,institution:p.institution,event_type:p.eventType,
      status:p.status,...money(p.amount),merchant_raw:p.merchantRaw,occurred_at:nullable(p.occurredAt),
      received_at:p.receivedAt,ingested_at:p.ingestedAt,reconciliation_at:retained.reconciliation_at,
      reconciled_at:nullable(p.reconciledAt),...account(p.account),category_id:nullable(p.categoryId),
      personal_amount_minor:nullable(p.personalAmountMinor)};
    for(const [field,column] of Object.entries({bankTransactionId:'bank_transaction_id',sourceMessageId:'source_message_id',
      counterparty:'counterparty',trackingKey:'tracking_key',folio:'folio',reference:'reference',transferType:'transfer_type',
      counterpartyInstitution:'counterparty_institution',counterpartyAccountLastFour:'counterparty_account_last_four',
      billingPeriod:'billing_period',paymentMethodLastFour:'payment_method_last_four'}))financial[column]=nullable(p[field]);
    if(typeof financial.reconciliation_at!=='string')invalid();
    rows.ledger_movements.push(financial);
    list(p.parseWarnings).forEach((warning,position)=>rows.ledger_movement_warnings.push({movement_id:id,position,message:text(warning)}));
    list(p.tags??[]).forEach((tag,position)=>rows.ledger_tags.push({movement_id:id,position,tag:text(tag)}));
    if(p.msi!==undefined){
      const plan=object(p.msi);known(plan,['months','principalMinor','cuotaMinor','origin','status','needsScheduleCompletion','installments']);
      rows.installment_plans.push({movement_id:id,months:plan.months,principal_minor:plan.principalMinor,
        cuota_minor:plan.cuotaMinor,origin:plan.origin,status:plan.status,needs_schedule_completion:nullable(plan.needsScheduleCompletion)});
      const installments=list(plan.installments);if(installments.length!==plan.months)invalid();
      for(const item of installments){
        const installment=object(item);known(installment,['index','month','amountMinor','status','occurredOn','confirmedAt','evidenceObservationId']);
        const identity=installment.evidenceObservationId;
        const matches=identity===undefined?[]:input.bankRows.filter(r=>r.identity===identity);
        let origin:string|null=null;
        if(identity!==undefined){
          if(matches.length===1)origin='bank_row';
          else if(matches.length>1)origin='ambiguous_bank_row';
          else if(/^backfill[:#_-]/i.test(text(identity)))origin='legacy_backfill';
          else invalid();
        }
        const exact=origin==='bank_row'?matches[0]:undefined;
        rows.installment_entries.push({movement_id:id,installment_index:installment.index,month:installment.month,
          amount_minor:installment.amountMinor,status:installment.status,occurred_on:nullable(installment.occurredOn),
          confirmed_at:nullable(installment.confirmedAt),evidence_identity:nullable(identity),evidence_origin:origin,
          evidence_import_kind:exact?.kind??null,evidence_content_sha256:exact?.content_sha256??null,
          evidence_row_position:exact?.position??null});
        if(origin==='ambiguous_bank_row')for(const candidate of matches)rows.installment_evidence_candidates.push({
          movement_id:id,installment_index:installment.index,import_kind:candidate.kind,
          content_sha256:candidate.content_sha256,row_position:candidate.position});
      }
    }
  }
  for(const [parent,group] of captureGroups){
    if(!movementIds.has(parent))invalid();
    group.forEach((p,position)=>{
      rows.ledger_observations.push({id:p.id,movement_id:parent,position,capture_source:p.captureSource,
        observed_at:p.observedAt,reconciliation_at:p.reconciliationAt,institution:p.institution,event_type:p.eventType,
        ...money(p.amount),merchant_raw:p.merchantRaw,occurred_at:nullable(p.occurredAt),...account(p.account),
        parser_version:p.parserVersion,bank_transaction_id:nullable(p.bankTransactionId),csv_row_number:nullable(p.rowNumber),
        note:nullable(p.note),...file(p.source)});
      list(p.parseWarnings).forEach((warning,position)=>rows.ledger_observation_warnings.push({observation_id:p.id,position,message:text(warning)}));
    });
  }
  for(const retained of input.operations){
    const p=object(retained.payload);known(p,['operationId','owner','status','createdAt','expiresAt','selection','change','events','amountMinor','appliedAt','undoneAt']);
    rows.ledger_bulk_operations.push({id:p.operationId,owner:p.owner,status:p.status,created_at:p.createdAt,
      expires_at:p.expiresAt,applied_at:nullable(p.appliedAt),undone_at:nullable(p.undoneAt),
      selection_assertion:object(p.selection),change_assertion:object(p.change)});
    let total=0;
    list(p.events).forEach((item,position)=>{
      const member=object(item);known(member,['id','merchantRaw','occurredAt','status','amountMinor','previousTags','nextTags','previousCategoryId','nextCategoryId']);
      if(!Number.isSafeInteger(member.amountMinor))invalid();total+=Number(member.amountMinor);
      rows.ledger_bulk_members.push({operation_id:p.operationId,position,movement_id:member.id,
        merchant_assertion:member.merchantRaw,occurred_at_assertion:nullable(member.occurredAt),status_assertion:member.status,
        amount_minor_assertion:member.amountMinor,previous_tags:list(member.previousTags),next_tags:list(member.nextTags),
        previous_category_id:nullable(member.previousCategoryId),next_category_id:nullable(member.nextCategoryId)});
    });
    if(!Number.isSafeInteger(total) || total!==p.amountMinor)invalid();
  }
  for(const retained of input.revisions){
    const p=object(retained.payload);known(p,['id','observedPurchaseId','createdAt','changedBy','reason','operationId','source','changes']);
    rows.ledger_revisions.push({id:p.id,movement_id:p.observedPurchaseId,created_at:p.createdAt,changed_by:p.changedBy,
      reason:nullable(p.reason),operation_id:nullable(p.operationId),source:nullable(p.source),changes:object(p.changes)});
  }
  let backfilledCsvClaims=0;
  for(const retained of input.claims){
    const p=object(retained.source_item);const key=text(p.PK);
    if(key.startsWith('DEDUPE#CFDI_NOMINA#'))continue;
    known(p,['PK','SK','entityType','createdAt','owner','identity','fingerprint','eventId','observationId','reconciled']);
    if(!key.startsWith('DEDUPE#') || p.SK!=='CLAIM')invalid();
    const token=key.slice('DEDUPE#'.length);
    const prefixes=[['apple_pay_shortcut:','apple_pay_shortcut'],['MANUAL#','manual'],
      ['SANTANDER_CSV#','santander_csv'],['AMEX_STATEMENT#','amex_statement'],['SANTANDER_STATEMENT#','santander_statement']] as const;
    const family=prefixes.find(([prefix])=>token.startsWith(prefix));const kind=family?.[1]??'email';
    let target=p.eventId,observationId=p.observationId;
    if(kind==='santander_csv' && target===undefined){
      const bankRows=input.bankRows.filter(r=>r.kind==='santander_csv' && r.identity===p.identity);
      const matchingCaptures=[...captures.values()].filter(c=>c.captureSource==='santander_csv' && bankRows.some(r=>{
        const source=object(c.source);
        return source.bucket===r.evidence_bucket && source.key===r.evidence_key && c.rowNumber===r.row_number &&
          nullable(c.bankTransactionId)===r.bank_transaction_id && c.merchantRaw===r.merchant_raw &&
          day(c.occurredAt)===day(r.occurred_on);
      }));
      if(matchingCaptures.length!==1)invalid();
      target=matchingCaptures[0].eventId;observationId=matchingCaptures[0].id;backfilledCsvClaims++;
    }
    const missing=target!==undefined && !movementIds.has(text(target));
    if(missing && (kind!=='amex_statement' || observationId!==undefined))invalid();
    if(target===undefined && kind!=='email')invalid();
    rows.source_claims.push({capture_source:kind,token:family?token.slice(family[0].length):token,created_at:p.createdAt,
      owner:nullable(p.owner),row_identity:nullable(p.identity),fingerprint:nullable(p.fingerprint),reconciled:nullable(p.reconciled),
      outcome:missing?'historical_missing':target===undefined?'unresolved_suppression':'linked',
      movement_id:missing?null:nullable(target),observation_id:nullable(observationId),historical_target_id:missing?target:null});
  }
  const mutationCount=Object.values(rows).reduce((sum,group)=>sum+group.length,2);
  if(mutationCount>3000 || Buffer.byteLength(JSON.stringify(rows),'utf8')>8*1024*1024)invalid();
  return {rows,backfilledCsvClaims,mutationCount};
};

export const readRetainedLedger=async(client:SqlClient):Promise<RetainedLedger>=>({
  movements:(await client.query(`SELECT m.payload,s.source_item->>'reconciliationAt' AS reconciliation_at
    FROM olbia.movements m LEFT JOIN olbia.projection_state s
    ON s.source_pk=m.source_pk AND s.source_sk=m.source_sk AND s.deleted=false`)).rows,
  observations:(await client.query('SELECT payload FROM olbia.movement_observations')).rows,
  revisions:(await client.query('SELECT payload FROM olbia.movement_revisions')).rows,
  claims:(await client.query("SELECT source_item FROM olbia.dedupe_claims WHERE source_pk NOT LIKE 'DEDUPE#CFDI_NOMINA#%'")).rows,
  operations:(await client.query('SELECT payload FROM olbia.bulk_edit_operations')).rows,
  bankRows:(await client.query(`SELECT r.*,h.evidence_bucket,h.evidence_key FROM olbia.bank_import_rows r
    JOIN olbia.bank_imports h ON h.kind=r.kind AND h.content_sha256=r.content_sha256`)).rows,
});

/** Caller prepares/validates DDL first. Copy and activation are one native OCC transaction. */
export const migrateLedger=async(pool:TransactionPool):Promise<void>=>{
  await pool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows.length)return;
    if((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode!=='sql' ||
      (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows.length!==1)invalid();
    const copy=prepareLedgerCopy(await readRetainedLedger(client));
    // Small statement batches reduce round trips; all batches share this transaction.
    for(const table of NATIVE_LEDGER_TABLES){
      const group=copy.rows[table];
      for(let offset=0;offset<group.length;offset+=50){
        const batch=group.slice(offset,offset+50),columns=Object.keys(batch[0]),values:unknown[]=[];
        const tuples=batch.map(row=>{
          if(!same(columns,Object.keys(row)))invalid();
          const parameters=columns.map(column=>{
            const value=row[column];values.push(value && typeof value==='object'?JSON.stringify(value):value);
            return `$${values.length}`;
          });
          return `(${parameters.join(',')})`;
        });
        await client.query(`INSERT INTO olbia.${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,values);
      }
    }
    await client.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  });
};
