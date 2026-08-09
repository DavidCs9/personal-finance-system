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
