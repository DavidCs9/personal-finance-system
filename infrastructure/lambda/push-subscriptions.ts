import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export type PushContentMode = 'amounts' | 'private';

export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushSubscriptionRecord {
  readonly subscriptionId: string;
  readonly owner: string;
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
  readonly contentMode: PushContentMode;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class InvalidPushSubscriptionError extends Error {}

const PUSH_PARTITION = 'PUSH_SUBSCRIPTIONS';
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

export const pushSubscriptionId = (endpoint: string): string =>
  createHash('sha256').update(endpoint).digest('hex');

export const pushSubscriptionKey = (owner: string, subscriptionId: string): { readonly PK: string; readonly SK: string } => ({
  PK: `USER#${owner}`,
  SK: `PUSH#${subscriptionId}`,
});

export const parsePushSubscriptionInput = (
  rawBody: string | undefined,
  subscriptionId: string,
): { readonly endpoint: string; readonly keys: PushSubscriptionKeys; readonly contentMode: PushContentMode } => {
  if (!subscriptionId || !/^[a-f0-9]{64}$/i.test(subscriptionId)) {
    throw new InvalidPushSubscriptionError('subscriptionId must be the sha256 hex digest of the endpoint.');
  }
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    throw new InvalidPushSubscriptionError('Request body must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidPushSubscriptionError('Request body must be a JSON object.');
  }
  const body = parsed as Record<string, unknown>;
  const endpoint = requireHttpsEndpoint(body.endpoint);
  if (pushSubscriptionId(endpoint) !== subscriptionId.toLowerCase()) {
    throw new InvalidPushSubscriptionError('subscriptionId must match sha256(endpoint).');
  }
  const keys = body.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new InvalidPushSubscriptionError('keys.p256dh and keys.auth are required.');
  }
  const keyRecord = keys as Record<string, unknown>;
  const p256dh = requireKey(keyRecord.p256dh, 'keys.p256dh');
  const auth = requireKey(keyRecord.auth, 'keys.auth');
  const contentMode = parseContentMode(body.contentMode);
  return { endpoint, keys: { p256dh, auth }, contentMode };
};

export const savePushSubscription = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly owner: string;
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
  readonly contentMode: PushContentMode;
}): Promise<PushSubscriptionRecord> => {
  const subscriptionId = pushSubscriptionId(input.endpoint);
  const now = new Date().toISOString();
  const existing = await input.database.send(new GetCommand({
    TableName: input.tableName,
    Key: pushSubscriptionKey(input.owner, subscriptionId),
  }));
  const createdAt = typeof existing.Item?.createdAt === 'string' ? existing.Item.createdAt : now;
  const record: PushSubscriptionRecord = {
    subscriptionId,
    owner: input.owner,
    endpoint: input.endpoint,
    keys: input.keys,
    contentMode: input.contentMode,
    active: true,
    createdAt,
    updatedAt: now,
  };
  await input.database.send(new PutCommand({
    TableName: input.tableName,
    Item: {
      ...pushSubscriptionKey(input.owner, subscriptionId),
      GSI1PK: PUSH_PARTITION,
      GSI1SK: `${input.owner}#${subscriptionId}`,
      entityType: 'push_subscription',
      ...record,
    },
  }));
  return record;
};

export const deletePushSubscription = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly owner: string;
  readonly subscriptionId: string;
}): Promise<void> => {
  await input.database.send(new DeleteCommand({
    TableName: input.tableName,
    Key: pushSubscriptionKey(input.owner, input.subscriptionId),
  }));
};

export const listActivePushSubscriptions = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
}): Promise<readonly PushSubscriptionRecord[]> => {
  const subscriptions: PushSubscriptionRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await input.database.send(new QueryCommand({
      TableName: input.tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': PUSH_PARTITION },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) {
      if (item.active !== true) continue;
      if (typeof item.endpoint !== 'string' || typeof item.owner !== 'string') continue;
      const keys = item.keys as PushSubscriptionKeys | undefined;
      if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') continue;
      subscriptions.push({
        subscriptionId: String(item.subscriptionId ?? ''),
        owner: item.owner,
        endpoint: item.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        contentMode: item.contentMode === 'private' ? 'private' : 'amounts',
        active: true,
        createdAt: String(item.createdAt ?? ''),
        updatedAt: String(item.updatedAt ?? ''),
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return subscriptions;
};

export const listOwnerPushSubscriptions = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly owner: string;
}): Promise<readonly PushSubscriptionRecord[]> => {
  const result = await input.database.send(new QueryCommand({
    TableName: input.tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `USER#${input.owner}`,
      ':prefix': 'PUSH#',
    },
  }));
  return (result.Items ?? [])
    .filter((item) => item.active === true && typeof item.endpoint === 'string')
    .map((item) => ({
      subscriptionId: String(item.subscriptionId ?? ''),
      owner: String(item.owner ?? input.owner),
      endpoint: String(item.endpoint),
      keys: {
        p256dh: String((item.keys as PushSubscriptionKeys | undefined)?.p256dh ?? ''),
        auth: String((item.keys as PushSubscriptionKeys | undefined)?.auth ?? ''),
      },
      contentMode: item.contentMode === 'private' ? 'private' : 'amounts',
      active: true,
      createdAt: String(item.createdAt ?? ''),
      updatedAt: String(item.updatedAt ?? ''),
    }));
};

const requireHttpsEndpoint = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new InvalidPushSubscriptionError('endpoint must be an HTTPS URL.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidPushSubscriptionError('endpoint must be an HTTPS URL.');
  }
  if (url.protocol !== 'https:') {
    throw new InvalidPushSubscriptionError('endpoint must be an HTTPS URL.');
  }
  return value;
};

const requireKey = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) {
    throw new InvalidPushSubscriptionError(`${field} is required.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidPushSubscriptionError(`${field} must be base64url.`);
  }
  return value;
};

const parseContentMode = (value: unknown): PushContentMode => {
  if (value === undefined || value === null || value === 'amounts') return 'amounts';
  if (value === 'private') return 'private';
  throw new InvalidPushSubscriptionError('contentMode must be amounts or private.');
};
