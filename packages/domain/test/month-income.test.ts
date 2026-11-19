import { describe, expect, it } from 'vitest';
import { summarizeFutureIncome, type IncomeOccurrence } from '../src/index.js';
const now = new Date('2026-11-18T18:00:00Z');
const occurrence: IncomeOccurrence = { incomeId:'income',occurrenceId:'income:2026-11:0',name:'Expected payment',employer:null,
  paymentDate:'2026-11-30',periodMonth:'2026-11',amountMxnMinor:123_45,scheduleBasis:'regular',confidence:'estimated',
  basis:'configured_expectation_not_received_income',reconciliationStatus:'unreconciled' };
describe('expected bank-entry read facts',()=>{
  it('keeps exact amounts and detail, excludes payments whose banking day moved out of this month',()=>{
    const result=summarizeFutureIncome('2026-11',now,[occurrence,{...occurrence,occurrenceId:'moved',paymentDate:'2026-10-30'}],false);
    expect(result).toMatchObject({status:'scheduled',scheduledMinor:123_45,unknownOccurrences:0,hasMore:false,occurrences:[occurrence]});
  });
  it('does not treat unknown dates, amounts, coverage, overlapping payroll or elapsed dates as certain remaining income',()=>{
    for(const schedule of [[{...occurrence,paymentDate:null}],[{...occurrence,amountMxnMinor:null}],
      [{...occurrence,paymentDate:'2026-11-17'}],[{...occurrence,reconciliationStatus:'possible_payroll_overlap' as const}],
      [{...occurrence,calendarStatus:'cnbv_calendar_provisional' as const}]]) {
      expect(summarizeFutureIncome('2026-11',now,schedule,false).scheduledMinor).toBeNull();
    }
    expect(summarizeFutureIncome('2026-11',now,[occurrence],true).status).toBe('reconciliation_needed');
    expect(summarizeFutureIncome('2026-11',now,[occurrence],false,true)).toMatchObject({status:'unknown_amount_or_date',scheduledMinor:null,hasMore:true});
  });
  it('closes historical expectations, preserves unconfigured state and future monthly scope',()=>{
    expect(summarizeFutureIncome('2026-10',now,[occurrence],false)).toMatchObject({status:'closed',occurrences:[],scheduledMinor:null});
    expect(summarizeFutureIncome('2026-12',now,[],false).status).toBe('unconfigured');
    expect(summarizeFutureIncome('2026-12',now,[{...occurrence,paymentDate:'2026-12-15',periodMonth:'2026-12'}],false).scheduledMinor).toBe(123_45);
  });
});
