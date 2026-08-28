import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategorizedSpendEvent } from '@finance/domain';

const loadCategorizedMonthsEvents = vi.fn();
const listCategories = vi.fn();

vi.mock('../src/analytics/events.js', () => ({ loadCategorizedMonthsEvents }));
vi.mock('../src/categories/service.js', () => ({ listCategories }));

const { getSpendingAnalytics } = await import('../src/analytics/service.js');

const event = (
  id: string,
  amountMinor: number,
  occurredAt: string,
  overrides: Partial<CategorizedSpendEvent> = {},
): CategorizedSpendEvent => ({
  id,
  amountMinor,
  status: 'accepted',
  occurredAt,
  receivedAt: occurredAt,
  merchantRaw: id,
  categoryId: 'otros',
  ...overrides,
});

describe('spending analytics service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCategories.mockResolvedValue([
      { id: 'restaurantes', name: 'Restaurantes', sortOrder: 10 },
      { id: 'viajes', name: 'Viajes', sortOrder: 20 },
    ]);
  });

  it('compares equivalent elapsed days and returns additive categories plus overlapping tag lenses', async () => {
    loadCategorizedMonthsEvents.mockResolvedValue([
      event('aug-food', 300_00, '2026-08-10T18:00:00Z', {
        categoryId: 'restaurantes',
        tags: ['trabajo', 'viaje:cdmx'],
      }),
      event('aug-review', 100_00, '2026-08-11T18:00:00Z', {
        categoryId: null,
        status: 'needs_review',
      }),
      event('jul-early', 125_00, '2026-07-05T18:00:00Z', { categoryId: 'restaurantes' }),
      event('jul-late', 900_00, '2026-07-20T18:00:00Z', { categoryId: 'viajes' }),
    ]);

    const result = await getSpendingAnalytics('2026-08', new Date('2026-08-12T18:00:00Z'));

    expect(loadCategorizedMonthsEvents).toHaveBeenCalledWith(['2026-08', '2026-07']);
    expect(result.comparison).toEqual({
      againstMonth: '2026-07',
      throughDay: 12,
      amountMinor: 400_00,
      againstAmountMinor: 125_00,
      deltaMinor: 275_00,
      excludedMonthOnlyMinor: 0,
    });
    expect(result.categories.find((bucket) => bucket.key === 'restaurantes')).toMatchObject({
      label: 'Restaurantes',
      amountMinor: 300_00,
      againstAmountMinor: 125_00,
      againstEventIds: ['jul-early'],
      deltaMinor: 175_00,
      eventIds: ['aug-food'],
    });
    expect(result.tags).toEqual([
      expect.objectContaining({ key: 'trabajo', amountMinor: 300_00, eventIds: ['aug-food'] }),
      expect.objectContaining({ key: 'viaje:cdmx', amountMinor: 300_00, eventIds: ['aug-food'] }),
    ]);
    expect(result.confidence).toEqual({
      uncategorizedMinor: 100_00,
      uncategorizedEventCount: 1,
      uncertainMinor: 100_00,
      uncertainEventIds: ['aug-review'],
    });
  });

  it('uses full-month comparisons for a completed selected month', async () => {
    loadCategorizedMonthsEvents.mockResolvedValue([
      event('jul', 200_00, '2026-07-28T18:00:00Z', { categoryId: 'viajes' }),
      event('jun', 100_00, '2026-06-30T18:00:00Z', { categoryId: 'viajes' }),
    ]);

    const result = await getSpendingAnalytics('2026-07', new Date('2026-08-12T18:00:00Z'));

    expect(result.comparison).toEqual({
      againstMonth: '2026-06',
      amountMinor: 200_00,
      againstAmountMinor: 100_00,
      deltaMinor: 100_00,
      excludedMonthOnlyMinor: 0,
    });
  });

  it('discloses month-only MSI that cannot be placed in an elapsed-day comparison', async () => {
    loadCategorizedMonthsEvents.mockResolvedValue([
      event('aug', 200_00, '2026-08-10T18:00:00Z', { categoryId: 'viajes' }),
      event('legacy-msi', 900_00, '2026-06-01T18:00:00Z', {
        categoryId: 'viajes',
        msi: {
          months: 3,
          principalMinor: 900_00,
          cuotaMinor: 300_00,
          installments: [
            { index: 2, month: '2026-07', amountMinor: 300_00, status: 'spent' },
          ],
        },
      }),
    ]);

    const result = await getSpendingAnalytics('2026-08', new Date('2026-08-12T18:00:00Z'));

    expect(result.comparison).toEqual({
      againstMonth: '2026-07',
      throughDay: 12,
      amountMinor: 200_00,
      againstAmountMinor: 0,
      deltaMinor: 200_00,
      excludedMonthOnlyMinor: 300_00,
    });
  });
});
