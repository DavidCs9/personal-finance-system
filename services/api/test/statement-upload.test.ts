import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STATEMENT_PDF_BYTES } from '@finance/domain';

process.env.RAW_EMAIL_BUCKET_NAME = 'test-evidence';
const { createStatementUpload, resolveStatementSource } = await import('../src/imports/statement-upload.js');
const bytes = Buffer.from('%PDF-original statement');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const checksum = createHash('sha256').update(bytes).digest('base64');
const body = JSON.stringify({ sha256, size: bytes.length });
const event = { body, headers: { 'content-type': 'application/json' } };

beforeEach(() => {
  vi.stubEnv('AWS_REGION', 'us-east-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret-key');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('direct statement uploads', () => {
  for (const provider of ['amex', 'santander'] as const) {
    it(`${provider} signs the owner/provider/hash, exact length, type, checksum and conditional creation`, async () => {
      const send = vi.spyOn(S3Client.prototype, 'send');
      const target = await createStatementUpload(provider, 'owner', body);
      const url = new URL(target.url);
      expect(url.pathname).toBe(`/manual-imports/${provider === 'amex' ? 'amex' : 'santander-statement'}/owner/${sha256}.pdf`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
        'content-length', 'content-type', 'host', 'if-none-match', 'x-amz-checksum-sha256',
      ]);
      expect(target.headers).toEqual({ 'Content-Type': 'application/pdf', 'x-amz-checksum-sha256': checksum, 'If-None-Match': '*' });
      expect(send).not.toHaveBeenCalled();
    });

    it(`${provider} verifies a retained original before starting extraction without writing it`, async () => {
      const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
        if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length, ContentType: 'application/pdf', ChecksumSHA256: checksum };
        if (command instanceof GetObjectCommand) {
          expect(command.input.Range).toBe('bytes=0-4');
          return { Body: { transformToByteArray: async () => bytes.subarray(0, 5) } };
        }
        throw new Error('Unexpected operation');
      }) as never);
      const source = await resolveStatementSource(provider, 'owner', event);
      expect(source).toMatchObject({ sha256, contentType: 'application/pdf', bucket: 'test-evidence' });
      expect(send).toHaveBeenCalledTimes(2);
      expect((send.mock.calls[0][0] as HeadObjectCommand).input).toMatchObject({ Key: source.key, ChecksumMode: 'ENABLED' });
    });
  }

  it.each(['{', 'null', '{}', JSON.stringify({ sha256: '../someone-else', size: 12 }), JSON.stringify({ sha256, size: 0 }), JSON.stringify({ sha256, size: 1.2 }), JSON.stringify({ sha256, size: MAX_STATEMENT_PDF_BYTES + 1 })])(
    'rejects invalid upload metadata before signing or reading: %s', async (invalidBody) => {
      await expect(createStatementUpload('amex', 'owner', invalidBody)).rejects.toThrow();
    },
  );

  it('rejects binary API uploads', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    await expect(resolveStatementSource('amex', 'owner', { body: '%PDF-', headers: { 'content-type': 'application/pdf' } })).rejects.toThrow('directamente');
    expect(send).not.toHaveBeenCalled();
  });

  it('cannot resolve another owner’s original', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: HeadObjectCommand) => {
      expect(command.input.Key).toContain('/other-owner/');
      throw Object.assign(new Error('Missing'), { name: 'NotFound' });
    }) as never);
    await expect(resolveStatementSource('amex', 'other-owner', event)).rejects.toThrow('no terminó');
  });

  it.each([
    { ContentLength: bytes.length + 1, ContentType: 'application/pdf', ChecksumSHA256: checksum },
    { ContentLength: bytes.length, ContentType: 'text/plain', ChecksumSHA256: checksum },
    { ContentLength: bytes.length, ContentType: 'application/pdf', ChecksumSHA256: 'wrong' },
  ])('rejects an original with mismatched metadata: %j', async (head) => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue(head as never);
    await expect(resolveStatementSource('amex', 'owner', event)).rejects.toThrow('no coincide');
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([bytes, Buffer.from('%PDF-modified statement')])('verifies legacy originals by full hash without overwriting them', async (original) => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length, ContentType: 'application/pdf' };
      if (command instanceof GetObjectCommand) {
        expect(command.input.Range).toBeUndefined();
        return { Body: { transformToByteArray: async () => original } };
      }
      throw new Error('Must not write');
    }) as never);
    if (original === bytes) await expect(resolveStatementSource('amex', 'owner', event)).resolves.toHaveProperty('sha256', sha256);
    else await expect(resolveStatementSource('amex', 'owner', event)).rejects.toThrow('PDF válido');
  });

  it('rejects non-PDF bytes and preserves transient provider errors', async () => {
    vi.spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ ContentLength: bytes.length, ContentType: 'application/pdf', ChecksumSHA256: checksum } as never)
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => Buffer.from('wrong') } } as never)
      .mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(resolveStatementSource('amex', 'owner', event)).rejects.toThrow('PDF válido');
    await expect(resolveStatementSource('amex', 'owner', event)).rejects.toThrow('Provider unavailable');
  });
});
