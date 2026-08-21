import { isValidMonth } from '@finance/domain';

export class InvalidMonthScenarioError extends Error {}

export type ScenarioCommitment = {
  readonly label: string;
  readonly amount: number;
  readonly currency: 'MXN' | 'USD';
};

export type MonthScenarioInput = {
  readonly month: string;
  readonly budgetMxn: number;
  readonly recordedSpentMxnMinor: number;
  readonly ledgerUpcomingMxnMinor: number;
  readonly includeLedgerUpcoming?: boolean;
  readonly commitments?: readonly ScenarioCommitment[];
  readonly usdToMxn?: number;
  readonly tripStart: string;
  readonly tripEnd: string;
  readonly dailyUsdScenarios?: readonly number[];
};

const validDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const positiveNumber = (value: number, label: string, allowZero = false): number => {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new InvalidMonthScenarioError(`${label} debe ser un número ${allowZero ? 'no negativo' : 'positivo'}.`);
  }
  return value;
};

const toMinor = (value: number, label: string, allowZero = false): number =>
  Math.round(positiveNumber(value, label, allowZero) * 100);

const calendarSpan = (fromDay: string, toDay: string): { calendarDays: number; nights: number } => {
  if (!validDay(fromDay) || !validDay(toDay)) {
    throw new InvalidMonthScenarioError('tripStart y tripEnd deben usar YYYY-MM-DD.');
  }
  const start = Date.parse(`${fromDay}T12:00:00.000Z`);
  const end = Date.parse(`${toDay}T12:00:00.000Z`);
  if (end < start) throw new InvalidMonthScenarioError('tripEnd no puede ser anterior a tripStart.');
  const nights = Math.round((end - start) / 86_400_000);
  if (nights > 366) throw new InvalidMonthScenarioError('El viaje no puede exceder 366 noches.');
  return { calendarDays: nights + 1, nights };
};

export const buildMonthScenario = (input: MonthScenarioInput) => {
  if (!isValidMonth(input.month)) throw new InvalidMonthScenarioError('Mes inválido (YYYY-MM).');
  const budgetMxnMinor = toMinor(input.budgetMxn, 'budgetMxn');
  const recordedSpentMxnMinor = Math.round(
    positiveNumber(input.recordedSpentMxnMinor, 'recordedSpentMxnMinor', true),
  );
  const ledgerUpcomingMxnMinor = Math.round(
    positiveNumber(input.ledgerUpcomingMxnMinor, 'ledgerUpcomingMxnMinor', true),
  );
  const commitments = input.commitments ?? [];
  if (commitments.length > 25) throw new InvalidMonthScenarioError('Máximo 25 compromisos.');
  const needsFx = commitments.some((item) => item.currency === 'USD')
    || (input.dailyUsdScenarios?.length ?? 0) > 0;
  const usdToMxn = input.usdToMxn;
  if (needsFx && usdToMxn === undefined) {
    throw new InvalidMonthScenarioError('usdToMxn es obligatorio cuando hay montos en USD.');
  }
  if (usdToMxn !== undefined) positiveNumber(usdToMxn, 'usdToMxn');

  const convertedCommitments = commitments.map((item, index) => {
    if (!item.label.trim()) throw new InvalidMonthScenarioError(`commitments[${index}].label es obligatorio.`);
    if (item.currency !== 'MXN' && item.currency !== 'USD') {
      throw new InvalidMonthScenarioError(`commitments[${index}].currency debe ser MXN o USD.`);
    }
    const amountMinor = toMinor(item.amount, `commitments[${index}].amount`, true);
    const amountMxnMinor = item.currency === 'MXN'
      ? amountMinor
      : Math.round(item.amount * usdToMxn! * 100);
    return {
      label: item.label.trim(),
      amount: item.amount,
      currency: item.currency,
      amountMxnMinor,
    };
  });
  const commitmentsMxnMinor = convertedCommitments.reduce((sum, item) => sum + item.amountMxnMinor, 0);
  const includedLedgerUpcomingMxnMinor = input.includeLedgerUpcoming ? ledgerUpcomingMxnMinor : 0;
  const availableBeforeCommitmentsMxnMinor = budgetMxnMinor - recordedSpentMxnMinor;
  const remainingAfterCommitmentsMxnMinor = availableBeforeCommitmentsMxnMinor
    - commitmentsMxnMinor
    - includedLedgerUpcomingMxnMinor;
  const trip = calendarSpan(input.tripStart, input.tripEnd);
  const noOverrunDailyMxnMinor = Math.floor(remainingAfterCommitmentsMxnMinor / trip.calendarDays);

  const dailyUsdScenarios = input.dailyUsdScenarios ?? [];
  if (dailyUsdScenarios.length > 10) throw new InvalidMonthScenarioError('Máximo 10 escenarios diarios.');
  const scenarios = dailyUsdScenarios.map((dailyUsd, index) => {
    positiveNumber(dailyUsd, `dailyUsdScenarios[${index}]`, true);
    const tripSpendMxnMinor = Math.round(dailyUsd * usdToMxn! * trip.calendarDays * 100);
    const monthCloseMxnMinor = recordedSpentMxnMinor
      + commitmentsMxnMinor
      + includedLedgerUpcomingMxnMinor
      + tripSpendMxnMinor;
    return {
      dailyUsd,
      tripSpendMxnMinor,
      monthCloseMxnMinor,
      overBudgetMxnMinor: Math.max(monthCloseMxnMinor - budgetMxnMinor, 0),
      remainingBudgetMxnMinor: Math.max(budgetMxnMinor - monthCloseMxnMinor, 0),
    };
  });

  return {
    month: input.month,
    currency: 'MXN',
    budgetMxnMinor,
    recordedSpentMxnMinor,
    ledgerUpcomingMxnMinor,
    includedLedgerUpcomingMxnMinor,
    availableBeforeCommitmentsMxnMinor,
    commitments: convertedCommitments,
    commitmentsMxnMinor,
    remainingAfterCommitmentsMxnMinor,
    trip: {
      start: input.tripStart,
      end: input.tripEnd,
      calendarDays: trip.calendarDays,
      nights: trip.nights,
      noOverrunDailyMxnMinor,
      noOverrunDailyUsd: usdToMxn === undefined
        ? null
        : Math.floor((noOverrunDailyMxnMinor / 100 / usdToMxn) * 100) / 100,
    },
    usdToMxn: usdToMxn ?? null,
    scenarios,
    assumptions: [
      'Los días calendario incluyen tanto tripStart como tripEnd; las noches son la diferencia entre fechas.',
      input.includeLedgerUpcoming
        ? 'Los pagos próximos del Resumen sí están incluidos; no los repitas en commitments.'
        : 'Los pagos próximos del Resumen son informativos y no se incluyen; agrega compromisos no registrados en commitments.',
      'Los escenarios diarios se aplican a cada día calendario del viaje.',
    ],
  };
};
