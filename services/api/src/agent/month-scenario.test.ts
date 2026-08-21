import { describe, expect, it } from 'vitest';
import { buildMonthScenario, InvalidMonthScenarioError } from './month-scenario.js';

describe('buildMonthScenario', () => {
  it('reproduces the golden month and trip arithmetic exactly', () => {
    const result = buildMonthScenario({
      month: '2026-08',
      budgetMxn: 50_000,
      recordedSpentMxnMinor: 3_695_549,
      ledgerUpcomingMxnMinor: 0,
      commitments: [
        { label: 'Deuda 1', amount: 217, currency: 'USD' },
        { label: 'Deuda 2', amount: 200, currency: 'USD' },
      ],
      usdToMxn: 17,
      tripStart: '2026-08-21',
      tripEnd: '2026-08-26',
      dailyUsdScenarios: [100, 150, 200],
    });

    expect(result.availableBeforeCommitmentsMxnMinor).toBe(1_304_451);
    expect(result.commitmentsMxnMinor).toBe(708_900);
    expect(result.remainingAfterCommitmentsMxnMinor).toBe(595_551);
    expect(result.trip).toMatchObject({
      calendarDays: 6,
      nights: 5,
      noOverrunDailyMxnMinor: 99_258,
      noOverrunDailyUsd: 58.38,
    });
    expect(result.scenarios).toEqual([
      {
        dailyUsd: 100,
        tripSpendMxnMinor: 1_020_000,
        monthCloseMxnMinor: 5_424_449,
        overBudgetMxnMinor: 424_449,
        remainingBudgetMxnMinor: 0,
      },
      {
        dailyUsd: 150,
        tripSpendMxnMinor: 1_530_000,
        monthCloseMxnMinor: 5_934_449,
        overBudgetMxnMinor: 934_449,
        remainingBudgetMxnMinor: 0,
      },
      {
        dailyUsd: 200,
        tripSpendMxnMinor: 2_040_000,
        monthCloseMxnMinor: 6_444_449,
        overBudgetMxnMinor: 1_444_449,
        remainingBudgetMxnMinor: 0,
      },
    ]);
  });

  it('rejects currency ambiguity instead of silently treating USD as MXN', () => {
    expect(() => buildMonthScenario({
      month: '2026-08',
      budgetMxn: 50_000,
      recordedSpentMxnMinor: 0,
      ledgerUpcomingMxnMinor: 0,
      commitments: [{ label: 'Deuda', amount: 217, currency: 'USD' }],
      tripStart: '2026-08-21',
      tripEnd: '2026-08-26',
    })).toThrow(InvalidMonthScenarioError);
  });
});
