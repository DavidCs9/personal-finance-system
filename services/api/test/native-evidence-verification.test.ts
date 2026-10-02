import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
let verify: typeof import('../src/events/evidence-verification.js')['verifyLedgerEvidence'];
const bytes = new Uint8Array([1, 2, 3]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const source = { capture_source: 'email', source_kind: null, evidence_bucket: 'original', evidence_key: 'raw/one',
  evidence_sha256: sha256, evidence_content_type: 'message/rfc822' };
beforeAll(async () => {
  vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  verify = (await import('../src/events/evidence-verification.js')).verifyLedgerEvidence;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllEnvs());
describe('original ledger evidence hash verification', () => {
  it('deduplicates shared objects, consumes each SDK body once and recognizes original inline Apple Pay captures', async () => {
    const consume = vi.fn().mockResolvedValue(bytes);
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: { transformToByteArray: consume } } as never);
    const result = await verify([source, { ...source, capture_source: 'santander_csv' },
      { capture_source: 'apple_pay_shortcut', source_kind: 'apple_pay_shortcut' }]);
    expect(result).toMatchObject({ captures: 3, inlineCaptures: 1, uniqueObjects: 1, evidenceFiles: 1, conflictingObjects: 0, mismatches: 0 });
    expect(send).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'original', Key: 'raw/one' });
    expect(JSON.stringify(result)).not.toMatch(/original|raw\/one|evidence_sha256/);
  });
  it('fails conflicting hash assertions before downloading the disputed object and detects a changed binary', async () => {
    const read = vi.fn().mockResolvedValue(bytes);
    expect(await verify([source, { ...source, evidence_sha256: 'a'.repeat(64) }], read))
      .toMatchObject({ conflictingObjects: 1, evidenceFiles: 0, mismatches: 1 });
    expect(read).not.toHaveBeenCalled();
    expect(await verify([{ ...source, evidence_sha256: 'a'.repeat(64) }], read)).toMatchObject({ evidenceFiles: 1, mismatches: 1 });
  });
  it('rejects partial evidence, missing non-shortcut evidence and unavailable original objects', async () => {
    expect(await verify([{ ...source, evidence_sha256: null }, { capture_source: 'manual' },
      { capture_source: 'apple_pay_shortcut', source_kind: 'apple_pay_shortcut', evidence_key: 'incomplete' }]))
      .toMatchObject({ evidenceFiles: 0, inlineCaptures: 0, mismatches: 3 });
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    await expect(verify([source])).rejects.toThrow('Missing original ledger evidence body');
    vi.mocked(S3Client.prototype.send).mockRejectedValue(new Error('Object unavailable') as never);
    await expect(verify([source])).rejects.toThrow('Object unavailable');
  });
});
