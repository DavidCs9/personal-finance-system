import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeMonthSummary } from '@finance/domain';

process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw';
const reads = vi.hoisted(() => ({ summary: vi.fn(), events: vi.fn(), snapshots: vi.fn() }));
vi.mock('../src/months/summary.js', () => ({ getMonthSummary: reads.summary }));
vi.mock('../src/events/sql-reads.js', () => ({ withLedgerReadSnapshot: async (callback: () => Promise<unknown>) => {
  reads.snapshots(); return callback();
} }));
vi.mock('../src/categories/service.js', () => ({ listCategories: async () => [] }));
vi.mock('../src/analytics/events.js', () => ({ loadCategorizedMonthEvents: reads.events,
  loadCategorizedMonthsEvents: vi.fn(), loadCategorizedComparisonEvents: vi.fn() }));
const { monthSnapshot, planMonthScenario } = await import('../src/agent/aggregates.js');
const now = new Date('2026-08-24T18:00:00Z');
const event = { id: 'service', amountMinor: 450_00, currency: 'MXN', personalAmountMinor: 200_00,
  status: 'accepted', merchantRaw: 'Service', receivedAt: '2026-08-18T12:00:00Z' };
const summary = computeMonthSummary({ events: [event], month: '2026-08', incomeMinor: 10_000_00,
  incomeConfigured: true, upcomingPaymentsMinor: 499_00, fixedPayments: [
    { id: 'service-fixed', amountMinor: 399_00, reconciliation: { eventId: 'service', valid: true } },
    { id: 'unlinked-fixed', amountMinor: 100_00 },
  ], now });

beforeEach(() => {
  vi.clearAllMocks(); reads.summary.mockResolvedValue(summary); reads.events.mockResolvedValue([event]);
});

describe('assistant canonical monthly amounts', () => {
  it('returns the same summary used by API and push while retaining observed category confidence', async () => {
    const result = await monthSnapshot('owner', '2026-08', now);
    expect(reads.summary).toHaveBeenCalledWith('owner', '2026-08', now);
    expect(result.summary).toBe(summary);
    expect(result).toMatchObject({ uncategorizedMinor: 200_00, uncategorizedEventCount: 1 });
    expect(reads.snapshots).toHaveBeenCalledOnce();
  });

  it('uses only unlinked programming in a scenario instead of adding a covered fixed charge twice', async () => {
    const result = await planMonthScenario('owner', { month: '2026-08', budgetMxn: 10_000,
      includeLedgerUpcoming: true, tripStart: '2026-08-25', tripEnd: '2026-08-26' });
    expect(result).toMatchObject({ recordedSpentMxnMinor: 200_00, ledgerUpcomingMxnMinor: 100_00,
      remainingAfterCommitmentsMxnMinor: 9700_00 });
  });
});
