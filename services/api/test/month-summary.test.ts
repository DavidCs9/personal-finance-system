import { describe, expect, it } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';

const { summarizeMonthFeed } = await import('../src/months/summary.js');

describe('summarizeMonthFeed', () => {
  it('counts the current cuota of an MSI plan bought in a prior month', () => {
    const plan = {
      configured: true,
      incomeMinor: 10_000_00,
      upcomingPayments: [],
    };
    const priorPurchase = {
      id: 'msi-prior-purchase',
      amount: { amountMinor: 1_500_00 },
      status: 'accepted',
      occurredAt: '2026-07-10T12:00:00Z',
      receivedAt: '2026-07-10T12:00:00Z',
      merchantRaw: 'Tienda',
      msi: {
        months: 3,
        principalMinor: 1_500_00,
        cuotaMinor: 500_00,
        installments: [
          { index: 1, month: '2026-07', amountMinor: 500_00, status: 'spent' },
          { index: 2, month: '2026-08', amountMinor: 500_00, status: 'spent' },
          { index: 3, month: '2026-09', amountMinor: 500_00, status: 'committed' },
        ],
      },
    };

    const summary = summarizeMonthFeed('2026-08', plan, {
      events: [{
        id: 'august-purchase',
        amount: { amountMinor: 200_00 },
        status: 'accepted',
        occurredAt: '2026-08-03T12:00:00Z',
        receivedAt: '2026-08-03T12:00:00Z',
      }],
      msiRelated: [priorPurchase, priorPurchase],
    }, new Date('2026-08-04T12:00:00Z'));

    expect(summary.discretionarySpentMinor).toBe(200_00);
    expect(summary.msiSpentMinor).toBe(500_00);
    expect(summary.spentMinor).toBe(700_00);
  });
});

describe('summary fixed-charge read model', () => {
  const now = new Date('2026-08-24T18:00:00Z');
  const plan = { configured: true, incomeMinor: 10_000_00, upcomingPayments: [
    { id: 'service', amountMinor: 399_00, reconciliation: { eventId: 'charge', valid: true,
      amountMinor: 200_00, grossAmountMinor: 450_00, merchantRaw: 'Service' } },
  ] };
  const charge = { id: 'charge', amount: { amountMinor: 450_00, currency: 'MXN' }, personalAmountMinor: 200_00,
    status: 'accepted', receivedAt: '2026-08-18T12:00:00Z' };

  it('uses the same existing charge once in the deduplicated feed and full fixed coverage', () => {
    const summary = summarizeMonthFeed('2026-08', plan, { events: [charge], msiRelated: [charge] }, now);
    expect(summary).toMatchObject({ spentMinor: 200_00, fixedSpentMinor: 200_00, discretionarySpentMinor: 0,
      billScheduledMinor: 399_00, billUpcomingMinor: 0, remainingMinor: 9800_00, projectedSpendMinor: 200_00 });
  });

  it('keeps programming when the linked charge is absent from the selected feed', () => {
    expect(summarizeMonthFeed('2026-08', plan, { events: [], msiRelated: [] }, now))
      .toMatchObject({ spentMinor: 0, fixedSpentMinor: 0, billScheduledMinor: 399_00, billUpcomingMinor: 399_00 });
  });
});
