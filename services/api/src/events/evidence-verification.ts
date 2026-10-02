import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import type { ReadSqlClient } from './sql-reads.js';

/** Collect immutable assertions inside a read snapshot; original object IO happens after it closes. */
export const collectLedgerEvidence = async (client: ReadSqlClient) => (await client.query(`SELECT capture_source,
  source_kind,evidence_bucket,evidence_key,evidence_sha256,evidence_content_type FROM olbia.ledger_observations
  ORDER BY id`)).rows;

const originalBytes = async (bucket: string, key: string) => {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error('Missing original ledger evidence body');
  return object.Body.transformToByteArray();
};

/** Rehash each unique original object once. Shared references cannot hide conflicting hash assertions. */
export const verifyLedgerEvidence = async (assertions: readonly JsonObject[], readBytes = originalBytes) => {
  const started = Date.now();
  let mismatches = 0, inlineCaptures = 0, conflictingObjects = 0, evidenceFiles = 0;
  const objects = new Map<string, { bucket: string; key: string; hashes: Set<string> }>();
  for (const assertion of assertions) {
    if (assertion.evidence_bucket == null) {
      const inline = assertion.capture_source === 'apple_pay_shortcut' && assertion.source_kind === 'apple_pay_shortcut'
        && assertion.evidence_key == null && assertion.evidence_sha256 == null && assertion.evidence_content_type == null;
      if (inline) inlineCaptures++; else mismatches++;
      continue;
    }
    const { evidence_bucket: bucket, evidence_key: key, evidence_sha256: sha256, evidence_content_type: contentType } = assertion;
    if (typeof bucket !== 'string' || !bucket.length || typeof key !== 'string' || !key.length
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || typeof contentType !== 'string' || !contentType.length) {
      mismatches++; continue;
    }
    const identity = JSON.stringify([bucket, key]);
    const object = objects.get(identity) ?? { bucket, key, hashes: new Set<string>() };
    object.hashes.add(sha256); objects.set(identity, object);
  }
  for (const object of objects.values()) {
    if (object.hashes.size !== 1) { conflictingObjects++; mismatches++; continue; }
    const actual = createHash('sha256').update(await readBytes(object.bucket, object.key)).digest('hex');
    mismatches += Number(!object.hashes.has(actual)); evidenceFiles++;
  }
  return { captures: assertions.length, inlineCaptures, uniqueObjects: objects.size, evidenceFiles,
    conflictingObjects, mismatches, elapsedMs: Date.now() - started };
};
