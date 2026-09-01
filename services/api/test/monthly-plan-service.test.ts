import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';

const send = vi.fn();
const incomeFieldsForMonth = vi.fn();

vi.mock('../src/http/clients.js', () => ({
  database: { send },
  tableName: 'test-metadata',
}));
vi.mock('../src/imports/cfdi-nomina-flow.js', () => ({ incomeFieldsForMonth }));

const { getMonthlyPlan, saveMonthlyPlan } = await import('../src/months/service.js');

type StoredItem = {
  readonly PK: string;
  readonly SK: string;
  readonly month: string;
  readonly payload: Record<string, unknown>;
  readonly [key: string]: unknown;
};

const items = new Map<string, StoredItem>();
const itemKey = (item: { readonly PK: string; readonly SK: string }) => `${item.PK}|${item.SK}`;
const payment = (name: string, amountMinor = 100_00) => ({
  id: `payment-${name.toLowerCase()}`,
  name,
  amountMinor,
  dueDay: 15,
});
const seedPlan = (owner: string, month: string, upcomingPayments: readonly ReturnType<typeof payment>[]) => {
  const item: StoredItem = {
    PK: `USER#${owner}`,
    SK: `MONTH#${month}`,
    entityType: 'monthly_plan',
    owner,
    month,
    payload: { currency: 'MXN', upcomingPayments, updatedAt: `${month}-01T00:00:00.000Z` },
  };
  items.set(itemKey(item), item);
};

describe('monthly fixed-expense inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    items.clear();
    incomeFieldsForMonth.mockResolvedValue({
      configured: true,
      incomeMinor: 5_000_00,
      depositedMinor: 5_000_00,
      estimatedMinor: 0,
      estimateActive: false,
      provisionalActive: false,
      provisionalMinor: 0,
      payslips: [],
    });
    send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      if (command.constructor.name === 'QueryCommand') {
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        const matches = [...items.values()]
          .filter((item) => item.PK === values[':pk'])
          .filter((item) => item.SK >= values[':monthPrefix'] && item.SK <= values[':month'])
          .sort((left, right) => right.SK.localeCompare(left.SK));
        return { Items: matches.slice(0, Number(command.input.Limit ?? matches.length)) };
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { PK: string; SK: string };
        return { Item: items.get(itemKey(key)) };
      }
      if (command.constructor.name === 'PutCommand') {
        const item = command.input.Item as StoredItem;
        items.set(itemKey(item), item);
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
  });

  it('inherits the latest prior plan across skipped months and a year boundary', async () => {
    seedPlan('owner-1', '2026-11', [payment('Renta', 12_800_00)]);
    seedPlan('other-owner', '2026-12', [payment('Otro')]);

    const plan = await getMonthlyPlan('owner-1', '2027-01');

    expect(plan.upcomingPayments).toEqual([payment('Renta', 12_800_00)]);
    expect(plan.inheritedFromMonth).toBe('2026-11');
  });

  it('does not inherit a plan from a future month', async () => {
    seedPlan('owner-1', '2026-09', [payment('Internet')]);

    const plan = await getMonthlyPlan('owner-1', '2026-08');

    expect(plan.upcomingPayments).toEqual([]);
    expect(plan.inheritedFromMonth).toBeUndefined();
  });

  it('uses an explicit empty month and carries that stop forward', async () => {
    seedPlan('owner-1', '2026-10', [payment('iCloud')]);
    seedPlan('owner-1', '2026-11', []);

    const stoppedMonth = await getMonthlyPlan('owner-1', '2026-11');
    const followingMonth = await getMonthlyPlan('owner-1', '2026-12');

    expect(stoppedMonth.upcomingPayments).toEqual([]);
    expect(stoppedMonth.inheritedFromMonth).toBeUndefined();
    expect(followingMonth.upcomingPayments).toEqual([]);
    expect(followingMonth.inheritedFromMonth).toBe('2026-11');
  });

  it('materializes an edited inherited list in the selected month', async () => {
    seedPlan('owner-1', '2026-08', [payment('Netflix')]);
    const september = await getMonthlyPlan('owner-1', '2026-09');
    expect(september.inheritedFromMonth).toBe('2026-08');

    const edited = [payment('Netflix', 299_00), payment('Renta', 12_800_00)];
    const saved = await saveMonthlyPlan('owner-1', '2026-09', {
      currency: 'MXN',
      upcomingPayments: edited,
    });
    const october = await getMonthlyPlan('owner-1', '2026-10');

    expect(saved.upcomingPayments).toEqual(edited);
    expect(saved.inheritedFromMonth).toBeUndefined();
    expect(october.upcomingPayments).toEqual(edited);
    expect(october.inheritedFromMonth).toBe('2026-09');
    expect(items.get('USER#owner-1|MONTH#2026-08')?.payload.upcomingPayments)
      .toEqual([payment('Netflix')]);
  });
});
