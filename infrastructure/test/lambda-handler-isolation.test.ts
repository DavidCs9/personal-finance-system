import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const lambdaDir = path.join(here, '..', 'lambda');

const bundleEntry = async (entryFile: string): Promise<string> => {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(lambdaDir, entryFile)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify: false,
    // Mirror CDK NodejsFunction for nodejs18+: AWS SDK stays in the runtime.
    external: ['@aws-sdk/*', '@aws-lambda-powertools/*', 'web-push'],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error(`esbuild produced no output for ${entryFile}`);
  return file.text;
};

describe('lambda handler bundle isolation', () => {
  it('api entry does not load apple-pay capture env requirements', async () => {
    const code = await bundleEntry('api.ts');
    expect(code).toMatch(/METADATA_TABLE_NAME|RAW_EMAIL_BUCKET_NAME/);
    expect(code).not.toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });

  it('daily-balance entry does not load apple-pay capture env requirements', async () => {
    const code = await bundleEntry('daily-balance-push.ts');
    expect(code).toContain('VAPID_SECRET_ARN');
    expect(code).not.toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });

  it('card-cycle entry does not load apple-pay capture env requirements', async () => {
    const code = await bundleEntry('card-cycle-push.ts');
    expect(code).toContain('VAPID_SECRET_ARN');
    expect(code).not.toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });

  it('apple-pay entry keeps its secret env requirement', async () => {
    const code = await bundleEntry('apple-pay-capture.ts');
    expect(code).toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });

  it('bitso-sync entry does not load apple-pay capture env requirements', async () => {
    const code = await bundleEntry('bitso-sync.ts');
    expect(code).toContain('BITSO_SECRET_ARN');
    expect(code).not.toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });
});
