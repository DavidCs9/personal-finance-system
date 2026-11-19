import type { BankCredit } from './bank-credit.js';
import type { PayrollClosure } from './payroll.js';
import type { IncomeOccurrence } from './financial-plans.js';
import { financialSum } from './financial-plans.js';
import { dayKeyInZone, daysInCalendarMonth } from './month-summary.js';
import { isManualCashAccountId, isWealthSnapshotStale, type ManualCashAccountId, type WealthSnapshotSource } from './wealth.js';

export interface BankCashBalance {
  readonly accountId: ManualCashAccountId;
  readonly name: string;
  readonly day: string;
  readonly capturedAt: string;
  readonly source: WealthSnapshotSource;
  readonly amountMinor: number;
}

export interface MonthFutureIncome {
  readonly status: 'closed' | 'unconfigured' | 'unknown_amount_or_date' | 'reconciliation_needed' | 'scheduled';
  readonly scheduledMinor: number | null;
  readonly knownUpcomingMinor: number;
  readonly unknownOccurrences: number;
  /** Additive read detail; optional while older clients/fixtures transition. */
  readonly occurrences?: readonly IncomeOccurrence[];
  readonly hasMore?: boolean;
}

/** Expected entries remain separate from bank receipts; uncertainty never becomes a zero total. */
export const summarizeFutureIncome = (month: string, now: Date, schedule: readonly IncomeOccurrence[], observedIncome: boolean, hasMore = false): MonthFutureIncome => {
  const today = dayKeyInZone(now);
  if (month < today.slice(0, 7)) return { status: 'closed', scheduledMinor: null, knownUpcomingMinor: 0,
    unknownOccurrences: 0, occurrences: [], hasMore: false };
  const occurrences = schedule.filter(item => (item.paymentDate?.slice(0, 7) ?? item.periodMonth) === month);
  const unknownOccurrences = occurrences.filter(item => item.amountMxnMinor === null
    || item.paymentDate === null && item.amountMxnMinor !== 0).length;
  const upcoming = occurrences.filter(item => item.paymentDate !== null && item.paymentDate > today);
  const knownUpcomingMinor = financialSum(upcoming.flatMap(item => item.amountMxnMinor === null ? [] : [item.amountMxnMinor]));
  const timingUnclear = occurrences.some(item => item.amountMxnMinor !== 0 && item.paymentDate !== null && item.paymentDate <= today
    || item.reconciliationStatus === 'possible_payroll_overlap' || item.calendarStatus === 'cnbv_calendar_provisional');
  const status = unknownOccurrences || hasMore ? 'unknown_amount_or_date'
    : timingUnclear || observedIncome && occurrences.length ? 'reconciliation_needed'
    : !occurrences.length ? 'unconfigured' : 'scheduled';
  return { status, scheduledMinor: status === 'scheduled' ? knownUpcomingMinor : null, knownUpcomingMinor,
    unknownOccurrences, occurrences, hasMore };
};

export const payrollFundReconciliation = (closure: PayrollClosure, fundEmployerKey: string, credit: BankCredit | undefined) => ({
  ...closure, fundEmployerKey,
  bankReconciliationStatus: !credit ? 'unverified' : credit.amountMinor !== closure.fundPaidMinor ? 'amount_differs'
    : credit.postedOn !== closure.fundPaidOn ? 'date_differs' : 'matched',
  bankPostedOn: credit?.postedOn ?? null,
  bankAmountMinor: credit?.amountMinor ?? null,
  differenceMinor: credit ? credit.amountMinor - closure.fundPaidMinor : null,
  creditMovementId: credit?.movementId ?? null,
} as const);

export const cashBalanceCutoffDay = (month: string, now: Date): string => {
  const today = dayKeyInZone(now);
  return month < today.slice(0, 7) ? `${month}-${daysInCalendarMonth(month)}` : today;
};

export const monthCashLiquidity = (month: string, now: Date, snapshots: readonly BankCashBalance[]) => {
  const today = dayKeyInZone(now);
  const asOfDay = cashBalanceCutoffDay(month, now);
  const asOf = new Date(`${asOfDay}T18:00:00Z`);
  const byAccount = new Map<ManualCashAccountId, BankCashBalance>();
  for (const snapshot of snapshots) {
    if (!isManualCashAccountId(snapshot.accountId) || snapshot.day > asOfDay) continue;
    const prior = byAccount.get(snapshot.accountId);
    if (!prior || snapshot.day > prior.day || snapshot.day === prior.day && snapshot.capturedAt > prior.capturedAt) {
      byAccount.set(snapshot.accountId, snapshot);
    }
  }
  const accounts = [...byAccount.values()].map(snapshot => ({ ...snapshot, stale: isWealthSnapshotStale(snapshot.day, asOf) }));
  const sameDay = accounts.length === 2 && accounts[0]!.day === accounts[1]!.day;
  const totalMinor = sameDay ? financialSum(accounts.map(account => account.amountMinor)) : null;
  const status = accounts.length === 0 ? 'missing' : accounts.length < 2 ? 'partial'
    : !sameDay ? 'mixed_dates' : accounts.some(account => account.stale) ? 'stale' : 'recorded';
  const isClosed = month < today.slice(0, 7);
  const recordedClose = isClosed && sameDay && accounts[0]!.day === asOfDay;
  const closingReasons = recordedClose ? [] : isClosed ? ['period_end_balance_missing'] : [
    ...(status === 'missing' || status === 'partial' ? ['cash_accounts_missing'] : []),
    ...(status === 'mixed_dates' ? ['snapshot_dates_differ'] : []),
    ...(accounts.some(account => account.stale) ? ['cash_snapshot_stale'] : []),
    'snapshot_coverage_unverified', 'card_payment_timing_unverified',
  ];
  return { current: { status, asOfDay, balanceDay: sameDay ? accounts[0]!.day : null, totalMinor, accounts },
    closing: { status: recordedClose ? 'recorded' : 'not_available', amountMinor: recordedClose ? totalMinor : null,
      reasons: closingReasons } } as const;
};

export const summarizePostedCredits = (credits: readonly BankCredit[]) => {
  const income = credits.filter(credit => credit.creditType === 'income');
  const refunds = credits.filter(credit => credit.creditType === 'refund');
  const incomeMinor = financialSum(income.map(credit => credit.amountMinor));
  const cashRefundsMinor = financialSum(refunds.filter(credit => credit.accountKind === 'cash').map(credit => credit.amountMinor));
  return {
    scope: 'posted_bank_credits_only',
    incomeStatus: income.length ? 'recorded' : 'no_recorded_evidence',
    incomeMinor, cashRefundsMinor,
    cardRefundsMinor: financialSum(refunds.filter(credit => credit.accountKind === 'credit_card').map(credit => credit.amountMinor)),
    recordedOperatingCashInflowsMinor: financialSum([incomeMinor, cashRefundsMinor]),
    snapshotCoverage: 'unverified',
    credits: credits.filter(credit => credit.creditType !== 'fund_release'),
  } as const;
};
