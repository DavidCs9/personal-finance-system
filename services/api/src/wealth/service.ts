import { withSqlTransaction } from '@finance/ledger/sql-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CAJITA_ACCOUNT_ID,
  isManualCashAccountId,
  manualCashHolding,
  dayKeyInZone,
  FINANCE_TIME_ZONE,
  FONDO_AHORRO_ACCOUNT_ID,
  fondoAhorroHolding,
  liabilitiesAsOfDay,
  netWorthMxnMinor,
  runningFondoBalanceByDay,
  payrollEmployerKey,
  isOrdinaryNomina,
  WEALTH_ACCOUNTS,
  wealthTotalMonthlyHistory,
  type CardLiabilitySnapshot,
  type PayrollClosure,
  type WealthAccountId,
  type WealthAccountDefinition,
  type WealthHolding,
  type WealthSnapshot,
  type WealthSnapshotSource,
} from '@finance/domain';
import { isValidCardId } from '../cards/cards.js';
import type { CardRecord } from '../cards/cards.js';
import { rawSourceBucketName, s3 } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { listPayslipsForYear } from '../imports/cfdi-nomina-flow.js';
import { readNativeWealthInputs, type NativeWealthInputsReader } from './native-reads.js';
import { InvalidWealthSnapshotError, parseCashSnapshot, parseCardLiabilitySnapshot, parsePayrollClosure } from './input.js';
import { insertNativeAssetCapture, insertNativeLiabilityCapture, validateAssetHoldings } from '@finance/ledger/native-wealth';
const evidenceObjectKey = (kind: 'manual' | 'api', owner: string, sha256: string): string =>
  kind === 'manual' ? `wealth-manual/${owner}/${sha256}.json` : `wealth-api/${owner}/${sha256}.json`;

const storeOriginalEvidence = async (key: string, body: string): Promise<void> => {
  try {
    await s3.send(new PutObjectCommand({ Bucket: rawSourceBucketName, Key: key, Body: body,
      ContentType: 'application/json; charset=utf-8', IfNoneMatch: '*' }));
  } catch (error) {
    if (errorName(error) !== 'PreconditionFailed') throw error;
  }
};

export interface WealthBalanceAccount {
  readonly id: WealthAccountId;
  readonly name: string;
  readonly institution: string;
  readonly role: string;
  readonly sync: string;
  readonly connected: boolean;
  readonly latestSnapshot: WealthSnapshot | null;
}

export interface WealthBalanceLiability {
  readonly cardId: string;
  readonly name: string;
  readonly institution?: string;
  readonly latestSnapshot: CardLiabilitySnapshot | null;
}

export interface WealthBalanceOverview {
  readonly currency: 'MXN';
  readonly asOfDay: string;
  readonly totalMxnMinor: number;
  readonly assetsMxnMinor: number;
  readonly liabilitiesMxnMinor: number;
  readonly netMxnMinor: number;
  readonly accounts: readonly WealthBalanceAccount[];
  readonly liabilities: readonly WealthBalanceLiability[];
  readonly payrollClosures?: readonly PayrollClosure[];
}

export const listWealthSnapshots = async (owner: string): Promise<readonly WealthSnapshot[]> =>
  (await readNativeWealthInputs(owner)).snapshots;

/**
 * Canonical daily snapshots for a connected account. Used by read-only agent
 * queries that compare a holding's value over time; evidence itself remains
 * private in S3 and is not returned here.
 */
export const listWealthSnapshotsForAccount = async (
  owner: string,
  accountId: WealthAccountId,
): Promise<readonly WealthSnapshot[]> =>
  (await readNativeWealthInputs(owner)).snapshots.filter((snapshot) => snapshot.accountId === accountId);

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

const netWorthHistoryPoints = (
  snapshots: readonly WealthSnapshot[],
  fondoRunning: readonly { readonly day: string; readonly totalMxnMinor: number }[],
  liabilitySnapshots: readonly CardLiabilitySnapshot[],
): readonly { readonly day: string; readonly totalMxnMinor: number }[] => {
  const days = new Set<string>([
    ...snapshots.map((snapshot) => snapshot.day),
    ...fondoRunning.map((point) => point.day),
    ...liabilitySnapshots.map((snapshot) => snapshot.day),
  ]);
  const sortedSnapshots = [...snapshots].sort(
    (left, right) => left.day.localeCompare(right.day) || left.capturedAt.localeCompare(right.capturedAt),
  );
  const latestLiquidByAccount = new Map<WealthAccountId, number>();
  let snapshotIndex = 0;
  return [...days].sort((left, right) => left.localeCompare(right)).map((day) => {
    while (snapshotIndex < sortedSnapshots.length && sortedSnapshots[snapshotIndex]!.day <= day) {
      const snapshot = sortedSnapshots[snapshotIndex]!;
      latestLiquidByAccount.set(snapshot.accountId, snapshot.totalMxnMinor);
      snapshotIndex += 1;
    }
    const liquidAssetsMinor = [...latestLiquidByAccount.values()].reduce((sum, amount) => sum + amount, 0);
    const assetsMinor = liquidAssetsMinor + fondoAsOfDay(fondoRunning, day);
    return {
      day,
      totalMxnMinor: netWorthMxnMinor(assetsMinor, liabilitiesAsOfDay(liabilitySnapshots, day)),
    };
  });
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
  day: string,
  capturedAt: string,
  settled: boolean,
): WealthSnapshot | undefined => {
  if (totalMxnMinor <= 0 && !settled) return undefined;
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

const wealthBalanceOverview = (input: {
  readonly accounts: readonly WealthAccountDefinition[];
  readonly snapshots: readonly WealthSnapshot[];
  readonly liabilitySnapshots: readonly CardLiabilitySnapshot[];
  readonly cards: readonly CardRecord[];
  readonly fondoTotalMinor: number;
  readonly payrollClosures?: readonly PayrollClosure[];
  readonly asOfDay: string;
  readonly capturedAt: string;
}): WealthBalanceOverview => {
  const eligibleSnapshots = input.snapshots.filter((snapshot) => snapshot.day <= input.asOfDay);
  const eligibleLiabilities = input.liabilitySnapshots.filter((snapshot) => snapshot.day <= input.asOfDay);
  const latest = new Map(latestByAccount(eligibleSnapshots));
  const closures = (input.payrollClosures ?? []).filter(closure => closure.fundPaidOn <= input.asOfDay);
  const fondoSnapshot = derivedFondoSnapshot(input.fondoTotalMinor, input.asOfDay, input.capturedAt, closures.length > 0);
  if (fondoSnapshot) latest.set(FONDO_AHORRO_ACCOUNT_ID, fondoSnapshot);

  const accounts: readonly WealthBalanceAccount[] = input.accounts.map((account) => {
    const snapshot = latest.get(account.id) ?? null;
    return { ...account, connected: Boolean(snapshot), latestSnapshot: snapshot };
  });
  const assetsMxnMinor = accounts.reduce(
    (sum, account) => sum + (account.latestSnapshot?.totalMxnMinor ?? 0),
    0,
  );
  const latestLiabilities = latestLiabilityByCard(eligibleLiabilities);
  const liabilities: readonly WealthBalanceLiability[] = input.cards.map((card) => ({
    cardId: card.id,
    name: card.name,
    ...(card.institution ? { institution: card.institution } : {}),
    latestSnapshot: latestLiabilities.get(card.id) ?? null,
  }));
  const liabilitiesMxnMinor = liabilities.reduce(
    (sum, liability) => sum + (liability.latestSnapshot?.totalMxnMinor ?? 0),
    0,
  );
  return {
    currency: 'MXN',
    asOfDay: input.asOfDay,
    totalMxnMinor: assetsMxnMinor,
    assetsMxnMinor,
    liabilitiesMxnMinor,
    netMxnMinor: netWorthMxnMinor(assetsMxnMinor, liabilitiesMxnMinor),
    accounts,
    liabilities,
    ...(closures.length ? { payrollClosures: closures } : {}),
  };
};

/** Historical carry-forward balance used by immutable month-close reports. */
export const getWealthOverviewAsOf = async (
  owner: string,
  asOfDay: string,
  readPayrollYear: typeof listPayslipsForYear = listPayslipsForYear,
  readInputs: NativeWealthInputsReader = readNativeWealthInputs,
): Promise<WealthBalanceOverview> => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDay)) throw new Error('asOfDay must be YYYY-MM-DD.');
  const year = asOfDay.slice(0, 4);
  const [inputs, yearPayslips] = await Promise.all([readInputs(owner), readPayrollYear(owner, year)]);
  const { accounts, snapshots, cards, liabilitySnapshots } = inputs;
  const closures = inputs.payrollClosures ?? [];
  const fondoTotalMinor = runningFondoBalanceByDay(yearPayslips, closures, asOfDay).at(-1)?.totalMxnMinor ?? 0;
  return wealthBalanceOverview({
    accounts,
    snapshots,
    liabilitySnapshots,
    cards,
    fondoTotalMinor,
    payrollClosures: closures,
    asOfDay,
    capturedAt: `${asOfDay}T12:00:00.000Z`,
  });
};

export const getWealthOverview = async (
  owner: string,
  now: Date = new Date(),
  readPayrollYear: typeof listPayslipsForYear = listPayslipsForYear,
  readInputs: NativeWealthInputsReader = readNativeWealthInputs,
): Promise<WealthBalanceOverview & JsonObject> => {
  const year = dayKeyInZone(now, FINANCE_TIME_ZONE).slice(0, 4);
  const [inputs, yearPayslips] = await Promise.all([readInputs(owner), readPayrollYear(owner, year)]);
  const { accounts, snapshots, cards, liabilitySnapshots } = inputs;
  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  const closures = inputs.payrollClosures ?? [];
  const fondoRunning = runningFondoBalanceByDay(yearPayslips, closures, today);
  const closedEmployers = new Set(closures.map(closure => payrollEmployerKey(closure.employerName)));
  const candidate = [...yearPayslips].reverse().find(slip => slip.fechaPago <= today
    && isOrdinaryNomina(slip.tipoNomina) && payrollEmployerKey(slip.employerName)
    && !closedEmployers.has(payrollEmployerKey(slip.employerName)));
  const balance = wealthBalanceOverview({
    accounts,
    snapshots,
    liabilitySnapshots,
    cards,
    fondoTotalMinor: fondoRunning.at(-1)?.totalMxnMinor ?? 0,
    payrollClosures: closures,
    asOfDay: today,
    capturedAt: now.toISOString(),
  });
  const currentMonth = today.slice(0, 7);
  const historyAll = wealthTotalMonthlyHistory({
    points: netWorthHistoryPoints(snapshots, fondoRunning, liabilitySnapshots),
    currentMonth,
    currentTotalMinor: balance.netMxnMinor,
  });
  return {
    ...balance,
    ...(candidate?.employerName ? { payrollCloseCandidate: { payslipUuid: candidate.uuid, employerName: candidate.employerName } } : {}),
    history: {
      all: historyAll,
      byAccount: Object.fromEntries(
        accounts.map((account) => [
          account.id,
          account.id === FONDO_AHORRO_ACCOUNT_ID
            ? fondoRunning
            : historyPoints(snapshots, account.id),
        ]),
      ),
    },
  };
};

/** One selected canonical bundle per report, reused across closing days. */
export const getWealthOverviewsAsOf = async (owner: string, days: readonly string[],
  readPayrollYear: typeof listPayslipsForYear = listPayslipsForYear,
  readInputs: NativeWealthInputsReader = readNativeWealthInputs,
): Promise<readonly WealthBalanceOverview[]> => {
  const inputs = await readInputs(owner);
  const years = [...new Set(days.map(day => day.slice(0, 4)))];
  const payroll = new Map(await Promise.all(years.map(async year => [year, await readPayrollYear(owner, year)] as const)));
  return Promise.all(days.map(day => getWealthOverviewAsOf(owner, day,
    async (_owner, year) => payroll.get(year) ?? [], async () => inputs)));
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
  if (!WEALTH_ACCOUNTS.some(account => account.id === input.accountId) || !['manual', 'api', 'flex'].includes(input.source))
    throw new InvalidWealthSnapshotError('Invalid capture account or source.');
  if (input.fxRate !== undefined && (!Number.isFinite(input.fxRate) || input.fxRate <= 0))
    throw new InvalidWealthSnapshotError('Invalid capture FX rate.');
  const totalMxnMinor = validateAssetHoldings(input.holdings);
  const id = randomUUID();
  const sourceHash = createHash('sha256').update(input.evidenceBody, 'utf8').digest('hex');
  const evidence = {
    bucket: rawSourceBucketName,
    key: evidenceObjectKey(input.evidenceKind, input.owner, sourceHash),
    sha256: sourceHash,
    contentType: 'application/json' as const,
  };
  await storeOriginalEvidence(evidence.key, input.evidenceBody);

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
  return withSqlTransaction(client => insertNativeAssetCapture(client, { id, owner: input.owner, snapshot }));
};

export const createManualCashSnapshot = async (accountId: string, body: string | undefined, owner: string): Promise<JsonObject> => {
  if (!isManualCashAccountId(accountId)) {
    throw new InvalidWealthSnapshotError('Only nu_cajita_emergencia and santander_cash accept manual snapshots.');
  }
  const input = parseCashSnapshot(body, accountId !== CAJITA_ACCOUNT_ID);
  const holdings = [manualCashHolding(accountId, input.amountMinor)];
  const capturedAt = new Date().toISOString();
  const day = dayKeyInZone(new Date(capturedAt), FINANCE_TIME_ZONE);
  const evidenceBody = JSON.stringify({
    kind: 'wealth_manual_snapshot',
    createdAt: capturedAt,
    owner,
    accountId,
    day,
    amountMinor: input.amountMinor,
    currency: 'MXN',
    holdings,
  });
  const snapshot = await persistWealthSnapshot({
    owner,
    accountId,
    source: 'manual',
    holdings,
    evidenceKind: 'manual',
    evidenceBody,
  });
  return snapshot as unknown as JsonObject;
};

export const closePayrollAndFund = async (body: string | undefined, owner: string): Promise<JsonObject> => {
  const now = new Date();
  const input = parsePayrollClosure(body, dayKeyInZone(now, FINANCE_TIME_ZONE));
  const evidenceBody = JSON.stringify({ kind: 'payroll_fund_closure', owner, ...input });
  const sha256 = createHash('sha256').update(evidenceBody, 'utf8').digest('hex');
  const key = evidenceObjectKey('manual', owner, sha256);
  await storeOriginalEvidence(key, evidenceBody);
  return withSqlTransaction(async client => {
    const receipt = (await client.query(`SELECT employer_name, COALESCE(pay_period_end, paid_on)::text AS period_end
      FROM olbia.payslips WHERE uuid=$1::uuid AND owner=$2 AND payroll_type='O'`, [input.payslipUuid, owner])).rows[0];
    const employerName = typeof receipt?.employer_name === 'string' ? receipt.employer_name : '';
    const employerKey = payrollEmployerKey(employerName);
    if (!employerKey || String(receipt?.period_end) > input.endedOn) {
      throw new InvalidWealthSnapshotError('La nómina elegida debe corresponder al trabajo que terminó.');
    }
    await client.query(`INSERT INTO olbia.payroll_closures
      (owner,employer_key,source_payslip_uuid,ended_on,fund_paid_on,fund_paid_mxn_minor,recorded_at,evidence_bucket,evidence_key,evidence_sha256)
      VALUES ($1,$2,$3::uuid,$4::date,$5::date,$6,$7,$8,$9,$10) ON CONFLICT (owner,employer_key) DO NOTHING`,
    [owner, employerKey, input.payslipUuid, input.endedOn, input.fundPaidOn, input.fundPaidMinor, now.toISOString(), rawSourceBucketName, key, sha256]);
    const saved = (await client.query(`SELECT evidence_sha256 FROM olbia.payroll_closures
      WHERE owner=$1 AND employer_key=$2`, [owner, employerKey])).rows[0];
    if (saved?.evidence_sha256 !== sha256) {
      throw new InvalidWealthSnapshotError('Ya existe un cierre para este empleador. Actualiza Patrimonio para verlo.');
    }
    return { employerName, endedOn: input.endedOn, fundPaidOn: input.fundPaidOn, fundPaidMinor: input.fundPaidMinor };
  });
};

export const createCardLiabilitySnapshot = async (
  cardId: string,
  body: string | undefined,
  owner: string,
): Promise<JsonObject> => {
  if (!isValidCardId(cardId)) {
    throw new InvalidWealthSnapshotError('cardId is invalid.');
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
  const id = randomUUID();
  await storeOriginalEvidence(evidence.key, evidenceBody);

  const snapshot: CardLiabilitySnapshot = {
    cardId,
    day,
    capturedAt,
    source: 'manual',
    currency: 'MXN',
    totalMxnMinor: input.amountMinor,
    evidence,
  };
  return withSqlTransaction(async client =>
    await insertNativeLiabilityCapture(client, { id, owner, snapshot }) as unknown as JsonObject);
};
