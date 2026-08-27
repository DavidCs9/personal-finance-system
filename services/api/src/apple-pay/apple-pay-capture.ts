import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { InvalidApplePayCaptureError, parseApplePayCapture } from './apple-pay-input.js';
import { saveObservedEvent } from '@finance/ledger';
import { notifyObservedPurchasePush } from '@finance/notify';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secrets = new SecretsManagerClient({});
const tableName = requiredEnvironment('METADATA_TABLE_NAME');
const secretArn = requiredEnvironment('APPLE_PAY_CAPTURE_SECRET_ARN');
let cachedCaptureToken: { readonly token: string; readonly expiresAt: number } | undefined;
let captureTokenPromise: Promise<string> | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (event.requestContext.http.method !== 'POST') return response(405, { message: 'Method not allowed.' });
    const authorised = await hasValidToken(header(event.headers, 'authorization'));
    if (!authorised) return response(401, { message: 'Invalid capture credentials.' });
    const rawBody = event.body
      ? event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
      : undefined;
    const input = parseApplePayCapture(rawBody, header(event.headers, 'idempotency-key'));
    const now = new Date().toISOString();
    const eventId = randomUUID();
    const cardKey = createHash('sha256').update(input.cardRaw.trim().toLowerCase()).digest('hex').slice(0, 16);
    const purchase = {
      id: eventId,
      institution: input.institution,
      eventType: 'card_purchase' as const,
      // A foreign Apple Pay amount is an authorization, not the posted MXN bank charge.
      // It remains visible but excluded from spend until Santander email supplies the gross MXN amount.
      status: input.currency === 'USD' ? 'pending_foreign' as const : 'accepted' as const,
      account: {
        institution: input.institution,
        accountId: `${input.institution}:apple-pay:${cardKey}`,
        displayName: input.cardRaw,
      },
      amount: { amountMinor: input.amountMinor, currency: input.currency },
      merchantRaw: input.merchantRaw,
      occurredAt: input.occurredAt,
      receivedAt: now,
      ingestedAt: now,
      source: {
        kind: 'apple_pay_shortcut' as const,
        requestId: input.requestId,
        cardRaw: input.cardRaw,
        nameRaw: input.nameRaw,
        amountRaw: input.amountRaw,
        currency: input.currency,
      },
      parserVersion: 'apple-pay-shortcut-v2',
      parseWarnings: [] as string[],
    };
    const saved = await saveObservedEvent({
      database,
      tableName,
      dedupeKey: `apple_pay_shortcut:${input.requestId}`,
      captureSource: 'apple_pay_shortcut',
      reconciliationAt: input.occurredAt,
      event: purchase,
    });
    if (saved.created) {
      try {
        await notifyApplePayPush({
          id: saved.eventId,
          merchantRaw: purchase.merchantRaw,
          amount: purchase.amount,
          institution: purchase.institution,
        });
      } catch (error) {
        console.error(JSON.stringify({
          message: 'Unable to send Apple Pay observed-purchase push',
          eventId: saved.eventId,
          error: errorMessage(error),
        }));
      }
    }
    return response(saved.duplicate ? 200 : 201, {
      accepted: true,
      eventId: saved.eventId,
      observationId: saved.observationId,
      duplicate: saved.duplicate,
      reconciled: saved.reconciled,
    });
  } catch (error) {
    if (error instanceof InvalidApplePayCaptureError) return response(400, { message: error.message });
    console.error('Apple Pay capture failed', { error: errorMessage(error) });
    return response(500, { message: 'Unable to save Apple Pay capture.' });
  }
};

const notifyApplePayPush = async (purchase: {
  readonly id: string;
  readonly merchantRaw: string;
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly institution: string;
}): Promise<void> => {
  const vapidSecretArn = process.env.VAPID_SECRET_ARN;
  const navigateUrl = process.env.WEB_APP_URL;
  if (!vapidSecretArn || !navigateUrl) {
    console.info(JSON.stringify({ message: 'Apple Pay push skipped until VAPID secret and web app URL are configured.' }));
    return;
  }
  const result = await notifyObservedPurchasePush({
    database,
    tableName,
    secrets,
    vapidSecretArn,
    navigateUrl,
    purchase,
  });
  console.info(JSON.stringify({
    message: 'Apple Pay observed-purchase push finished',
    eventId: purchase.id,
    sent: result.sent,
    expired: result.expired,
    failed: result.failed,
  }));
};

const captureToken = (): Promise<string> => {
  if (cachedCaptureToken && cachedCaptureToken.expiresAt > Date.now()) {
    return Promise.resolve(cachedCaptureToken.token);
  }
  captureTokenPromise ??= secrets.send(new GetSecretValueCommand({ SecretId: secretArn })).then((result) => {
    if (!result.SecretString) throw new Error('Apple Pay capture secret did not contain a string value.');
    const parsed = JSON.parse(result.SecretString) as { token?: unknown };
    if (typeof parsed.token !== 'string' || parsed.token.length < 32) throw new Error('Apple Pay capture token is invalid.');
    cachedCaptureToken = { token: parsed.token, expiresAt: Date.now() + 5 * 60 * 1000 };
    return parsed.token;
  }).finally(() => {
    captureTokenPromise = undefined;
  });
  return captureTokenPromise;
};

const hasValidToken = async (authorization: string | undefined): Promise<boolean> => {
  const supplied = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (!supplied) return false;
  const expected = await captureToken();
  return safeTokenEqual(supplied, expected);
};

const safeTokenEqual = (supplied: string, expected: string): boolean => {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
};

const header = (headers: Readonly<Record<string, string | undefined>> | undefined, name: string): string | undefined => {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
};

const response = (statusCode: number, body: Readonly<Record<string, unknown>>) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
