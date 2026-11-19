import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { sendPushToSubscriptions } from '@finance/notify';
import { claimBudgetPushAlerts, finishBudgetPushAlerts, upsertNativePushSubscription } from '@finance/ledger/native-push';
import { NATIVE_FINANCIAL_PLAN_SCHEMA_STATEMENTS, NATIVE_FINANCIAL_PLAN_TABLES } from '../../ledger/src/dsql/financial-plan-schema.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { nativeFixture } from './fixtures/native-ledger.js';

const harness = vi.hoisted(() => ({
  pool: undefined as unknown as SqlClient & TransactionPool,
  send: vi.fn<typeof sendPushToSubscriptions>(),
}));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
vi.mock('../src/http/clients.js', () => ({ rawSourceBucketName: 'test-evidence', s3: { send: vi.fn() } }));
vi.mock('@finance/notify', async importOriginal => ({
  ...await importOriginal<typeof import('@finance/notify')>(), sendPushToSubscriptions: harness.send,
}));
const { runBudgetPush } = await import('../src/push/budget-push.js');
const { applyFinancialChange, previewFinancialChange } = await import('../src/financial-plans/service.js');

const owner = 'owner';
const month = '2030-04';
const now = new Date('2030-04-12T18:00:00Z');
const navigate = 'https://finance.example.test/';
const loadVapid = vi.fn(async () => ({ publicKey: 'fake', privateKey: 'fake', subject: 'mailto:push@example.test' }));
const sendResult = { sent: 1, expired: 0, failed: 0 };
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
const evaluate = () => runBudgetPush(owner, new Date(), navigate, loadVapid);
const subscribe = (device: string, contentMode: 'amounts' | 'private' = 'amounts') =>
  upsertNativePushSubscription(fixture.sql, {
    owner, endpoint: `https://push.example.test/${device}`, keys: { p256dh: 'test_key', auth: 'test_auth' },
    contentMode, at: new Date().toISOString(),
  });

beforeAll(async () => {
  fixture = await nativeFixture();
  for (const statement of NATIVE_FINANCIAL_PLAN_SCHEMA_STATEMENTS) await fixture.sql.query(statement);
  await fixture.sql.query("INSERT INTO olbia.spend_categories VALUES ('food','Despensa',0) ON CONFLICT DO NOTHING");
  harness.pool = fixture.pool;
}, 30_000);
afterAll(() => fixture.sql.close());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await fixture.reset([...NATIVE_FINANCIAL_PLAN_TABLES, 'budget_push_alerts', 'web_push_subscriptions']);
  harness.send.mockReset().mockResolvedValue(sendResult);
  loadVapid.mockClear();
});
afterEach(() => vi.useRealTimers());

it('groups scopes, retries a failed delivery, and only advances when higher levels are reached', async () => {
  expect(await evaluate()).toMatchObject({ subscriptions: 0, sent: 0 });
  const phone = await subscribe('phone');
  const preview = await previewFinancialChange(owner, 'budget', {
    action: 'set_recurring', month, totalMxnMinor: 10000, allocations: [{ categoryId: 'food', amountMxnMinor: 8000 }],
  });
  await applyFinancialChange(owner, preview.operationId, 'budget');
  expect(await evaluate()).toMatchObject({ subscriptions: 1, sent: 0 });
  expect(loadVapid).not.toHaveBeenCalled();

  const movement = { categoryId: 'food', occurredAt: now.toISOString() };
  await fixture.create({ ...movement, amount: { amountMinor: 7500, currency: 'MXN' } });
  harness.send.mockResolvedValueOnce({ ...sendResult, sent: 0, failed: 1 });
  expect(await evaluate()).toMatchObject({ failed: 1, sent: 0 });
  expect(await evaluate()).toMatchObject({ failed: 0, sent: 1 });
  expect(harness.send.mock.lastCall?.[0].buildMessage(phone)).toMatchObject({
    body: 'Despensa alcanzó el 90%. Presupuesto mensual alcanzó el 70%.', navigate,
  });
  expect(await evaluate()).toMatchObject({ sent: 0 });
  expect(harness.send).toHaveBeenCalledTimes(2);

  const tablet = await subscribe('tablet', 'private');
  expect(await evaluate()).toMatchObject({ subscriptions: 2, sent: 1 });
  expect(harness.send.mock.lastCall?.[0].buildMessage(tablet).body).toBe('Hay avisos de presupuesto en tu Resumen.');

  await fixture.create({ ...movement, amount: { amountMinor: 1700, currency: 'MXN' } });
  expect(await evaluate()).toMatchObject({ subscriptions: 2, sent: 2 });
  expect(await evaluate()).toMatchObject({ sent: 0 });
  expect((await fixture.sql.query('SELECT delivered_threshold FROM olbia.budget_push_alerts WHERE scope=$1',
    ['category:food'])).rows).toEqual([{ delivered_threshold: 100 }, { delivered_threshold: 100 }]);
});

it('isolates leases by device and month, and rejects stale acknowledgments and preferences', async () => {
  const phone = await subscribe('phone');
  const candidates = [{ scope: 'total', threshold: 90 as const }];
  const first = randomUUID(), next = randomUUID();
  const claim = (period: string, id: string, at: Date, subscription = phone) =>
    claimBudgetPushAlerts(fixture.sql, subscription, period, id, at, candidates);
  expect(await claim(month, first, now)).toEqual(new Set(['total']));
  expect(await claim(month, next, now)).toEqual(new Set());
  const expiry = new Date(now.getTime() + 3 * 60_000);
  expect(await claim(month, next, expiry)).toEqual(new Set(['total']));
  await finishBudgetPushAlerts(fixture.sql, phone, month, first, true);
  await finishBudgetPushAlerts(fixture.sql, phone, month, next, false);
  expect(await claim(month, first, expiry)).toEqual(new Set(['total']));
  await finishBudgetPushAlerts(fixture.sql, phone, month, first, true);
  expect(await claim(month, next, expiry)).toEqual(new Set());

  vi.setSystemTime(expiry);
  const renewed = await subscribe('phone', 'private');
  expect(await claim('2030-05', first, expiry)).toEqual(new Set());
  expect(await claim('2030-05', first, expiry, renewed)).toEqual(new Set(['total']));
});
