import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CAJITA_ACCOUNT_ID,
  cajitaEmergencyHolding,
  dayKeyInZone,
  FINANCE_TIME_ZONE,
  FONDO_AHORRO_ACCOUNT_ID,
  fondoAhorroHolding,
  isWealthAccountId,
  liabilitiesAsOfDay,
  netWorthMxnMinor,
  runningFondoAhorroByDay,
  sumFondoAhorroDeduccionesMinor,
  WEALTH_ACCOUNTS,
  wealthTotalMonthlyHistory,
  type CardLiabilitySnapshot,
  type WealthAccountId,
  type WealthHolding,
  type WealthSnapshot,
  type WealthSnapshotSource,
} from '@finance/domain';
import { isValidCardId, listCards } from '../cards/cards.js';
import { database, rawSourceBucketName, s3, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { listPayslipsForYear } from '../imports/cfdi-nomina-flow.js';
import { InvalidWealthSnapshotError, parseCajitaSnapshot, parseCardLiabilitySnapshot } from './input.js';
import {
  liabilitySnapshotKey,
  liabilitySnapshotSkPrefix,
  liabilitySnapshotVersionKey,
  seededWealthAccounts,
  wealthSnapshotKey,
  wealthSnapshotSkPrefix,
  wealthSnapshotVersionKey,
} from './keys.js';

const evidenceObjectKey = (kind: 'manual' | 'api', owner: string, sha256: string): string =>
  kind === 'manual' ? `wealth-manual/${owner}/${sha256}.json` : `wealth-api/${owner}/${sha256}.json`;

const toPublicSnapshot = (item: Record<string, unknown>): WealthSnapshot | undefined => {
  const accountId = item.accountId;
  if (typeof accountId !== 'string' || !isWealthAccountId(accountId)) return undefined;
  if (accountId === FONDO_AHORRO_ACCOUNT_ID) return undefined;
  if (typeof item.day !== 'string' || typeof item.capturedAt !== 'string') return undefined;
  if (typeof item.totalMxnMinor !== 'number' || !Array.isArray(item.holdings)) return undefined;
  const source = item.source;
  if (source !== 'manual' && source !== 'api' && source !== 'flex') return undefined;
  return {
    accountId,
    day: item.day,
    capturedAt: item.capturedAt,
    source,
    currency: 'MXN',
    totalMxnMinor: item.totalMxnMinor,
    holdings: item.holdings as WealthSnapshot['holdings'],
    ...(item.evidence && typeof item.evidence === 'object'
      ? { evidence: item.evidence as WealthSnapshot['evidence'] }
      : {}),
    ...(typeof item.fxRate === 'number' ? { fxRate: item.fxRate } : {}),
    ...(typeof item.fxSource === 'string' ? { fxSource: item.fxSource } : {}),
  };
};

const listCanonicalSnapshots = async (owner: string): Promise<readonly WealthSnapshot[]> => {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${owner}`,
        ':sk': wealthSnapshotSkPrefix,
      },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    for (const item of page.Items ?? []) {
      items.push(item as Record<string, unknown>);
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return items
    .map((item) => toPublicSnapshot(item))
    .filter((snapshot): snapshot is WealthSnapshot => Boolean(snapshot))
    .sort((left, right) => left.day.localeCompare(right.day) || left.accountId.localeCompare(right.accountId));
};

/**
 * Canonical daily snapshots for a connected account. Used by read-only agent
 * queries that compare a holding's value over time; evidence itself remains
 * private in S3 and is not returned here.
 */
export const listWealthSnapshotsForAccount = async (
  owner: string,
  accountId: WealthAccountId,
): Promise<readonly WealthSnapshot[]> =>
  (await listCanonicalSnapshots(owner)).filter((snapshot) => snapshot.accountId === accountId);

const latestByAccount = (
  snapshots: readonly WealthSnapshot[],
): ReadonlyMap<WealthAccountId, WealthSnapshot> => {
  const latest = new Map<WealthAccountId, WealthSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.accountId);
    if (!current || snapshot.day > current.day || (snapshot.day === current.day && snapshot.capturedAt > current.capturedAt)) {
      latest.set(snapshot.accountId, snapshot);
    }
  }
  return latest;
};

const historyPoints = (
  snapshots: readonly WealthSnapshot[],
  accountId: WealthAccountId | 'all',
): readonly { readonly day: string; readonly totalMxnMinor: number }[] => {
  const byDay = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (accountId !== 'all' && snapshot.accountId !== accountId) continue;
    byDay.set(snapshot.day, (byDay.get(snapshot.day) ?? 0) + snapshot.totalMxnMinor);
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, totalMxnMinor]) => ({ day, totalMxnMinor }));
};

const fondoAsOfDay = (
  running: readonly { readonly day: string; readonly totalMxnMinor: number }[],
  day: string,
): number => {
  let total = 0;
  for (const point of running) {
    if (point.day > day) break;
    total = point.totalMxnMinor;
  }
  return total;
};

const mergeHistoryWithFondo = (
  liquidAll: readonly { readonly day: string; readonly totalMxnMinor: number }[],
  fondoRunning: readonly { readonly day: string; readonly totalMxnMinor: number }[],
): readonly { readonly day: string; readonly totalMxnMinor: number }[] => {
  const days = new Set<string>([
    ...liquidAll.map((point) => point.day),
    ...fondoRunning.map((point) => point.day),
  ]);
  const liquidByDay = new Map(liquidAll.map((point) => [point.day, point.totalMxnMinor]));
  return [...days]
    .sort((left, right) => left.localeCompare(right))
    .map((day) => ({
      day,
      totalMxnMinor: (liquidByDay.get(day) ?? 0) + fondoAsOfDay(fondoRunning, day),
    }));
};

const mergeHistoryWithLiabilities = (
  assetsHistory: readonly { readonly day: string; readonly totalMxnMinor: number }[],
  liabilitySnapshots: readonly CardLiabilitySnapshot[],
): readonly { readonly day: string; readonly totalMxnMinor: number }[] => {
  const days = new Set<string>([
    ...assetsHistory.map((point) => point.day),
    ...liabilitySnapshots.map((snapshot) => snapshot.day),
  ]);
  const assetsByDay = new Map(assetsHistory.map((point) => [point.day, point.totalMxnMinor]));
  let lastAssets = 0;
  return [...days]
    .sort((left, right) => left.localeCompare(right))
    .map((day) => {
      if (assetsByDay.has(day)) lastAssets = assetsByDay.get(day)!;
      return {
        day,
        totalMxnMinor: netWorthMxnMinor(lastAssets, liabilitiesAsOfDay(liabilitySnapshots, day)),
      };
    });
};

const toPublicLiabilitySnapshot = (item: Record<string, unknown>): CardLiabilitySnapshot | undefined => {
  if (typeof item.cardId !== 'string' || !isValidCardId(item.cardId)) return undefined;
  if (typeof item.day !== 'string' || typeof item.capturedAt !== 'string') return undefined;
  if (typeof item.totalMxnMinor !== 'number' || !Number.isInteger(item.totalMxnMinor) || item.totalMxnMinor < 0) {
    return undefined;
  }
  if (item.source !== 'manual') return undefined;
  return {
    cardId: item.cardId,
    day: item.day,
    capturedAt: item.capturedAt,
    source: 'manual',
    currency: 'MXN',
    totalMxnMinor: item.totalMxnMinor,
    ...(item.evidence && typeof item.evidence === 'object'
      ? { evidence: item.evidence as CardLiabilitySnapshot['evidence'] }
      : {}),
  };
};

const listCanonicalLiabilitySnapshots = async (owner: string): Promise<readonly CardLiabilitySnapshot[]> => {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${owner}`,
        ':sk': liabilitySnapshotSkPrefix,
      },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    for (const item of page.Items ?? []) {
      items.push(item as Record<string, unknown>);
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return items
    .map((item) => toPublicLiabilitySnapshot(item))
    .filter((snapshot): snapshot is CardLiabilitySnapshot => Boolean(snapshot))
    .sort((left, right) => left.day.localeCompare(right.day) || left.cardId.localeCompare(right.cardId));
};

const latestLiabilityByCard = (
  snapshots: readonly CardLiabilitySnapshot[],
): ReadonlyMap<string, CardLiabilitySnapshot> => {
  const latest = new Map<string, CardLiabilitySnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.cardId);
    if (
      !current
      || snapshot.day > current.day
      || (snapshot.day === current.day && snapshot.capturedAt > current.capturedAt)
    ) {
      latest.set(snapshot.cardId, snapshot);
    }
  }
  return latest;
};

const derivedFondoSnapshot = (
  totalMxnMinor: number,
  now: Date,
): WealthSnapshot | undefined => {
  if (totalMxnMinor <= 0) return undefined;
  const capturedAt = now.toISOString();
  const day = dayKeyInZone(now, FINANCE_TIME_ZONE);
  return {
    accountId: FONDO_AHORRO_ACCOUNT_ID,
    day,
    capturedAt,
    source: 'derived',
    currency: 'MXN',
    totalMxnMinor,
    holdings: [fondoAhorroHolding(totalMxnMinor)],
  };
};

export const getWealthOverview = async (
  owner: string,
  now: Date = new Date(),
): Promise<JsonObject> => {
  const year = dayKeyInZone(now, FINANCE_TIME_ZONE).slice(0, 4);
  const [snapshots, yearPayslips, cards, liabilitySnapshots] = await Promise.all([
    listCanonicalSnapshots(owner),
    listPayslipsForYear(owner, year),
    listCards({ database, tableName, owner }),
    listCanonicalLiabilitySnapshots(owner),
  ]);
  const fondoTotal = sumFondoAhorroDeduccionesMinor(yearPayslips);
  const fondoRunning = runningFondoAhorroByDay(yearPayslips);
  const fondoSnapshot = derivedFondoSnapshot(fondoTotal, now);
  const latest = new Map(latestByAccount(snapshots));
  if (fondoSnapshot) latest.set(FONDO_AHORRO_ACCOUNT_ID, fondoSnapshot);

  const accounts = seededWealthAccounts().map((account) => {
    const snapshot = latest.get(account.id) ?? null;
    return {
      ...account,
      connected: Boolean(snapshot),
      latestSnapshot: snapshot,
    };
  });
  const assetsMxnMinor = accounts.reduce(
    (sum, account) => sum + (account.latestSnapshot?.totalMxnMinor ?? 0),
    0,
  );
  const latestLiabilities = latestLiabilityByCard(liabilitySnapshots);
  const liabilities = cards.map((card) => {
    const snapshot = latestLiabilities.get(card.id) ?? null;
    return {
      cardId: card.id,
      name: card.name,
      ...(card.institution ? { institution: card.institution } : {}),
      latestSnapshot: snapshot,
    };
  });
  const liabilitiesMxnMinor = liabilities.reduce(
    (sum, liability) => sum + (liability.latestSnapshot?.totalMxnMinor ?? 0),
    0,
  );
  const netMxnMinor = netWorthMxnMinor(assetsMxnMinor, liabilitiesMxnMinor);
  const liquidAll = historyPoints(snapshots, 'all');
  const assetsHistory = mergeHistoryWithFondo(liquidAll, fondoRunning);
  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  const currentMonth = today.slice(0, 7);
  const historyAll = wealthTotalMonthlyHistory({
    points: mergeHistoryWithLiabilities(assetsHistory, liabilitySnapshots),
    currentMonth,
    currentTotalMinor: netMxnMinor,
  });
  return {
    currency: 'MXN',
    totalMxnMinor: assetsMxnMinor,
    assetsMxnMinor,
    liabilitiesMxnMinor,
    netMxnMinor,
    accounts,
    liabilities,
    history: {
      all: historyAll,
      byAccount: Object.fromEntries(
        WEALTH_ACCOUNTS.map((account) => [
          account.id,
          account.id === FONDO_AHORRO_ACCOUNT_ID
            ? fondoRunning
            : historyPoints(snapshots, account.id),
        ]),
      ),
    },
  };
};

export const persistWealthSnapshot = async (input: {
  readonly owner: string;
  readonly accountId: WealthAccountId;
  readonly source: WealthSnapshotSource;
  readonly holdings: readonly WealthHolding[];
  readonly evidenceKind: 'manual' | 'api';
  readonly evidenceBody: string;
  readonly fxSource?: string;
  readonly fxRate?: number;
}): Promise<WealthSnapshot> => {
  if (input.accountId === FONDO_AHORRO_ACCOUNT_ID || input.source === 'derived') {
    throw new InvalidWealthSnapshotError('Fondo de ahorro is derived from CFDI nómina; it cannot be snapshotted.');
  }
  const capturedAt = new Date().toISOString();
  const day = dayKeyInZone(new Date(capturedAt), FINANCE_TIME_ZONE);
  const totalMxnMinor = input.holdings.reduce((sum, holding) => sum + holding.valueMxnMinor, 0);
  const sourceHash = createHash('sha256').update(input.evidenceBody, 'utf8').digest('hex');
  const evidence = {
    bucket: rawSourceBucketName,
    key: evidenceObjectKey(input.evidenceKind, input.owner, sourceHash),
    sha256: sourceHash,
    contentType: 'application/json' as const,
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: evidence.key,
    Body: input.evidenceBody,
    ContentType: 'application/json; charset=utf-8',
  }));

  const key = wealthSnapshotKey(input.owner, input.accountId, day);
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: true,
  }));
  if (existing.Item) {
    const previousCapturedAt = typeof existing.Item.capturedAt === 'string'
      ? existing.Item.capturedAt
      : capturedAt;
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...wealthSnapshotVersionKey(input.owner, input.accountId, day, previousCapturedAt),
        entityType: 'wealth_snapshot_version',
        owner: input.owner,
        accountId: input.accountId,
        day,
        capturedAt: previousCapturedAt,
        supersededAt: capturedAt,
        source: existing.Item.source,
        currency: 'MXN',
        totalMxnMinor: existing.Item.totalMxnMinor,
        holdings: existing.Item.holdings,
        ...(existing.Item.evidence ? { evidence: existing.Item.evidence } : {}),
        ...(typeof existing.Item.fxRate === 'number' ? { fxRate: existing.Item.fxRate } : {}),
        ...(typeof existing.Item.fxSource === 'string' ? { fxSource: existing.Item.fxSource } : {}),
        versionId: randomUUID(),
      },
    }));
  }

  const snapshot: WealthSnapshot = {
    accountId: input.accountId,
    day,
    capturedAt,
    source: input.source,
    currency: 'MXN',
    totalMxnMinor,
    holdings: input.holdings,
    evidence,
    ...(input.fxSource ? { fxSource: input.fxSource } : {}),
    ...(typeof input.fxRate === 'number' ? { fxRate: input.fxRate } : {}),
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...key,
      entityType: 'wealth_snapshot',
      owner: input.owner,
      ...snapshot,
    },
  }));
  return snapshot;
};

export const createCajitaSnapshot = async (body: string | undefined, owner: string): Promise<JsonObject> => {
  const input = parseCajitaSnapshot(body);
  const holdings = [cajitaEmergencyHolding(input.amountMinor)];
  const capturedAt = new Date().toISOString();
  const day = dayKeyInZone(new Date(capturedAt), FINANCE_TIME_ZONE);
  const evidenceBody = JSON.stringify({
    kind: 'wealth_manual_snapshot',
    createdAt: capturedAt,
    owner,
    accountId: CAJITA_ACCOUNT_ID,
    day,
    amountMinor: input.amountMinor,
    currency: 'MXN',
    holdings,
  });
  const snapshot = await persistWealthSnapshot({
    owner,
    accountId: CAJITA_ACCOUNT_ID,
    source: 'manual',
    holdings,
    evidenceKind: 'manual',
    evidenceBody,
  });
  return snapshot as unknown as JsonObject;
};

export const createCardLiabilitySnapshot = async (
  cardId: string,
  body: string | undefined,
  owner: string,
): Promise<JsonObject> => {
  if (!isValidCardId(cardId)) {
    throw new InvalidWealthSnapshotError('cardId is invalid.');
  }
  const cards = await listCards({ database, tableName, owner });
  if (!cards.some((card) => card.id === cardId)) {
    throw new InvalidWealthSnapshotError('Card not found. Add the card under Fechas de corte first.');
  }
  const input = parseCardLiabilitySnapshot(body);
  const capturedAt = new Date().toISOString();
  const day = dayKeyInZone(new Date(capturedAt), FINANCE_TIME_ZONE);
  const evidenceBody = JSON.stringify({
    kind: 'wealth_liability_manual_snapshot',
    createdAt: capturedAt,
    owner,
    cardId,
    day,
    amountMinor: input.amountMinor,
    currency: 'MXN',
  });
  const sourceHash = createHash('sha256').update(evidenceBody, 'utf8').digest('hex');
  const evidence = {
    bucket: rawSourceBucketName,
    key: evidenceObjectKey('manual', owner, sourceHash),
    sha256: sourceHash,
    contentType: 'application/json' as const,
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: evidence.key,
    Body: evidenceBody,
    ContentType: 'application/json; charset=utf-8',
  }));

  const key = liabilitySnapshotKey(owner, cardId, day);
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: true,
  }));
  if (existing.Item) {
    const previousCapturedAt = typeof existing.Item.capturedAt === 'string'
      ? existing.Item.capturedAt
      : capturedAt;
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...liabilitySnapshotVersionKey(owner, cardId, day, previousCapturedAt),
        entityType: 'wealth_liability_snapshot_version',
        owner,
        cardId,
        day,
        capturedAt: previousCapturedAt,
        supersededAt: capturedAt,
        source: existing.Item.source,
        currency: 'MXN',
        totalMxnMinor: existing.Item.totalMxnMinor,
        ...(existing.Item.evidence ? { evidence: existing.Item.evidence } : {}),
        versionId: randomUUID(),
      },
    }));
  }

  const snapshot: CardLiabilitySnapshot = {
    cardId,
    day,
    capturedAt,
    source: 'manual',
    currency: 'MXN',
    totalMxnMinor: input.amountMinor,
    evidence,
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...key,
      entityType: 'wealth_liability_snapshot',
      owner,
      ...snapshot,
    },
  }));
  return snapshot as unknown as JsonObject;
};

export const assertCajitaAccountParam = (accountId: string): void => {
  if (accountId !== CAJITA_ACCOUNT_ID) {
    throw new InvalidWealthSnapshotError(
      `Only ${CAJITA_ACCOUNT_ID} accepts manual snapshots in this phase.`,
    );
  }
};
