import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  dayKeyInZone,
  FINANCE_TIME_ZONE,
  IBKR_ACCOUNT_ID,
} from '@finance/domain';
import { loadVapidCredentials, listActivePushSubscriptions, sendPushToSubscriptions } from '@finance/notify';
import {
  buildIbkrHoldings,
  fetchBanxicoUsdMxnFix,
  fetchFlexStatementXml,
  isBanxicoTokenConfigured,
  isIbkrFlexCredentialsConfigured,
  parseFlexCashBalances,
  parseFlexOpenPositions,
  type IbkrFlexCredentials,
} from './ibkr-client.js';
import { persistWealthSnapshot } from './service.js';

const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const ses = new SESClient({});

export interface IbkrSecretConfig extends IbkrFlexCredentials {
  readonly owner: string;
  readonly banxicoToken: string;
}

export interface IbkrSyncResult {
  readonly status: 'synced' | 'skipped' | 'failed';
  readonly day?: string;
  readonly totalMxnMinor?: number;
  readonly holdings?: number;
  readonly reason?: string;
}

export const loadIbkrSecret = async (secretArn: string): Promise<IbkrSecretConfig> => {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) throw new Error('IBKR secret did not contain a string value.');
  const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;
  if (!isIbkrFlexCredentialsConfigured(parsed)) {
    throw new Error('IBKR secret is missing flexToken/flexQueryId (or still pending).');
  }
  if (!isBanxicoTokenConfigured(parsed.banxicoToken)) {
    throw new Error('IBKR secret is missing banxicoToken (or still pending).');
  }
  if (typeof parsed.owner !== 'string' || !parsed.owner.trim()) {
    throw new Error('IBKR secret is missing owner (Cognito sub).');
  }
  return {
    flexToken: parsed.flexToken.trim(),
    flexQueryId: parsed.flexQueryId.trim(),
    banxicoToken: parsed.banxicoToken.trim(),
    owner: parsed.owner.trim(),
  };
};

export const syncIbkrAccount = async (input: {
  readonly owner: string;
  readonly credentials: IbkrFlexCredentials;
  readonly banxicoToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly snapshot: Awaited<ReturnType<typeof persistWealthSnapshot>>;
  readonly skipped: readonly string[];
  readonly fxRate: number;
}> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const xml = await fetchFlexStatementXml(input.credentials, { fetchImpl });
  const positions = parseFlexOpenPositions(xml);
  const cash = parseFlexCashBalances(xml);
  const { rate: fxRate, fecha: fxFecha } = await fetchBanxicoUsdMxnFix(input.banxicoToken, fetchImpl);
  const { holdings, skipped } = buildIbkrHoldings(positions, cash, fxRate);
  if ((positions.length > 0 || cash.length > 0) && holdings.length === 0) {
    throw new Error(
      `IBKR Flex returned positions/cash but none could be valued in MXN (skipped: ${skipped.join(', ') || 'none'}).`,
    );
  }
  const capturedAt = new Date().toISOString();
  const day = dayKeyInZone(new Date(capturedAt), FINANCE_TIME_ZONE);
  const evidenceBody = JSON.stringify({
    kind: 'wealth_ibkr_snapshot',
    createdAt: capturedAt,
    owner: input.owner,
    accountId: IBKR_ACCOUNT_ID,
    day,
    fxRate,
    fxFecha,
    fxSource: 'banxico_sf43718',
    positions,
    cash,
    skipped,
    holdings,
    flexXml: xml,
  });
  const snapshot = await persistWealthSnapshot({
    owner: input.owner,
    accountId: IBKR_ACCOUNT_ID,
    source: 'flex',
    holdings,
    evidenceKind: 'api',
    evidenceBody,
    fxSource: 'banxico_sf43718',
    fxRate,
  });
  return { snapshot, skipped, fxRate };
};

const configuredAlertAddresses = (): { readonly source: string; readonly destination: string } | undefined => {
  const source = process.env.ALERT_SENDER_EMAIL?.trim();
  const destination = process.env.ALERT_RECIPIENT_EMAIL?.trim();
  if (!source || !destination) return undefined;
  return { source, destination };
};

export const notifyIbkrSyncFailure = async (error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : 'Unknown IBKR sync failure.';
  const day = dayKeyInZone(new Date(), FINANCE_TIME_ZONE);
  const addresses = configuredAlertAddresses();
  if (addresses) {
    await ses.send(new SendEmailCommand({
      Source: addresses.source,
      Destination: { ToAddresses: [addresses.destination] },
      Message: {
        Subject: { Data: `Olbia: falló el sync de IBKR (${day})` },
        Body: {
          Text: {
            Data: [
              'El sync diario/manual de IBKR Flex falló.',
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
      title: 'IBKR no sincronizó',
      body: 'Falló el sync de hoy. Se mantiene el último saldo bueno.',
      tag: `ibkr-sync-fail-${day}`,
      navigate: webAppUrl.endsWith('/') ? webAppUrl : `${webAppUrl}/`,
    }),
  });
};

export const loadIbkrCredentials = async (secretArn: string): Promise<{
  readonly credentials: IbkrFlexCredentials;
  readonly banxicoToken: string;
}> => {
  const config = await loadIbkrSecret(secretArn);
  return {
    credentials: { flexToken: config.flexToken, flexQueryId: config.flexQueryId },
    banxicoToken: config.banxicoToken,
  };
};

type JsonObjectLike = Record<string, unknown>;

export const syncIbkrForOwner = async (owner: string): Promise<JsonObjectLike> => {
  const secretArn = process.env.IBKR_SECRET_ARN ?? '';
  if (!secretArn) throw new Error('IBKR_SECRET_ARN is not configured.');
  const { credentials, banxicoToken } = await loadIbkrCredentials(secretArn);
  const { snapshot, skipped, fxRate } = await syncIbkrAccount({ owner, credentials, banxicoToken });
  return { snapshot, skipped, fxRate };
};

export const runIbkrSyncJob = async (): Promise<IbkrSyncResult> => {
  const secretArn = process.env.IBKR_SECRET_ARN ?? '';
  if (!secretArn) {
    return { status: 'skipped', reason: 'IBKR_SECRET_ARN is not configured.' };
  }
  try {
    const raw = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!raw.SecretString) {
      return { status: 'skipped', reason: 'IBKR secret did not contain a string value.' };
    }
    const parsed = JSON.parse(raw.SecretString) as Record<string, unknown>;
    if (!isIbkrFlexCredentialsConfigured(parsed)) {
      return { status: 'skipped', reason: 'IBKR Flex credentials still pending.' };
    }
    if (!isBanxicoTokenConfigured(parsed.banxicoToken)) {
      return { status: 'skipped', reason: 'Banxico token still pending.' };
    }
    if (typeof parsed.owner !== 'string' || !parsed.owner.trim() || parsed.owner.trim() === 'pending') {
      return { status: 'skipped', reason: 'IBKR owner (Cognito sub) still pending.' };
    }
    const config: IbkrSecretConfig = {
      flexToken: parsed.flexToken.trim(),
      flexQueryId: parsed.flexQueryId.trim(),
      banxicoToken: parsed.banxicoToken.trim(),
      owner: parsed.owner.trim(),
    };
    const { snapshot, skipped, fxRate } = await syncIbkrAccount({
      owner: config.owner,
      credentials: config,
      banxicoToken: config.banxicoToken,
    });
    console.info(JSON.stringify({
      message: 'IBKR wealth sync completed',
      day: snapshot.day,
      totalMxnMinor: snapshot.totalMxnMinor,
      holdings: snapshot.holdings.length,
      fxRate,
      skipped,
    }));
    return {
      status: 'synced',
      day: snapshot.day,
      totalMxnMinor: snapshot.totalMxnMinor,
      holdings: snapshot.holdings.length,
      ...(skipped.length ? { reason: `Skipped non-USD rows: ${skipped.join(', ')}` } : {}),
    };
  } catch (error) {
    console.error(JSON.stringify({
      message: 'IBKR wealth sync failed',
      error: error instanceof Error ? error.message : 'unknown',
    }));
    await notifyIbkrSyncFailure(error).catch((notifyError) => {
      console.error(JSON.stringify({
        message: 'IBKR sync failure notification also failed',
        error: notifyError instanceof Error ? notifyError.message : 'unknown',
      }));
    });
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'Unknown IBKR sync failure.',
    };
  }
};

export const handler = async (): Promise<IbkrSyncResult> => runIbkrSyncJob();
