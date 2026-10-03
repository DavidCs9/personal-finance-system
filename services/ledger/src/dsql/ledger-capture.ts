import { randomUUID } from 'node:crypto';
import type { CaptureSource,ObservedEventInput,SaveObservedEventResult } from '../observed-events.js';
import { financialCalendarDay,foreignMerchantsMatch,merchantsMatch } from '../reconciliation-matching.js';
import type { SqlClient } from './projection.js';
import { withSqlTransaction } from './sql-runtime.js';
import { appendLedgerObservation,insertLedgerMovement,insertSourceClaim,markMovementReconciled,
  promoteForeignAuthorization,readSourceClaim } from './ledger-writes.js';

type Row=Record<string,unknown>;
export class SourceClaimUnavailableError extends Error {
  constructor(readonly outcome:string){super('The source has an existing suppression or unresolved historical claim');}
}
export interface NativeCaptureInput {
  readonly token:string;readonly captureSource:CaptureSource;readonly event:ObservedEventInput;
  readonly reconciliationAt:string;
}
const asTimestamp=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const millis=(value:unknown)=>value instanceof Date?value.getTime():Date.parse(String(value));
const boundary=(center:number,hours:number)=>[new Date(center-hours*60*60*1000).toISOString(),new Date(center+hours*60*60*1000).toISOString()];
const captures=(row:Row)=>row.capture_sources as CaptureSource[];
const candidateSelection=`SELECT m.*,(SELECT jsonb_agg(o.capture_source ORDER BY o.position)
  FROM olbia.ledger_observations o WHERE o.movement_id=m.id) AS capture_sources FROM olbia.ledger_movements m`;
interface Candidate {readonly movement:Row;readonly matchKind:'exact'|'foreign'}

const exactCandidates=async(client:SqlClient,input:NativeCaptureInput):Promise<Candidate[]>=>{
  const center=Date.parse(input.reconciliationAt);
  if(!Number.isFinite(center))throw new Error('Invalid reconciliation timestamp');
  const dayLevelInput=['santander_csv','santander_statement','manual','email','apple_pay_shortcut'].includes(input.captureSource);
  const [from,to]=boundary(center,dayLevelInput?18:0.5);
  const rows=(await client.query(`${candidateSelection} WHERE institution=$1 AND event_type=$2 AND currency=$3
    AND amount_minor=$4 AND reconciliation_at BETWEEN $5 AND $6 ORDER BY reconciliation_at,id`,[
    input.event.institution,input.event.eventType,input.event.amount.currency,input.event.amount.amountMinor,from,to])).rows;
  return rows.flatMap(row=>{
    const sources=captures(row),dayLevel=['santander_csv','santander_statement','manual'].some(source=>
      input.captureSource===source||sources.includes(source as CaptureSource));
    if(!merchantsMatch(input.event.merchantRaw,String(row.merchant_raw),dayLevel))return [];
    if(!dayLevel && Math.abs(millis(row.reconciliation_at)-center)>30*60*1000)return [];
    if(dayLevel){
      const inputDay=financialCalendarDay(input.event.occurredAt??input.reconciliationAt);
      const existingDay=financialCalendarDay(asTimestamp(row.occurred_at??row.reconciliation_at));
      if(inputDay!==existingDay)return [];
      const incomingLastFour=input.event.account?.lastFour,existingLastFour=row.account_last_four;
      if(incomingLastFour && existingLastFour && incomingLastFour!==existingLastFour)return [];
    }
    return [{movement:row,matchKind:'exact' as const}];
  });
};
const foreignCandidates=async(client:SqlClient,input:NativeCaptureInput):Promise<Candidate[]>=>{
  const incomingEmail=input.captureSource==='email'&&input.event.institution==='santander_mx'&&
    input.event.eventType==='card_purchase'&&input.event.amount.currency==='MXN';
  const incomingApple=input.captureSource==='apple_pay_shortcut'&&input.event.institution==='santander_mx'&&
    input.event.eventType==='card_purchase'&&input.event.amount.currency==='USD';
  if(!incomingEmail&&!incomingApple || !input.event.occurredAt)return [];
  const center=Date.parse(input.event.occurredAt);if(!Number.isFinite(center))return [];
  const [from,to]=boundary(center,30);
  const rows=(await client.query(`${candidateSelection} WHERE institution=$1 AND event_type='card_purchase'
    AND received_at BETWEEN $2 AND $3 ORDER BY received_at,id`,[input.event.institution,from,to])).rows;
  const inputDay=Date.parse(`${financialCalendarDay(input.event.occurredAt)}T12:00:00Z`);
  return rows.flatMap(row=>{
    const sources=captures(row);
    const pendingApple=sources.includes('apple_pay_shortcut')&&row.currency==='USD'&&row.status==='pending_foreign';
    const postedEmail=sources.includes('email')&&row.currency==='MXN'&&row.status!=='rejected'&&row.status!=='pending_foreign';
    if(incomingEmail&&!pendingApple || incomingApple&&!postedEmail)return [];
    const existingDay=Date.parse(`${financialCalendarDay(asTimestamp(row.occurred_at??row.reconciliation_at))}T12:00:00Z`);
    if(Math.abs(existingDay-inputDay)>24*60*60*1000 || !foreignMerchantsMatch(input.event.merchantRaw,String(row.merchant_raw)))return [];
    const usd=incomingApple?input.event.amount.amountMinor:Number(row.amount_minor);
    const mxn=incomingEmail?input.event.amount.amountMinor:Number(row.amount_minor);
    const ratio=mxn/usd;if(usd<=0||ratio<10||ratio>30)return [];
    return [{movement:row,matchKind:'foreign' as const}];
  });
};

/** Complete financial capture/reconciliation; caller supplies the current native transaction. */
export const saveNativeCapture=async(client:SqlClient,input:NativeCaptureInput):Promise<SaveObservedEventResult>=>{
  const center=Date.parse(input.reconciliationAt);if(!Number.isFinite(center))throw new Error('Invalid reconciliation timestamp');
  const existing=await readSourceClaim(client,input.captureSource,input.token);
  if(existing){
    if(existing.outcome!=='linked' || !existing.movement_id || !existing.observation_id)
      throw new SourceClaimUnavailableError(String(existing.outcome));
    return {eventId:String(existing.movement_id),observationId:String(existing.observation_id),
      duplicate:true,reconciled:Boolean(existing.reconciled),created:false};
  }
  const exact=await exactCandidates(client,input),candidates=exact.length?exact:await foreignCandidates(client,input);
  const retry=candidates.find(candidate=>captures(candidate.movement).includes(input.captureSource) &&
    Math.abs(millis(candidate.movement.reconciliation_at)-center)<=2*60*1000);
  if(retry){
    const eventId=String(retry.movement.id),observationId=String(retry.movement.primary_observation_id);
    const reconciled=captures(retry.movement).length>1;
    await insertSourceClaim(client,{captureSource:input.captureSource,token:input.token,createdAt:input.event.ingestedAt,
      movementId:eventId,observationId,reconciled});
    return {eventId,observationId,duplicate:true,reconciled,created:false};
  }
  const crossSource=candidates.filter(candidate=>!captures(candidate.movement).includes(input.captureSource));
  const candidate=crossSource.length===1?crossSource[0]:undefined;
  const eventId=candidate?String(candidate.movement.id):input.event.id,observationId=randomUUID();
  if(!candidate)await insertLedgerMovement(client,input.event,observationId,input.reconciliationAt);
  await appendLedgerObservation(client,{id:observationId,movementId:eventId,captureSource:input.captureSource,
    observedAt:input.event.receivedAt,reconciliationAt:input.reconciliationAt,institution:input.event.institution,
    eventType:input.event.eventType,amount:input.event.amount,merchantRaw:input.event.merchantRaw,occurredAt:input.event.occurredAt,
    account:input.event.account,source:input.event.source,parserVersion:input.event.parserVersion,parseWarnings:input.event.parseWarnings});
  if(candidate){
    if(candidate.matchKind==='foreign' && input.captureSource==='email' && input.event.amount.currency==='MXN')
      await promoteForeignAuthorization(client,eventId,input.event,input.reconciliationAt);
    else await markMovementReconciled(client,eventId,input.event.ingestedAt);
  }
  await insertSourceClaim(client,{captureSource:input.captureSource,token:input.token,createdAt:input.event.ingestedAt,
    movementId:eventId,observationId,reconciled:Boolean(candidate)});
  return {eventId,observationId,duplicate:false,reconciled:Boolean(candidate),created:!candidate};
};
export const captureObservedEvent=(input:NativeCaptureInput):Promise<SaveObservedEventResult>=>
  withSqlTransaction(client=>saveNativeCapture(client,input));
