import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import {
  listActivePushSubscriptions,
  pushSubscriptionKey,
  type PushSubscriptionRecord,
} from './push-subscriptions.js';

export interface ObservedPurchasePushInput {
  readonly id: string;
  readonly merchantRaw: string;
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly institution: string;
}

export interface VapidCredentials {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

export interface DeclarativePushMessage {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly navigate: string;
}

export const observedPurchasePushMessage = (
  purchase: ObservedPurchasePushInput,
  contentMode: PushSubscriptionRecord['contentMode'],
  navigateUrl: string,
): DeclarativePushMessage => {
  if (contentMode === 'private') {
    return {
      title: 'Olbia',
      body: 'Hay un movimiento nuevo.',
      tag: `observed-${purchase.id}`,
      navigate: navigateUrl,
    };
  }
  return {
    title: 'Olbia · movimiento nuevo',
    body: `${purchase.merchantRaw}: ${formatAmount(purchase.amount)}`,
    tag: `observed-${purchase.id}`,
    navigate: navigateUrl,
  };
};

export const declarativeWebPushPayload = (message: DeclarativePushMessage): string => JSON.stringify({
  web_push: 8030,
  notification: {
    title: message.title,
    body: message.body,
    navigate: message.navigate,
    lang: 'es-MX',
    silent: false,
    tag: message.tag,
  },
});

export const notifyObservedPurchasePush = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly secrets: SecretsManagerClient;
  readonly vapidSecretArn: string;
  readonly navigateUrl: string;
  readonly purchase: ObservedPurchasePushInput;
  readonly send?: typeof webpush.sendNotification;
}): Promise<{ readonly sent: number; readonly expired: number; readonly failed: number }> => {
  const subscriptions = await listActivePushSubscriptions({
    database: input.database,
    tableName: input.tableName,
  });
  if (subscriptions.length === 0) {
    return { sent: 0, expired: 0, failed: 0 };
  }
  const vapid = await loadVapidCredentials(input.secrets, input.vapidSecretArn);
  return sendPushToSubscriptions({
    database: input.database,
    tableName: input.tableName,
    vapid,
    subscriptions,
    buildMessage: (subscription) => observedPurchasePushMessage(
      input.purchase,
      subscription.contentMode,
      input.navigateUrl,
    ),
    send: input.send,
  });
};

export const sendPushToSubscriptions = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly vapid: VapidCredentials;
  readonly subscriptions: readonly PushSubscriptionRecord[];
  readonly buildMessage: (subscription: PushSubscriptionRecord) => DeclarativePushMessage;
  readonly send?: typeof webpush.sendNotification;
}): Promise<{ readonly sent: number; readonly expired: number; readonly failed: number }> => {
  webpush.setVapidDetails(input.vapid.subject, input.vapid.publicKey, input.vapid.privateKey);
  const send = input.send ?? webpush.sendNotification.bind(webpush);

  let sent = 0;
  let expired = 0;
  let failed = 0;

  for (const subscription of input.subscriptions) {
    const message = input.buildMessage(subscription);
    const payload = declarativeWebPushPayload(message);
    try {
      await send({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      }, payload, {
        TTL: 60 * 60,
        urgency: 'normal',
        topic: message.tag.slice(0, 32),
      });
      sent += 1;
    } catch (error) {
      const statusCode = pushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        await input.database.send(new DeleteCommand({
          TableName: input.tableName,
          Key: pushSubscriptionKey(subscription.owner, subscription.subscriptionId),
        }));
        expired += 1;
        console.info(JSON.stringify({
          message: 'Expired push subscription removed',
          subscriptionId: subscription.subscriptionId.slice(0, 12),
          statusCode,
        }));
        continue;
      }
      failed += 1;
      console.error(JSON.stringify({
        message: 'Unable to deliver push notification',
        subscriptionId: subscription.subscriptionId.slice(0, 12),
        statusCode,
        error: errorMessage(error),
      }));
    }
  }

  return { sent, expired, failed };
};

let cachedVapid: { readonly credentials: VapidCredentials; readonly expiresAt: number } | undefined;
let vapidPromise: Promise<VapidCredentials> | undefined;

export const loadVapidCredentials = async (
  secrets: SecretsManagerClient,
  secretArn: string,
): Promise<VapidCredentials> => {
  if (cachedVapid && cachedVapid.expiresAt > Date.now()) {
    return cachedVapid.credentials;
  }
  vapidPromise ??= secrets.send(new GetSecretValueCommand({ SecretId: secretArn })).then((result) => {
    if (!result.SecretString) throw new Error('VAPID secret did not contain a string value.');
    const parsed = JSON.parse(result.SecretString) as Partial<VapidCredentials>;
    if (
      typeof parsed.publicKey !== 'string'
      || typeof parsed.privateKey !== 'string'
      || typeof parsed.subject !== 'string'
    ) {
      throw new Error('VAPID secret is missing publicKey, privateKey, or subject.');
    }
    const credentials = {
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      subject: parsed.subject,
    };
    cachedVapid = { credentials, expiresAt: Date.now() + 5 * 60 * 1000 };
    return credentials;
  }).finally(() => {
    vapidPromise = undefined;
  });
  return vapidPromise;
};

export const formatAmount = (amount: { readonly amountMinor: number; readonly currency: string }): string => {
  const major = (amount.amountMinor / 100).toFixed(2);
  return `${major} ${amount.currency}`;
};

const pushStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
