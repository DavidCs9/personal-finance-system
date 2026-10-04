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
    metafile: true,
    // Mirror CDK NodejsFunction for nodejs18+: AWS SDK stays in the runtime.
    external: ['@aws-sdk/*', '@aws-lambda-powertools/*', 'web-push'],
  });
  expect(Object.keys(result.metafile!.inputs).some(input => /(?:test\/helpers|legacy-document-store|retained-evidence)\b/.test(input))).toBe(false);
  const file = result.outputFiles[0];
  if (!file) throw new Error(`esbuild produced no output for ${entryFile}`);
  for (const retired of ['@aws-sdk/lib-dynamodb', '@aws-sdk/client-dynamodb', 'METADATA_TABLE_NAME',
    'OLBIA_SQL_STORE_ENABLED', 'OLBIA_SQL_STORE_ROLE', 'DSQL_OPERATIONAL_READ_MODE', 'legacy-document-store']) {
    expect(file.text, `${entryFile} must use the native SQL runtime`).not.toContain(retired);
  }
  return file.text;
};

describe('lambda handler bundle isolation', () => {
  it('schema entry includes only native bootstrap and explicit retirement, with no historical copy implementation', async () => {
    const result = await esbuild.build({ absWorkingDir: repoRoot, entryPoints: [path.join(lambdaDir, 'dsql-schema.ts')],
      bundle: true, write: false, metafile: true, platform: 'node', format: 'cjs', target: 'node24', external: ['@aws-sdk/*'] });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some(input => /(?:test\/helpers|legacy-document-store|(?:ledger|wealth|card|month-plan|payroll|import)-copy)\b/.test(input))).toBe(false);
    expect(result.outputFiles[0].text).not.toMatch(/CREATE TABLE IF NOT EXISTS olbia\.(?:projection_state|command_receipts|movements|payroll)\b/);
    expect(result.outputFiles[0].text).toContain('DROP TABLE IF EXISTS olbia.');
    expect(result.outputFiles[0].text).not.toMatch(/SELECT source_item|ScanCommand|GetItemCommand/);
  });

  it('api entry does not load apple-pay capture env requirements', async () => {
    const code = await bundleEntry('api.ts');
    expect(code).toContain('RAW_EMAIL_BUCKET_NAME');
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

  it('monthly-close entry keeps report-specific configuration isolated', async () => {
    const code = await bundleEntry('monthly-close-email.ts');
    expect(code).toContain('MONTHLY_CLOSE_OWNER');
    expect(code).toContain('MONTHLY_CLOSE_MODEL_ID');
    expect(code).toContain('SYSTEM_PROMPT_VERSION_PARAM');
    expect(code).toContain('ALERT_RECIPIENT_EMAIL');
    expect(code).not.toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });

  it('month-end reminder entry keeps reminder-specific configuration isolated', async () => {
    const code = await bundleEntry('month-end-balance-reminder.ts');
    expect(code).toContain('MONTH_END_REMINDER_OWNER');
    expect(code).toContain('ALERT_RECIPIENT_EMAIL');
    expect(code).not.toContain('MONTHLY_CLOSE_MODEL_ID');
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

  it('ibkr-sync entry does not load apple-pay capture env requirements', async () => {
    const code = await bundleEntry('ibkr-sync.ts');
    expect(code).toContain('IBKR_SECRET_ARN');
    expect(code).not.toContain('APPLE_PAY_CAPTURE_SECRET_ARN');
  });

  it('keeps ingestion, retry, agent and independent verification bundles native', async () => {
    for (const entry of ['ingestion.ts', 'bedrock-email-fallback.ts', 'retry-dispatcher.ts',
      'agent-tools.ts', 'agent-tag-mutations.ts', 'agent-chat-buffered.ts', 'agent-proxy.ts',
      'dsql-read-verification.ts']) await bundleEntry(entry);
  });
});
