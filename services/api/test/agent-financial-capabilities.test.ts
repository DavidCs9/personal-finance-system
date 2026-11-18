import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
import type { WealthBalanceOverview, WealthOverview } from '../src/wealth/service.js';
import { InvalidMonthlyPlanError } from '../src/months/monthly-plan.js';

process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const reads = vi.hoisted(() => ({ commitments: vi.fn(), plan: vi.fn(), cards: vi.fn(), wealth: vi.fn(), asOf: vi.fn() }));
vi.mock('../src/months/commitments.js', () => ({ getFutureCommitments: reads.commitments }));
vi.mock('../src/months/service.js', () => ({ getMonthlyPlan: reads.plan }));
vi.mock('../src/cards/cards.js', () => ({ listCards: reads.cards }));
vi.mock('../src/wealth/service.js', () => ({ getWealthOverview: reads.wealth, getWealthOverviewsAsOf: reads.asOf }));
const { runAgentTool } = await import('../src/agent/tools.js');
const { handler, gatewayToolDefinitions } = await import('../src/agent/tools-handler.js');
const { wealthHistoryForAgent } = await import('../src/agent/financial-capabilities.js');
const now = new Date('2026-11-01T02:00:00Z'); // Still October in Chihuahua.
const card = { id: 'amex', name: 'Amex', institution: 'amex', cutOffDay: 31, paymentDueDay: 15 };
const snapshot = { day: '2026-08-20', capturedAt: '2026-08-20T18:00:00Z', source: 'manual' as const,
  currency: 'MXN' as const, totalMxnMinor: 10001, evidence: { bucket: 'SECRET', key: 'SECRET', sha256: 'SECRET', contentType: 'application/json' as const } };
const balance = (day: string): WealthBalanceOverview => ({
  currency: 'MXN', asOfDay: day, totalMxnMinor: 10001, assetsMxnMinor: 10001,
  liabilitiesMxnMinor: 100, netMxnMinor: 9901,
  accounts: [{ id: 'nu_cajita_emergencia', name: 'Cajita', institution: 'Nu', role: 'cash', sync: 'manual', connected: true,
    latestSnapshot: { ...snapshot, accountId: 'nu_cajita_emergencia', holdings: [] } },
  { id: 'bitso', name: 'Bitso', institution: 'Bitso', role: 'crypto', sync: 'api', connected: false, latestSnapshot: null }],
  liabilities: [{ cardId: 'amex', name: 'Amex', latestSnapshot: { ...snapshot, cardId: 'amex', totalMxnMinor: 100 } }],
});
const overview = (): WealthOverview => ({ ...balance('2026-10-31'), history: { all: [
  { day: '2026-07-01', totalMxnMinor: 123 }, // Defend the policy even if a source includes prehistory.
  { day: '2026-08-01', totalMxnMinor: 9901 },
  { day: '2026-10-01', totalMxnMinor: 9901 },
], byAccount: {} } });
const context = (name: string) => ({ clientContext: { custom: { bedrockAgentCoreToolName: `olbia-finance___${name}` } } }) as unknown as Context;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENT_OWNER', 'owner');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  reads.cards.mockResolvedValue([card, { ...card, id: 'missing', institution: undefined }, { ...card, id: 'zero' }]);
  const wealth = overview();
  reads.wealth.mockResolvedValue({ ...wealth, liabilities: [...wealth.liabilities,
    { cardId: 'zero', name: 'Zero', latestSnapshot: { ...snapshot, cardId: 'zero', totalMxnMinor: 0, day: '2026-10-31' } }] });
  reads.asOf.mockImplementation(async (_owner: string, days: string[]) => days.map(balance));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('P0 Gateway financial capabilities', () => {
  it('returns the canonical 12-month commitment schedule intact through the configured owner', async () => {
    const schedule = { currency: 'MXN', currentMonth: '2026-10', months: Array.from({ length: 12 }, (_, index) => ({
      month: `month-${index}`, totalMinor: 12345, uncertainMinor: 10001,
      items: [{ kind: 'msi', installmentIndex: 2, installments: 12, amountMinor: 10001 },
        { kind: 'fixed', dueDay: 31, amountMinor: 2344 }],
    })), incompletePlans: [{ eventId: 'incomplete' }], nextStartMonth: '2027-10' };
    reads.commitments.mockResolvedValue(schedule);
    expect(await handler({ owner: 'untrusted' }, context('get_future_commitments'))).toBe(schedule);
    expect(reads.commitments).toHaveBeenLastCalledWith('owner', undefined);
    expect(await runAgentTool('owner', 'get_future_commitments', { startMonth: '2027-10' })).toBe(schedule);
    expect(reads.commitments).toHaveBeenLastCalledWith('owner', '2027-10');
    reads.commitments.mockRejectedValueOnce(new InvalidMonthlyPlanError('Mes pasado.'));
    expect(await handler({ startMonth: '2026-09' }, context('get_future_commitments')))
      .toMatchObject({ ok: false, status: 'invalid_request', message: 'Mes pasado.' });
  });

  it.each([
    { configured: true, depositedMinor: 12345, estimatedMinor: 12345, estimateActive: true, provisionalActive: false, provisionalMinor: 0 },
    { configured: true, depositedMinor: 0, estimatedMinor: 0, estimateActive: false, provisionalActive: true, provisionalMinor: 24690 },
    { configured: false, depositedMinor: 0, estimatedMinor: 0, estimateActive: false, provisionalActive: false, provisionalMinor: 0 },
  ])('preserves recorded versus estimated/provisional/missing payroll: %j', async income => {
    reads.plan.mockResolvedValue({ month: '2027-02', currency: 'MXN', incomeMinor: 24690, ...income,
      inheritedFromMonth: '2026-12', payslips: [{ employerName: 'Employer', fechaPago: '2027-02-15', tipoNomina: 'O',
        totalMinor: 12345, lines: [{ secret: 'SECRET' }], evidence: 'SECRET', uuid: 'SECRET' }],
      upcomingPayments: [
        { id: 'rent', name: 'Rent', amountMinor: 9001, dueDay: 31 },
        { id: 'linked', name: 'Internet', amountMinor: 1001, dueDay: 15, reconciliation: { valid: true, amountMinor: 0 } },
        { id: 'invalid', name: 'Service', amountMinor: 101, dueDay: 10, reconciliation: { valid: false, invalidReason: 'Otro mes.' } },
      ] });
    const result = await handler({ month: '2027-02', owner: 'untrusted' }, context('get_month_details'));
    expect(reads.plan).toHaveBeenCalledWith('owner', '2027-02');
    expect(result).toMatchObject({ ...income, incomeMinor: 24690, inheritedFromMonth: '2026-12',
      payslips: [{ employerName: 'Employer', paymentDate: '2027-02-15', payrollType: 'O', netMinor: 12345 }],
      upcomingPayments: [
        { amountMinor: 9001, configuredDueDay: 31, dueDay: 28, reconciliationState: 'unlinked', effectiveReconciliation: false },
        { reconciliationState: 'linked', effectiveReconciliation: true },
        { reconciliationState: 'needs_review', effectiveReconciliation: false, invalidReason: 'Otro mes.' },
      ] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('distinguishes configured days, outstanding balances, missing/zero balances and unsupported statement/payment data', async () => {
    const result = await handler({ owner: 'untrusted' }, context('get_credit_card_cycles'));
    expect(reads.cards).toHaveBeenCalledWith('owner'); expect(reads.wealth).toHaveBeenCalledWith('owner');
    expect(result).toMatchObject({ asOfDay: '2026-10-31', cards: [
      { cardId: 'amex', institution: 'amex', configuredClosingDay: 31, configuredPaymentDueDay: 15,
        outstandingLiability: { amountMxnMinor: 100, snapshotAsOfDay: '2026-08-20', ageDays: 72, stale: true, freshness: 'stale', carriedForward: true },
        statementBalanceMinor: null, minimumPaymentMinor: null, interestFreePaymentMinor: null, confirmedPaymentMinor: null,
        actualStatementDate: null, actualPaymentDueDate: null, installmentMapping: 'unsupported' },
      { cardId: 'missing', institution: null, outstandingLiability: { amountMxnMinor: null, ageDays: null, freshness: 'missing' } },
      { cardId: 'zero', outstandingLiability: { amountMxnMinor: 0, ageDays: 0, stale: false, freshness: 'fresh' } },
    ] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    reads.cards.mockResolvedValueOnce([]);
    expect(await runAgentTool('owner', 'get_credit_card_cycles', {})).toMatchObject({ cards: [] });
  });

  it('keeps canonical net history, omits gaps/prehistory and exposes month-end component carry-forward freshness', async () => {
    const result = await handler({ fromMonth: '2026-07', toMonth: '2026-10', owner: 'untrusted' }, context('get_wealth_history'));
    expect(reads.wealth).toHaveBeenCalledWith('owner', now);
    expect(reads.asOf).toHaveBeenCalledWith('owner', ['2026-08-31']);
    expect(result).toMatchObject({ coverageStartMonth: '2026-08', availableFromMonth: '2026-08', availableToMonth: '2026-10',
      omittedMonths: [{ month: '2026-07', reason: 'before_history_coverage' }, { month: '2026-09', reason: 'no_canonical_history_point' }],
      months: [
        { month: '2026-08', asOfDay: '2026-08-31', periodStatus: 'closed', netMxnMinor: 9901, netObservationDay: null,
          components: { assetsMxnMinor: 10001, liabilitiesMxnMinor: 100, accounts: [
            { amountMxnMinor: 10001, ageDays: 11, stale: true, carriedForward: true, snapshotAsOfDay: '2026-08-20' },
            { amountMxnMinor: null, freshness: 'missing' }], liabilities: [{ amountMxnMinor: 100 }] } },
        { month: '2026-10', asOfDay: '2026-10-31', periodStatus: 'in_progress', netMxnMinor: 9901 },
      ] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('uses a bounded default and never invents components when their canonical history differs', async () => {
    reads.asOf.mockResolvedValue([{ ...balance('2026-08-31'), netMxnMinor: 9900 }]);
    const result = await wealthHistoryForAgent('owner', {}, now);
    expect(result).toMatchObject({ fromMonth: '2024-11', toMonth: '2026-10', months: [
      { month: '2026-08', netMxnMinor: 9901, components: null, componentsStatus: 'unavailable_canonical_history_mismatch' },
      { month: '2026-10', netMxnMinor: 9901, componentsStatus: 'available' },
    ] });
    expect(result.omittedMonths).toHaveLength(22);
  });

  it('returns empty coverage honestly and skips unnecessary historical reads', async () => {
    reads.wealth.mockResolvedValue({ ...overview(), history: { all: [], byAccount: {} } });
    expect(await wealthHistoryForAgent('owner', { fromMonth: '2026-11', toMonth: '2026-12' }, now))
      .toMatchObject({ months: [], availableFromMonth: null, availableToMonth: null, omittedMonths: [
        { month: '2026-11', reason: 'after_as_of_month' }, { month: '2026-12', reason: 'after_as_of_month' }] });
    expect(reads.asOf).not.toHaveBeenCalled();
  });

  it('accepts exactly 24 months and batches historical calendar cutoffs across a year boundary', async () => {
    const later = new Date('2027-02-10T18:00:00Z');
    reads.wealth.mockResolvedValue({ ...balance('2027-02-10'), history: { all: [
      { day: '2026-12-01', totalMxnMinor: 9901 }, { day: '2027-01-01', totalMxnMinor: 9901 },
    ], byAccount: {} } });
    const result = await wealthHistoryForAgent('owner', { fromMonth: '2025-03', toMonth: '2027-02' }, later);
    expect(reads.asOf).toHaveBeenCalledWith('owner', ['2026-12-31', '2027-01-31']);
    expect(result.months).toHaveLength(2);
    expect(result.omittedMonths).toHaveLength(22);
    expect(result.months.every(point => point.componentsStatus === 'available')).toBe(true);
  });

  it.each([
    ['get_month_details', {}], ['get_month_details', { month: '2026-13' }], ['get_month_details', { month: 202610 }],
    ['get_future_commitments', { startMonth: null }], ['get_future_commitments', { startMonth: '' }],
    ['get_wealth_history', { fromMonth: '2024-10', toMonth: '2026-10' }],
    ['get_wealth_history', { fromMonth: '2026-11', toMonth: '2026-10' }],
    ['get_wealth_history', { toMonth: [] }],
  ])('rejects invalid %s input before financial reads', async (name, input) => {
    expect(await handler(input, context(name))).toMatchObject({ ok: false, status: 'invalid_request' });
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
  });

  it('does not disguise technical failures as empty financial data', async () => {
    reads.commitments.mockRejectedValueOnce(new Error('SQL unavailable'));
    await expect(handler({}, context('get_future_commitments'))).rejects.toThrow('SQL unavailable');
  });

  it('requires the configured owner and exposes exactly the four new tools alongside existing contracts', async () => {
    expect(gatewayToolDefinitions().map(tool => tool.name).filter(name => name.startsWith('get_')))
      .toEqual(['get_future_commitments', 'get_month_details', 'get_credit_card_cycles', 'get_wealth_history']);
    vi.stubEnv('AGENT_OWNER', '');
    await expect(handler({}, context('get_credit_card_cycles'))).rejects.toThrow('AGENT_OWNER');
    expect(reads.cards).not.toHaveBeenCalled();
  });
});
