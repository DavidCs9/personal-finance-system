/**
 * Reject duplicate MSI plans created from mid-schedule statement imports.
 * Keeps the most complete plan per (merchant, cuota, months) and merges
 * evidence observation ids onto the keeper by installment index.
 *
 * Usage (from infrastructure/):
 *   METADATA_TABLE_NAME=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/dedupe-msi-plans.ts [--dry-run]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  cancelRemainingInstallments,
  markInstallmentSpent,
  type MsiPlan,
} from '@finance/domain';

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) {
  console.error('METADATA_TABLE_NAME is required');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

type EventItem = {
  PK?: string;
  SK?: string;
  payload?: {
    id?: string;
    merchantRaw?: string;
    status?: string;
    occurredAt?: string;
    receivedAt?: string;
    msi?: MsiPlan;
  };
};

const normaliseMerchant = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const groupKey = (plan: MsiPlan, merchantRaw: string): string =>
  `${normaliseMerchant(merchantRaw).slice(0, 28)}|${plan.cuotaMinor}|${plan.months}`;

const spentCount = (plan: MsiPlan): number =>
  plan.installments.filter((item) => item.status === 'spent').length;

const evidenceCount = (plan: MsiPlan): number =>
  plan.installments.filter((item) => item.evidenceObservationId).length;

const score = (item: EventItem): number => {
  const plan = item.payload?.msi;
  if (!plan) return -1;
  return spentCount(plan) * 10 + evidenceCount(plan);
};

const mergeEvidence = (keeper: MsiPlan, donor: MsiPlan): MsiPlan => {
  let next = keeper;
  for (const donorInst of donor.installments) {
    if (!donorInst.evidenceObservationId) continue;
    const target = next.installments.find((item) => item.index === donorInst.index);
    if (!target) continue;
    if (target.evidenceObservationId === donorInst.evidenceObservationId) continue;
    if (target.evidenceObservationId) continue;
    next = markInstallmentSpent(next, donorInst.index, {
      amountMinor: donorInst.amountMinor,
      confirmedAt: donorInst.confirmedAt ?? new Date().toISOString(),
      evidenceObservationId: donorInst.evidenceObservationId,
    });
  }
  return next;
};

const main = async () => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const events: EventItem[] = [];

  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :partition',
      ExpressionAttributeValues: { ':partition': 'EVENTS' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of (result.Items ?? []) as EventItem[]) {
      if (item.SK === 'EVENT' && item.payload?.msi && item.payload.status !== 'rejected') {
        events.push(item);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const groups = new Map<string, EventItem[]>();
  for (const event of events) {
    const plan = event.payload!.msi!;
    const key = groupKey(plan, event.payload!.merchantRaw ?? '');
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }

  let rejected = 0;
  let merged = 0;

  for (const [key, group] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((left, right) => {
      const scoreDiff = score(right) - score(left);
      if (scoreDiff !== 0) return scoreDiff;
      return String(left.payload?.receivedAt).localeCompare(String(right.payload?.receivedAt));
    });
    const keeper = ranked[0];
    const duplicates = ranked.slice(1);
    let keeperPlan = keeper.payload!.msi!;

    console.log(`\nGROUP ${key}`);
    console.log(
      `  KEEP ${keeper.payload!.id} (${keeper.payload!.merchantRaw}) `
      + `spent=${spentCount(keeperPlan)} evidence=${evidenceCount(keeperPlan)}`,
    );

    for (const duplicate of duplicates) {
      const donorPlan = duplicate.payload!.msi!;
      const beforeEvidence = evidenceCount(keeperPlan);
      keeperPlan = mergeEvidence(keeperPlan, donorPlan);
      if (evidenceCount(keeperPlan) > beforeEvidence) merged += 1;
      console.log(
        `  REJECT ${duplicate.payload!.id} spent=${spentCount(donorPlan)} `
        + `evidence=${evidenceCount(donorPlan)}`,
      );
      if (!dryRun && duplicate.PK) {
        const cancelled = cancelRemainingInstallments(donorPlan);
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: duplicate.PK, SK: 'EVENT' },
          UpdateExpression: 'SET #payload.#status = :rejected, #payload.#msi = :msi',
          ExpressionAttributeNames: {
            '#payload': 'payload',
            '#status': 'status',
            '#msi': 'msi',
          },
          ExpressionAttributeValues: {
            ':rejected': 'rejected',
            ':msi': cancelled,
          },
        }));
      }
      rejected += 1;
    }

    if (keeperPlan !== keeper.payload!.msi && keeper.PK) {
      console.log(`  MERGE evidence onto keeper → evidence=${evidenceCount(keeperPlan)}`);
      if (!dryRun) {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: keeper.PK, SK: 'EVENT' },
          UpdateExpression: 'SET #payload.#msi = :msi',
          ExpressionAttributeNames: { '#payload': 'payload', '#msi': 'msi' },
          ExpressionAttributeValues: { ':msi': keeperPlan },
        }));
      }
    }
  }

  // Re-query keepers after merges so backfills do not clobber merged evidence.
  const refreshed: EventItem[] = [];
  {
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await database.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :partition',
        ExpressionAttributeValues: { ':partition': 'EVENTS' },
        ExclusiveStartKey: startKey,
      }));
      for (const item of (result.Items ?? []) as EventItem[]) {
        if (item.SK === 'EVENT' && item.payload?.msi && item.payload.status !== 'rejected') {
          refreshed.push(item);
        }
      }
      startKey = result.LastEvaluatedKey;
    } while (startKey);
  }

  // Confirm July cuotas that landed on statements before their plans existed.
  const julyBackfills: Array<{ principal: number; index: number; label: string }> = [
    { principal: 674_900, index: 2, label: 'MESES AUTO 674900 2/3' },
    { principal: 247_600, index: 3, label: 'MESES AUTO 247600 3/3' },
  ];
  for (const backfill of julyBackfills) {
    const event = refreshed.find((item) =>
      item.payload?.msi?.principalMinor === backfill.principal
      && item.payload.status !== 'rejected'
    );
    if (!event?.payload?.msi || !event.PK) continue;
    const installment = event.payload.msi.installments.find((item) => item.index === backfill.index);
    if (installment?.status !== 'committed') continue;
    const next = markInstallmentSpent(event.payload.msi, backfill.index, {
      amountMinor: installment.amountMinor,
      confirmedAt: new Date().toISOString(),
      evidenceObservationId: `backfill:amex:${backfill.principal}:${backfill.index}`,
    });
    console.log(`\nBACKFILL confirm ${backfill.label} (${event.payload.id})`);
    if (!dryRun) {
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: event.PK, SK: 'EVENT' },
        UpdateExpression: 'SET #payload.#msi = :msi',
        ExpressionAttributeNames: { '#payload': 'payload', '#msi': 'msi' },
        ExpressionAttributeValues: { ':msi': next },
      }));
    }
    merged += 1;
  }

  console.log(JSON.stringify({ groups: groups.size, rejected, merged, dryRun }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
