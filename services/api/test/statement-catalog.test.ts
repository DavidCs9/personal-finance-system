import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { nativeFixture } from './fixtures/native-ledger.js';
process.env.RAW_EMAIL_BUCKET_NAME = 'test-evidence';
const { getStatementCatalog, getStatementSource } = await import('../src/imports/statement-catalog.js');
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => { fixture = await nativeFixture(); }, 30_000);
afterAll(async () => { await fixture.sql.close(); });
beforeEach(async () => { await fixture.reset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const now = new Date('2026-10-25T01:00:00Z');
const insert = async (hash: string, kind: string, owner: string, status = 'processing') => {
  await fixture.sql.query(`INSERT INTO olbia.bank_imports
    (kind,content_sha256,owner,status,created_at,account_last_four,product,period_start,period_end,evidence_bucket,evidence_key,evidence_content_type,textract_job_id)
    VALUES ($1,$2,$3,$4,'2026-09-23T01:00:00Z','1234','Gold','2026-08-23','2026-09-22','test-evidence',$5,'application/pdf','test-job')`,
    [kind, hash, owner, status, `retained/${owner}/${hash}.pdf`]);
};

describe('native statement catalog', () => {
  it('reads owner-scoped PDF headers, excludes CSV, preserves day precision and changes no financial/import records', async () => {
    await insert('a'.repeat(64), 'amex_statement', 'owner');
    await insert('b'.repeat(64), 'santander_statement', 'owner', 'previewed');
    await insert('c'.repeat(64), 'amex_statement', 'other');
    await insert('d'.repeat(64), 'santander_csv', 'owner', 'previewed');
    const snapshot = async () => ({ finances: await fixture.snapshot(), imports: (await fixture.sql.query('SELECT * FROM olbia.bank_imports ORDER BY kind,content_sha256')).rows });
    const before = await snapshot();
    const catalog = await getStatementCatalog('owner', now, fixture.pool);
    expect(catalog.accounts).toHaveLength(2);
    expect(catalog.accounts.flatMap(a => a.cycles).flatMap(c => c.documents).map(d => d.importId)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(catalog.accounts[0]!.cycles.find(c => c.month === '2026-09')?.documents[0]).toMatchObject({
      period: { from: '2026-08-23', to: '2026-09-22' }, status: 'processing', createdAt: '2026-09-23T01:00:00.000Z',
    });
    expect(JSON.stringify(catalog)).not.toMatch(/evidence_bucket|evidence_key|retained\/|other|error_message/);
    expect(await getStatementCatalog('absent', now, fixture.pool)).toMatchObject({ accounts: [], unidentifiedDocuments: [] });
    expect(await snapshot()).toEqual(before);
  });
  it('signs only a proven owner/provider original, using native GET without reading or writing S3', async () => {
    vi.stubEnv('AWS_REGION', 'us-east-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-access');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
    const send = vi.spyOn(S3Client.prototype, 'send');
    await insert('a'.repeat(64), 'amex_statement', 'owner');
    const source = await getStatementSource('amex', 'a'.repeat(64), 'owner', fixture.pool);
    const url = new URL(source!.url);
    expect(url.pathname).toBe(`/retained/owner/${'a'.repeat(64)}.pdf`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(await getStatementSource('amex', 'a'.repeat(64), 'other', fixture.pool)).toBeUndefined();
    expect(await getStatementSource('santander', 'a'.repeat(64), 'owner', fixture.pool)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
  it.each([['csv', 'a'.repeat(64)], ['amex', '../someone.pdf']])('rejects invalid source identifiers %s/%s', async (provider, id) => {
    await expect(getStatementSource(provider!, id!, 'owner', fixture.pool)).rejects.toThrow('no es válido');
  });
});
