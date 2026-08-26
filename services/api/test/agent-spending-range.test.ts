import { describe, expect, it } from 'vitest';
import { buildMsiSchedule, markInstallmentSpent, type CategorizedSpendEvent } from '@finance/domain';
import {
  InvalidSpendingRangeQueryError,
  resolveSpendingRange,
  spendingRangeFromEvents,
} from '../src/agent/spending-range.js';

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

describe('spending ranges', () => {
  const now = new Date('2026-08-16T18:00:00.000Z');

  it('resolves yesterday in the finance timezone and totals only that calendar day', () => {
    const result = spendingRangeFromEvents([
      event('late-local', 125_00, '2026-08-16T05:30:00.000Z'),
      event('today', 200_00, '2026-08-16T14:00:00.000Z'),
      event('rejected', 900_00, '2026-08-15T18:00:00.000Z', { status: 'rejected' }),
    ], { range: 'yesterday' }, now);

    expect(result).toMatchObject({
      requestedRange: 'yesterday',
      fromDay: '2026-08-15',
      toDay: '2026-08-15',
      totalSpentMinor: 125_00,
      movementCount: 1,
      complete: true,
    });
    expect(result.movements[0]).toMatchObject({
      id: 'late-local',
      occurredOn: '2026-08-15',
      datePrecision: 'day',
    });
  });

  it('supports a week that crosses a month boundary', () => {
    const septemberFirst = new Date('2026-09-01T18:00:00.000Z');
    const range = resolveSpendingRange({ range: 'this_week' }, septemberFirst);
    expect(range).toEqual({
      requestedRange: 'this_week',
      fromDay: '2026-08-31',
      toDay: '2026-09-01',
      months: ['2026-08', '2026-09'],
    });

    const result = spendingRangeFromEvents([
      event('monday', 100_00, '2026-08-31T18:00:00.000Z'),
      event('tuesday', 200_00, '2026-09-01T18:00:00.000Z'),
      event('sunday', 400_00, '2026-08-30T18:00:00.000Z'),
    ], { range: 'this_week' }, septemberFirst);
    expect(result.totalSpentMinor).toBe(300_00);
    expect(result.movements.map((movement) => movement.id)).toEqual(['tuesday', 'monday']);
  });

  it('keeps the full total and count when returned rows are limited', () => {
    const result = spendingRangeFromEvents([
      event('one', 100_00, '2026-08-15T12:00:00.000Z'),
      event('two', 200_00, '2026-08-15T13:00:00.000Z'),
      event('three', 300_00, '2026-08-15T14:00:00.000Z'),
    ], { range: 'yesterday', limit: 2 }, now);

    expect(result.totalSpentMinor).toBe(600_00);
    expect(result.movementCount).toBe(3);
    expect(result.movements).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('uses Mi parte for shared non-MSI purchases', () => {
    const result = spendingRangeFromEvents([
      event('shared', 1_000_00, '2026-08-15T18:00:00.000Z', {
        personalAmountMinor: 250_00,
      }),
    ], { range: 'yesterday' }, now);

    expect(result.totalSpentMinor).toBe(250_00);
    expect(result.movements[0]).toMatchObject({ id: 'shared', amountMinor: 250_00 });
  });

  it('uses a reconciled MSI cuota instead of the full purchase principal', () => {
    const plan = markInstallmentSpent(buildMsiSchedule({
      principalMinor: 3_000_00,
      months: 3,
      startMonth: '2026-08',
      origin: 'manual',
    }), 1, {
      amountMinor: 1_000_00,
      occurredOn: '2026-08-15',
      confirmedAt: '2026-08-16T12:00:00.000Z',
    });
    const result = spendingRangeFromEvents([
      event('msi', 3_000_00, '2026-08-10T12:00:00.000Z', { msi: plan }),
    ], { range: 'yesterday' }, now);

    expect(result.totalSpentMinor).toBe(1_000_00);
    expect(result.movements[0]).toMatchObject({
      id: 'msi',
      amountMinor: 1_000_00,
      occurredOn: '2026-08-15',
      installmentIndex: 1,
      installmentMonths: 3,
    });
  });

  it('includes month-only legacy MSI in a full month without inventing a day', () => {
    const plan = markInstallmentSpent(buildMsiSchedule({
      principalMinor: 3_000_00,
      months: 3,
      startMonth: '2026-07',
      origin: 'manual',
    }), 2, {
      amountMinor: 1_000_00,
      confirmedAt: '2026-08-20T12:00:00.000Z',
    });
    const legacyMsi = event('legacy-msi', 3_000_00, '2026-07-10T12:00:00.000Z', { msi: plan });

    const month = spendingRangeFromEvents([legacyMsi], { month: '2026-08' }, now);
    expect(month).toMatchObject({
      totalSpentMinor: 1_000_00,
      excludedMonthOnlySpentMinor: 0,
      complete: true,
    });
    expect(month.movements[0]).toMatchObject({
      id: 'legacy-msi',
      month: '2026-08',
      datePrecision: 'month',
      amountMinor: 1_000_00,
    });
    expect(month.movements[0]).not.toHaveProperty('occurredOn');
  });

  it('keeps this-month totals aligned with Resumen for legacy month-only MSI', () => {
    const plan = markInstallmentSpent(buildMsiSchedule({
      principalMinor: 3_000_00,
      months: 3,
      startMonth: '2026-07',
      origin: 'manual',
    }), 2, {
      amountMinor: 1_000_00,
      confirmedAt: '2026-08-16T12:00:00.000Z',
    });
    const result = spendingRangeFromEvents([
      event('legacy-msi', 3_000_00, '2026-07-10T12:00:00.000Z', { msi: plan }),
    ], { range: 'this_month' }, now);

    expect(result).toMatchObject({
      fromDay: '2026-08-01',
      toDay: '2026-08-16',
      totalSpentMinor: 1_000_00,
      complete: true,
    });
    expect(result.movements[0]).toMatchObject({ datePrecision: 'month' });
  });

  it('discloses month-only MSI excluded from a partial date range', () => {
    const plan = markInstallmentSpent(buildMsiSchedule({
      principalMinor: 3_000_00,
      months: 3,
      startMonth: '2026-07',
      origin: 'manual',
    }), 2, {
      amountMinor: 1_000_00,
      confirmedAt: '2026-08-20T12:00:00.000Z',
    });
    const result = spendingRangeFromEvents([
      event('legacy-msi', 3_000_00, '2026-07-10T12:00:00.000Z', { msi: plan }),
    ], { range: 'yesterday' }, now);

    expect(result).toMatchObject({
      totalSpentMinor: 0,
      excludedMonthOnlySpentMinor: 1_000_00,
      excludedMonthOnlyMovementCount: 1,
      complete: false,
    });
  });

  it('filters by category without changing range semantics', () => {
    const result = spendingRangeFromEvents([
      event('food', 100_00, '2026-08-15T12:00:00.000Z', { categoryId: 'restaurantes' }),
      event('other', 200_00, '2026-08-15T13:00:00.000Z'),
      event('uncategorized', 300_00, '2026-08-15T14:00:00.000Z', { categoryId: null }),
    ], { range: 'yesterday', categoryId: '_uncategorized' }, now);

    expect(result.totalSpentMinor).toBe(300_00);
    expect(result.movements.map((movement) => movement.id)).toEqual(['uncategorized']);
  });

  it('rejects ambiguous, invalid, reversed, and unbounded custom ranges', () => {
    expect(() => resolveSpendingRange({ month: '2026-08', range: 'yesterday' }, now))
      .toThrow('Usa month o range, no ambos.');
    expect(() => resolveSpendingRange({ range: 'custom', fromDay: '2026-08-01' }, now))
      .toThrow('fromDay y toDay son obligatorios');
    expect(() => resolveSpendingRange({
      range: 'custom', fromDay: '2026-08-10', toDay: '2026-08-01',
    }, now)).toThrow('fromDay no puede ser posterior');
    expect(() => resolveSpendingRange({
      range: 'custom', fromDay: '2025-01-01', toDay: '2026-01-02',
    }, now)).toThrow(InvalidSpendingRangeQueryError);
  });
});
