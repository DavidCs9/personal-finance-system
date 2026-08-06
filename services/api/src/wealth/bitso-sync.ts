import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BITSO_ACCOUNT_ID,
  dayKeyInZone,
  FINANCE_TIME_ZONE,
} from '@finance/domain';
import { loadVapidCredentials, listActivePushSubscriptions, sendPushToSubscriptions } from '@finance/notify';
import {
  buildBitsoHoldings,
  fetchBitsoBalances,
  isBitsoCredentialsConfigured,
  type BitsoCredentials,
} from './bitso-client.js';
import { persistWealthSnapshot } from './service.js';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const ses = new SESClient({});

export interface BitsoSecretConfig extends BitsoCredentials {
  readonly owner: string;
}

export interface BitsoSyncResult {
  readonly status: 'synced' | 'skipped' | 'failed';
  readonly day?: string;
  readonly totalMxnMinor?: number;
  readonly holdings?: number;
  readonly reason?: string;
}

export const loadBitsoSecret = async (secretArn: string): Promise<BitsoSecretConfig> => {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) throw new Error('Bitso secret did not contain a string value.');
  const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;
  if (!isBitsoCredentialsConfigured(parsed)) {
    throw new Error('Bitso secret is missing apiKey/apiSecret (or still pending).');
  }
  if (typeof parsed.owner !== 'string' || !parsed.owner.trim()) {
    throw new Error('Bitso secret is missing owner (Cognito sub).');
  }
  return {
    apiKey: parsed.apiKey.trim(),
    apiSecret: parsed.apiSecret.trim(),
    owner: parsed.owner.trim(),
  };
};

export const syncBitsoAccount = async (input: {
  readonly owner: string;
  readonly credentials: BitsoCredentials;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly snapshot: Awaited<ReturnType<typeof persistWealthSnapshot>>;
  readonly skipped: readonly string[];
}> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const balances = await fetchBitsoBalances(input.credentials, fetchImpl);
  const { holdings, rates, skipped } = await buildBitsoHoldings(balances, fetchImpl);
  const positiveBalances = balances.filter((balance) => balance.total > 0);
  if (positiveBalances.length > 0 && holdings.length === 0) {
    throw new Error(
      `Bitso returned balances but none could be valued in MXN (skipped: ${skipped.join(', ') || 'none'}).`,
    );
  }
  const capturedAt = new Date().toISOString();
  const day = dayKeyInZone(new Date(capturedAt), FINANCE_TIME_ZONE);
  const evidenceBody = JSON.stringify({
    kind: 'wealth_bitso_snapshot',
    createdAt: capturedAt,
    owner: input.owner,
    accountId: BITSO_ACCOUNT_ID,
    day,
    balances,
    rates,
    skipped,
    holdings,
    fxSource: 'bitso_ticker',
  });
  const snapshot = await persistWealthSnapshot({
    owner: input.owner,
    accountId: BITSO_ACCOUNT_ID,
    source: 'api',
    holdings,
    evidenceKind: 'api',
    evidenceBody,
    fxSource: 'bitso_ticker',
  });
  return { snapshot, skipped };
};

const configuredAlertAddresses = (): { readonly source: string; readonly destination: string } | undefined => {
  const source = process.env.ALERT_SENDER_EMAIL?.trim();
  const destination = process.env.ALERT_RECIPIENT_EMAIL?.trim();
  if (!source || !destination) return undefined;
  return { source, destination };
};

export const notifyBitsoSyncFailure = async (error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : 'Unknown Bitso sync failure.';
  const day = dayKeyInZone(new Date(), FINANCE_TIME_ZONE);
  const addresses = configuredAlertAddresses();
  if (addresses) {
    await ses.send(new SendEmailCommand({
      Source: addresses.source,
      Destination: { ToAddresses: [addresses.destination] },
      Message: {
        Subject: { Data: `Olbia: falló el sync de Bitso (${day})` },
        Body: {
          Text: {
            Data: [
              'El sync diario/manual de Bitso falló.',
              '',
              `Día: ${day}`,
              `Error: ${message}`,
              '',
              'Se conserva el último snapshot bueno en Patrimonio.',
            ].join('\n'),
          },
        },
      },
    }));
  }

  const tableName = process.env.METADATA_TABLE_NAME ?? '';
  const vapidSecretArn = process.env.VAPID_SECRET_ARN ?? '';
  const webAppUrl = process.env.WEB_APP_URL ?? '';
  if (!tableName || !vapidSecretArn || !webAppUrl) return;

  const subscriptions = await listActivePushSubscriptions({ database, tableName });
  if (subscriptions.length === 0) return;
  const vapid = await loadVapidCredentials(secrets, vapidSecretArn);
  await sendPushToSubscriptions({
    database,
    tableName,
    vapid,
    subscriptions,
    buildMessage: () => ({
      title: 'Bitso no sincronizó',
      body: 'Falló el sync de hoy. Se mantiene el último saldo bueno.',
      tag: `bitso-sync-fail-${day}`,
      navigate: webAppUrl.endsWith('/') ? webAppUrl : `${webAppUrl}/`,
    }),
  });
};

export const loadBitsoCredentials = async (secretArn: string): Promise<BitsoCredentials> => {
  const config = await loadBitsoSecret(secretArn);
  return { apiKey: config.apiKey, apiSecret: config.apiSecret };
};

export const syncBitsoForOwner = async (owner: string): Promise<JsonObjectLike> => {
  const secretArn = process.env.BITSO_SECRET_ARN ?? '';
  if (!secretArn) throw new Error('BITSO_SECRET_ARN is not configured.');
  const credentials = await loadBitsoCredentials(secretArn);
  const { snapshot, skipped } = await syncBitsoAccount({ owner, credentials });
  return {
    snapshot,
    skipped,
  };
};

type JsonObjectLike = Record<string, unknown>;

export const runBitsoSyncJob = async (): Promise<BitsoSyncResult> => {
  const secretArn = process.env.BITSO_SECRET_ARN ?? '';
  if (!secretArn) {
    return { status: 'skipped', reason: 'BITSO_SECRET_ARN is not configured.' };
  }
  try {
    const raw = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!raw.SecretString) {
      return { status: 'skipped', reason: 'Bitso secret did not contain a string value.' };
    }
    const parsed = JSON.parse(raw.SecretString) as Record<string, unknown>;
    if (!isBitsoCredentialsConfigured(parsed)) {
      return { status: 'skipped', reason: 'Bitso credentials still pending.' };
    }
    if (typeof parsed.owner !== 'string' || !parsed.owner.trim() || parsed.owner.trim() === 'pending') {
      return { status: 'skipped', reason: 'Bitso owner (Cognito sub) still pending.' };
    }
    const config: BitsoSecretConfig = {
      apiKey: parsed.apiKey.trim(),
      apiSecret: parsed.apiSecret.trim(),
      owner: parsed.owner.trim(),
    };
    const { snapshot, skipped } = await syncBitsoAccount({
      owner: config.owner,
      credentials: config,
    });
    console.info(JSON.stringify({
      message: 'Bitso wealth sync completed',
      day: snapshot.day,
      totalMxnMinor: snapshot.totalMxnMinor,
      holdings: snapshot.holdings.length,
      skipped,
    }));
    return {
      status: 'synced',
      day: snapshot.day,
      totalMxnMinor: snapshot.totalMxnMinor,
      holdings: snapshot.holdings.length,
      ...(skipped.length ? { reason: `Skipped currencies without MXN ticker: ${skipped.join(', ')}` } : {}),
    };
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Bitso wealth sync failed',
      error: error instanceof Error ? error.message : 'unknown',
    }));
    await notifyBitsoSyncFailure(error).catch((notifyError) => {
      console.error(JSON.stringify({
        message: 'Bitso sync failure notification also failed',
        error: notifyError instanceof Error ? notifyError.message : 'unknown',
      }));
    });
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'Unknown Bitso sync failure.',
    };
  }
};

export const handler = async (): Promise<BitsoSyncResult> => runBitsoSyncJob();
