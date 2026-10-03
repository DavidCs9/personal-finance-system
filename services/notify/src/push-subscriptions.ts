import { applicationSqlClient, withSqlTransaction } from '@finance/ledger/sql-runtime';
import { InvalidPushSubscriptionError, pushSubscriptionId, validatePushSubscription, upsertNativePushSubscription, deleteNativePushSubscription,
  readNativePushSubscriptions, type NativePushSubscription, type PushSubscriptionKeys, type PushContentMode } from '@finance/ledger/native-push';
export { InvalidPushSubscriptionError, pushSubscriptionId };
export type { PushSubscriptionKeys, PushContentMode };
export type PushSubscriptionRecord = NativePushSubscription;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

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
  readonly owner: string; readonly endpoint: string; readonly keys: PushSubscriptionKeys; readonly contentMode: PushContentMode;
}): Promise<PushSubscriptionRecord> => {
  validatePushSubscription(input);
  const at = new Date().toISOString();
  return withSqlTransaction(client => upsertNativePushSubscription(client, {...input, at}));
};
export const deletePushSubscription = (input: {readonly owner: string; readonly subscriptionId: string}): Promise<void> =>
  withSqlTransaction(client => deleteNativePushSubscription(client, input.owner, input.subscriptionId));
const nativeSubscriptions = async (owner?: string): Promise<readonly PushSubscriptionRecord[]> => {
  try { return await readNativePushSubscriptions(applicationSqlClient(), owner); }
  catch { throw Object.assign(new Error('Olbia storage is unavailable.'), {name:'StorageUnavailableException'}); }
};
export const listActivePushSubscriptions = (): Promise<readonly PushSubscriptionRecord[]> => nativeSubscriptions();
export const listOwnerPushSubscriptions = (input: {readonly owner: string}): Promise<readonly PushSubscriptionRecord[]> => nativeSubscriptions(input.owner);

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
