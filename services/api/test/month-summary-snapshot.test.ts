import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ insideSnapshot: false, plan: vi.fn(), feed: vi.fn(), snapshots: vi.fn() }));
vi.mock('../src/months/service.js', () => ({ getMonthlyPlan: reads.plan }));
vi.mock('../src/events/queries.js', () => ({ listEventsForMonth: reads.feed }));
vi.mock('../src/events/sql-reads.js', () => ({
  withLedgerReadSnapshot: async (callback: () => Promise<unknown>) => {
    reads.snapshots(); reads.insideSnapshot = true;
    try { return await callback(); } finally { reads.insideSnapshot = false; }
  },
}));
const { getMonthSummary } = await import('../src/months/summary.js');

beforeEach(() => {
  vi.clearAllMocks();
  reads.plan.mockImplementation(async () => {
    expect(reads.insideSnapshot).toBe(true);
    return { configured: true, incomeMinor: 1000_00, upcomingPayments: [{ id: 'fixed', amountMinor: 399_00,
      reconciliation: { eventId: 'charge', valid: true } }] };
  });
  reads.feed.mockImplementation(async () => {
    expect(reads.insideSnapshot).toBe(true);
    return { events: [{ id: 'charge', amount: { amountMinor: 450_00, currency: 'MXN' }, personalAmountMinor: 200_00,
      status: 'accepted', receivedAt: '2026-08-18T12:00:00Z' }], msiRelated: [] };
  });
});

describe('canonical summary read boundary', () => {
  it('reads programming, relationships and observed charges in the same provider snapshot', async () => {
    await expect(getMonthSummary('owner', '2026-08', new Date('2026-08-24T18:00:00Z')))
      .resolves.toMatchObject({ spentMinor: 200_00, fixedSpentMinor: 200_00, billUpcomingMinor: 0 });
    expect(reads.snapshots).toHaveBeenCalledOnce();
    expect(reads.plan).toHaveBeenCalledWith('owner', '2026-08');
    expect(reads.feed).toHaveBeenCalledWith('2026-08');
    expect(reads.insideSnapshot).toBe(false);
  });

  it('fails the summary when either source fails instead of presenting absent charges as zero', async () => {
    reads.feed.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(getMonthSummary('owner', '2026-08')).rejects.toThrow('ledger unavailable');
    expect(reads.insideSnapshot).toBe(false);
  });
});
