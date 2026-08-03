/**
 * Mark Amex purchases covered by MONTO A DIFERIR as deferred_msi.
 *
 * Usage:
 *   METADATA_TABLE_NAME=... AWS_REGION=us-east-2 \
 *     npx tsx scripts/defer-amex-auto-msi-purchases.ts [--dry-run]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

const tableName = process.env.METADATA_TABLE_NAME;
if (!tableName) {
  console.error('METADATA_TABLE_NAME is required');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Confirmed from S3 statements: purchases covered by MONTO A DIFERIR credits. */
const DEFER_IDS = [
  'f29f0bbd-a954-4dec-a856-2c9927035760', // COSTCO 3099 → part of 6749
  'a3b28363-da18-4850-ae4d-09af383208ca', // GLOBALE 3650 → part of 6749
  'a8902774-1503-4c6f-92da-45719ba0b16c', // GOBIERNO 2476 → 2476 deferral
] as const;

const main = async () => {
  let updated = 0;
  for (const eventId of DEFER_IDS) {
    const existing = await database.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    }));
    const payload = existing.Item?.payload as {
      status?: string;
      merchantRaw?: string;
      parseWarnings?: unknown;
      msi?: unknown;
    } | undefined;
    if (!payload) {
      console.log(`MISSING ${eventId}`);
      continue;
    }
    if (payload.msi) {
      console.log(`SKIP has MSI ${eventId} ${payload.merchantRaw}`);
      continue;
    }
    if (payload.status === 'deferred_msi') {
      console.log(`ALREADY ${eventId} ${payload.merchantRaw}`);
      continue;
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}DEFER ${eventId} (${payload.merchantRaw}) ${payload.status} → deferred_msi`);
    if (dryRun) {
      updated += 1;
      continue;
    }
    const previousWarnings = Array.isArray(payload.parseWarnings) ? payload.parseWarnings : [];
    const warnings = [
      ...previousWarnings.filter((item) => typeof item === 'string' && !/Diferido a MSI/i.test(item)),
      'Diferido a MSI automático Amex (no cuenta en el mes).',
    ];
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
      UpdateExpression: 'SET #payload.#status = :status, #payload.#warnings = :warnings',
      ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status', '#warnings': 'parseWarnings' },
      ExpressionAttributeValues: { ':status': 'deferred_msi', ':warnings': warnings },
    }));
    const createdAt = new Date().toISOString();
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `EVENT#${eventId}`,
        SK: `REVISION#${createdAt}#${randomUUID()}`,
        entityType: 'event_revision',
        payload: {
          id: randomUUID(),
          observedPurchaseId: eventId,
          createdAt,
          changedBy: 'script:defer-amex-auto-msi-purchases',
          reason: 'Backfill: compra cubierta por MONTO A DIFERIR MESES EN AUTOMÁTICO.',
          changes: { status: { previous: payload.status, next: 'deferred_msi' } },
        },
      },
    }));
    updated += 1;
  }
  console.log(JSON.stringify({ updated, dryRun }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
