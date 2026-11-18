import {
  addCalendarMonths, CARD_LIABILITY_STALE_DAYS, CAJITA_STALE_DAYS, clampDayInMonth,
  FINANCE_TIME_ZONE, isManualCashAccountId, isValidMonth, isWealthSnapshotStale,
  monthKeyInZone, WEALTH_TOTAL_HISTORY_START_MONTH, wealthSnapshotAgeDays,
  type CardLiabilitySnapshot, type WealthSnapshot,
} from '@finance/domain';
import { listCards } from '../cards/cards.js';
import { getFutureCommitments } from '../months/commitments.js';
import { InvalidMonthlyPlanError } from '../months/monthly-plan.js';
import { getMonthlyPlan } from '../months/service.js';
import { getWealthOverview, getWealthOverviewsAsOf, type WealthBalanceOverview } from '../wealth/service.js';
import { InvalidAgentQueryError } from './aggregates.js';

const monthArgument = (input: Record<string, unknown>, key: string, required = false): string | undefined => {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidMonth(value)) {
    throw new InvalidAgentQueryError(`${key} debe ser un mes YYYY-MM válido.`);
  }
  return value;
};

/** The canonical schedule is returned intact, including uncertainty and pagination. */
export const futureCommitmentsForAgent = async (owner: string, input: Record<string, unknown>) => {
  const startMonth = monthArgument(input, 'startMonth');
  try {
    return await getFutureCommitments(owner, startMonth);
  } catch (error) {
    if (error instanceof InvalidMonthlyPlanError) throw new InvalidAgentQueryError(error.message);
    throw error;
  }
};

export const monthDetailsForAgent = async (owner: string, input: Record<string, unknown>) => {
  const month = monthArgument(input, 'month', true)!;
  const plan = await getMonthlyPlan(owner, month);
  return {
    month, currency: plan.currency, timeZone: FINANCE_TIME_ZONE,
    configured: plan.configured,
    incomeMinor: plan.incomeMinor,
    depositedMinor: plan.depositedMinor,
    estimatedMinor: plan.estimatedMinor,
    estimateActive: plan.estimateActive,
    provisionalActive: plan.provisionalActive,
    provisionalMinor: plan.provisionalMinor,
    inheritedFromMonth: plan.inheritedFromMonth ?? null,
    payslips: plan.payslips.map(slip => ({
      employerName: slip.employerName ?? null,
      paymentDate: slip.fechaPago, payrollType: slip.tipoNomina, netMinor: slip.totalMinor,
    })),
    upcomingPayments: plan.upcomingPayments.map(payment => ({
      id: payment.id, name: payment.name, amountMinor: payment.amountMinor,
      configuredDueDay: payment.dueDay, dueDay: clampDayInMonth(payment.dueDay, month),
      reconciliationState: !payment.reconciliation ? 'unlinked'
        : payment.reconciliation.valid ? 'linked' : 'needs_review',
      effectiveReconciliation: payment.reconciliation?.valid ?? false,
      invalidReason: payment.reconciliation?.invalidReason ?? null,
    })),
  };
};

/** Allowlist metadata only: provider evidence, holdings and document contents stay private. */
const snapshotFacts = (snapshot: WealthSnapshot | CardLiabilitySnapshot | null, asOfDay: string,
  staleAfterDays?: number) => {
  const derived = snapshot?.source === 'derived';
  const cutoff = new Date(`${asOfDay}T18:00:00.000Z`);
  return {
    amountMxnMinor: snapshot?.totalMxnMinor ?? null,
    snapshotAsOfDay: snapshot?.day ?? null,
    capturedAt: derived ? null : snapshot?.capturedAt ?? null,
    source: snapshot?.source ?? null,
    ageDays: snapshot && !derived ? wealthSnapshotAgeDays(snapshot.day, cutoff) : null,
    carriedForward: snapshot && !derived ? snapshot.day < asOfDay : null,
    stale: snapshot && !derived && staleAfterDays !== undefined
      ? isWealthSnapshotStale(snapshot.day, cutoff, staleAfterDays) : null,
    freshness: !snapshot ? 'missing' : derived ? 'payroll_derived_as_of_cutoff'
      : staleAfterDays === undefined ? 'age_only_no_staleness_policy'
        : isWealthSnapshotStale(snapshot.day, cutoff, staleAfterDays) ? 'stale' : 'fresh',
  };
};

export const creditCardCyclesForAgent = async (owner: string) => {
  const [cards, wealth] = await Promise.all([listCards(owner), getWealthOverview(owner)]);
  const liabilities = new Map(wealth.liabilities.map(liability => [liability.cardId, liability]));
  return {
    currency: 'MXN', timeZone: FINANCE_TIME_ZONE, asOfDay: wealth.asOfDay,
    cycleBasis: 'configured_days_not_actual_statement_dates',
    liabilityBasis: 'latest_selected_total_outstanding_including_msi_not_payment_due',
    individualPurchaseCoverage: 'not_determined_by_this_tool',
    cards: cards.map(card => ({
      cardId: card.id, name: card.name, institution: card.institution ?? null,
      configuredClosingDay: card.cutOffDay, configuredPaymentDueDay: card.paymentDueDay,
      outstandingLiability: snapshotFacts(liabilities.get(card.id)?.latestSnapshot ?? null,
        wealth.asOfDay, CARD_LIABILITY_STALE_DAYS),
      actualStatementDate: null, actualPaymentDueDate: null, statementBalanceMinor: null,
      minimumPaymentMinor: null, interestFreePaymentMinor: null, confirmedPaymentMinor: null,
      installmentMapping: 'unsupported',
    })),
  };
};

const componentsForAgent = (wealth: WealthBalanceOverview) => ({
  assetsMxnMinor: wealth.assetsMxnMinor, liabilitiesMxnMinor: wealth.liabilitiesMxnMinor,
  accounts: wealth.accounts.map(account => ({
    accountId: account.id, name: account.name,
    ...snapshotFacts(account.latestSnapshot, wealth.asOfDay,
      isManualCashAccountId(account.id) ? CAJITA_STALE_DAYS : undefined),
  })),
  liabilities: wealth.liabilities.map(liability => ({
    cardId: liability.cardId, name: liability.name,
    ...snapshotFacts(liability.latestSnapshot, wealth.asOfDay, CARD_LIABILITY_STALE_DAYS),
  })),
});

export const wealthHistoryForAgent = async (owner: string, input: Record<string, unknown>, now = new Date()) => {
  const toMonth = monthArgument(input, 'toMonth') ?? monthKeyInZone(now);
  const fromMonth = monthArgument(input, 'fromMonth') ?? addCalendarMonths(toMonth, -23);
  const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  const monthCount = monthIndex(toMonth) - monthIndex(fromMonth) + 1;
  if (monthCount < 1 || monthCount > 24) {
    throw new InvalidAgentQueryError('El rango debe estar ordenado y abarcar como máximo 24 meses inclusivos.');
  }
  const wealth = await getWealthOverview(owner, now);
  const currentMonth = wealth.asOfDay.slice(0, 7);
  // Filter only existing points. Missing months are coverage gaps, never new observations.
  const points = wealth.history.all.filter(point => {
    const month = point.day.slice(0, 7);
    return month >= WEALTH_TOTAL_HISTORY_START_MONTH && month >= fromMonth && month <= toMonth && month <= currentMonth;
  });
  const cutoffFor = (month: string) => month === currentMonth ? wealth.asOfDay
    : `${month}-${String(clampDayInMonth(31, month)).padStart(2, '0')}`;
  const historicalDays = points.filter(point => point.day.slice(0, 7) !== currentMonth)
    .map(point => cutoffFor(point.day.slice(0, 7)));
  const historical = historicalDays.length ? await getWealthOverviewsAsOf(owner, historicalDays) : [];
  const byDay = new Map(historical.map(overview => [overview.asOfDay, overview]));
  const months = points.map(point => {
    const month = point.day.slice(0, 7);
    const asOfDay = cutoffFor(month);
    const overview = month === currentMonth ? wealth : byDay.get(asOfDay);
    const supported = overview?.netMxnMinor === point.totalMxnMinor;
    return {
      month, asOfDay, periodStatus: month === currentMonth ? 'in_progress' : 'closed',
      netMxnMinor: point.totalMxnMinor,
      netObservationDay: null,
      componentsStatus: supported ? 'available' : 'unavailable_canonical_history_mismatch',
      components: supported && overview ? componentsForAgent(overview) : null,
    };
  });
  const included = new Set(months.map(point => point.month));
  const omittedMonths = [];
  for (let index = 0; index < monthCount; index++) {
    const month = index === 0 ? fromMonth : addCalendarMonths(fromMonth, index);
    if (!included.has(month)) omittedMonths.push({ month, reason: month < WEALTH_TOTAL_HISTORY_START_MONTH
      ? 'before_history_coverage' : month > currentMonth ? 'after_as_of_month' : 'no_canonical_history_point' });
  }
  return {
    currency: 'MXN', timeZone: FINANCE_TIME_ZONE, asOfDay: wealth.asOfDay,
    fromMonth, toMonth, coverageStartMonth: WEALTH_TOTAL_HISTORY_START_MONTH,
    availableFromMonth: months[0]?.month ?? null, availableToMonth: months.at(-1)?.month ?? null,
    basis: 'canonical_monthly_net_history_with_as_of_components',
    freshnessBasis: 'component_age_at_as_of_day_not_query_day',
    limitations: [
      'Monthly history labels do not identify observation dates; netObservationDay is unavailable.',
      'Components use the latest selected snapshots on or before the cutoff; carried-forward values are not new observations.',
      'Missing components are not verified zero balances; derived payroll balances are not bank snapshots.',
      'Liabilities include total outstanding MSI; scheduled installments must not be subtracted again.',
      'Missing months are omitted; no interpolation or history before August 2026.',
    ],
    omittedMonths, months,
  };
};
