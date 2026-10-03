/** David's mutable integration registry; recovery documents are not current authority. */
export const NATIVE_PUSH_SCHEMA_STATEMENT = `CREATE TABLE IF NOT EXISTS olbia.web_push_subscriptions (
  subscription_id text PRIMARY KEY CHECK (subscription_id ~ '^[a-f0-9]{64}$'),
  owner text NOT NULL CHECK (length(owner)>0),
  endpoint text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 1 AND 2048 AND endpoint ~* '^[[:space:]]*https://'),
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 256 AND p256dh ~ '^[A-Za-z0-9_-]+$'),
  auth text NOT NULL CHECK (length(auth) BETWEEN 1 AND 256 AND auth ~ '^[A-Za-z0-9_-]+$'),
  content_mode text NOT NULL CHECK (content_mode IN ('amounts','private')),
  active boolean NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`;

export const nativePushMetadataGrant = (role: string): string =>
  `GRANT SELECT (subscription_id,owner,content_mode,active,created_at,updated_at) ON olbia.web_push_subscriptions TO ${role}`;
export const nativePushReadGrant = (role: string): string => `GRANT SELECT ON olbia.web_push_subscriptions TO ${role}`;
export const nativePushWriteGrants = (role: string): readonly string[] => [
  `GRANT INSERT,DELETE ON olbia.web_push_subscriptions TO ${role}`,
  `GRANT UPDATE (p256dh,auth,content_mode,active,updated_at) ON olbia.web_push_subscriptions TO ${role}`,
];
