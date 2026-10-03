import { afterEach, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { savePushSubscription, deletePushSubscription, listActivePushSubscriptions, listOwnerPushSubscriptions, pushSubscriptionId } from '../src/push-subscriptions.js';
import { notifyObservedPurchasePush, sendPushToSubscriptions } from '../src/push-notify.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const endpoint = 'https://push.example.test/subscription';
const record = { subscriptionId: pushSubscriptionId(endpoint), owner: 'owner', endpoint, keys: {p256dh:'example_key',auth:'example_auth'},
  contentMode: 'private' as const, active: true, createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' };
const purchase = {id:'observed-test',merchantRaw:'Test',amount:{amountMinor:100,currency:'MXN'},institution:'santander_mx'};

it('preserves registration, owner/active listing and expired cleanup before activation', async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true');
  const send = vi.fn(async (command: unknown) => command instanceof GetCommand ? {Item:record} : {Items:[record]});
  const database = {send} as unknown as DynamoDBDocumentClient;
  const sql = { query: vi.fn(async () => ({rows:[]})) };
  await withStoreClient(sql, async () => {
    const saved = await savePushSubscription({database,tableName:'metadata',...record});
    expect(saved.createdAt).toBe(record.createdAt); expect(saved.contentMode).toBe('private');
    expect(send.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(true);
    expect(await listActivePushSubscriptions({database,tableName:'metadata'})).toEqual([record]);
    expect(await listOwnerPushSubscriptions({database,tableName:'metadata',owner:'owner'})).toEqual([record]);
    const keys = webpush.generateVAPIDKeys();
    const transport = vi.fn(async () => { throw {statusCode:410}; });
    expect(await sendPushToSubscriptions({database,tableName:'metadata',vapid:{...keys,subject:'mailto:test@example.test'},subscriptions:[record],
      buildMessage:()=>({title:'Olbia',body:'Test',tag:'test',navigate:'https://example.test'}),send:transport as never})).toEqual({sent:0,expired:1,failed:0});
    expect(send.mock.calls.some(([command]) => command instanceof DeleteCommand)).toBe(true);
  });
});

it('blocks every old registry and delivery entry point before document, secrets or transport IO after activation', async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true');
  const send = vi.fn(), secrets = {send:vi.fn()}, transport = vi.fn(), buildMessage = vi.fn();
  const database = {send} as unknown as DynamoDBDocumentClient;
  const sql = {query:vi.fn(async () => ({rows:[{version:16}]}))};
  await withStoreClient(sql, async () => {
    for (const action of [
      () => savePushSubscription({database,tableName:'metadata',...record}),
      () => deletePushSubscription({database,tableName:'metadata',owner:'owner',subscriptionId:record.subscriptionId}),
      () => listActivePushSubscriptions({database,tableName:'metadata'}),
      () => listOwnerPushSubscriptions({database,tableName:'metadata',owner:'owner'}),
      () => notifyObservedPurchasePush({database,tableName:'metadata',secrets:secrets as never,vapidSecretArn:'test',navigateUrl:'https://example.test',purchase,send:transport as never}),
      () => sendPushToSubscriptions({database,tableName:'metadata',vapid:{publicKey:'unused',privateKey:'unused',subject:'unused'},subscriptions:[record],buildMessage,send:transport as never}),
    ]) await expect(action()).rejects.toMatchObject({name:'MigrationPausedException'});
  });
  expect(send).not.toHaveBeenCalled(); expect(secrets.send).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect(buildMessage).not.toHaveBeenCalled();
});

it('fails closed and sanitizes driver errors without trying stale subscription data', async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true'); const send=vi.fn();
  const sql={query:vi.fn(async()=>{throw Object.assign(new Error('private endpoint/key'),{code:'08006'});})};
  await expect(withStoreClient(sql,()=>listActivePushSubscriptions({database:{send} as never,tableName:'metadata'})))
    .rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
  expect(send).not.toHaveBeenCalled();
});
