import { generateKeyPairSync } from 'node:crypto';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});

interface VapidSecretValue {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

interface ProviderEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResourceProperties: {
    readonly SecretArn?: string;
    readonly Subject?: string;
  };
  readonly PhysicalResourceId?: string;
}

/**
 * Ensures a durable VAPID key pair exists for Web Push.
 * Reuses existing keys on update so rotations stay intentional.
 */
export const handler = async (event: ProviderEvent): Promise<{
  readonly PhysicalResourceId: string;
  readonly Data: { readonly PublicKey: string };
}> => {
  const secretArn = String(event.ResourceProperties.SecretArn ?? '');
  const subject = String(event.ResourceProperties.Subject ?? 'mailto:alerts@finance.castrodavid.dev');
  const physicalId = event.PhysicalResourceId ?? `vapid-${secretArn}`;
  if (!secretArn) throw new Error('SecretArn is required.');

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalId, Data: { PublicKey: '' } };
  }

  const existing = await readSecret(secretArn);
  const credentials = isUsable(existing) ? existing : generateVapidKeys(subject);
  if (!isUsable(existing)) {
    await secrets.send(new PutSecretValueCommand({
      SecretId: secretArn,
      SecretString: JSON.stringify(credentials),
    }));
  }

  return {
    PhysicalResourceId: physicalId,
    Data: { PublicKey: credentials.publicKey },
  };
};

const readSecret = async (secretArn: string): Promise<Partial<VapidSecretValue> | undefined> => {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) return undefined;
  return JSON.parse(result.SecretString) as Partial<VapidSecretValue>;
};

const isUsable = (value: Partial<VapidSecretValue> | undefined): value is VapidSecretValue =>
  !!value
  && typeof value.publicKey === 'string'
  && typeof value.privateKey === 'string'
  && typeof value.subject === 'string'
  && value.publicKey.length > 20
  && value.privateKey.length > 20
  && value.publicKey !== 'pending'
  && value.privateKey !== 'pending';

export const generateVapidKeys = (subject: string): VapidSecretValue => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicRaw = publicKey.export({ format: 'jwk' });
  const privateRaw = privateKey.export({ format: 'jwk' });
  if (!publicRaw.x || !publicRaw.y || !privateRaw.d) {
    throw new Error('Unable to export VAPID key material.');
  }
  const x = Buffer.from(publicRaw.x, 'base64url');
  const y = Buffer.from(publicRaw.y, 'base64url');
  const d = Buffer.from(privateRaw.d, 'base64url');
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  return {
    publicKey: uncompressed.toString('base64url'),
    privateKey: d.toString('base64url'),
    subject,
  };
};
