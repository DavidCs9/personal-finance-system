import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPool, schemaHandler } from '../src/dsql/runtime.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('CloudFormation DSQL bootstrap diagnostics', () => {
  it('uses client timeouts without sending a server startup parameter', async () => {
    vi.stubEnv('DSQL_ENDPOINT', 'example.dsql.us-east-2.on.aws');
    const pool = createPool();
    const client = new Client(pool.options);
    expect((client as unknown as { getStartupConf(): object }).getStartupConf()).not.toHaveProperty('statement_timeout');
    expect(pool.options.query_timeout).toBe(20_000);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true });
    await pool.end();
  });
  it('identifies admin connection failures without exposing original message/detail', async () => {
    vi.stubEnv('DSQL_ENDPOINT', 'example.dsql.us-east-2.on.aws');
    vi.spyOn(AuroraDSQLPool.prototype, 'connect').mockRejectedValue(Object.assign(new Error('secret credential'), { code: '28000', detail: 'secret' }));
    await expect(schemaHandler({ RequestType: 'Create', ResourceProperties: {} })).rejects.toThrow('admin-connect (28000)');
    try { await schemaHandler({ RequestType: 'Create', ResourceProperties: {} }); }
    catch (error) { expect(String(error)).not.toContain('secret'); }
  });
  it('keeps the SQL statement stage and blocks capture before the runtime smoke', async () => {
    vi.stubEnv('DSQL_ENDPOINT', 'example.dsql.us-east-2.on.aws');
    const release = vi.fn();
    vi.spyOn(AuroraDSQLPool.prototype, 'connect').mockResolvedValue({ query: vi.fn(async () => { throw Object.assign(new Error('private payload'), { code: '42501' }); }), release } as never);
    const runtime = vi.spyOn(AuroraDSQLPool.prototype, 'query');
    await expect(schemaHandler({ RequestType: 'Update', PhysicalResourceId: 'existing', ResourceProperties: {} })).rejects.toThrow('native-baseline (42501)');
    expect(release).toHaveBeenCalledOnce();
    expect(runtime).not.toHaveBeenCalled();
  });
  it('distinguishes runtime IAM failures after a successful schema', async () => {
    vi.stubEnv('DSQL_ENDPOINT', 'example.dsql.us-east-2.on.aws');
    vi.spyOn(AuroraDSQLPool.prototype, 'connect').mockResolvedValue({ query: async (statement: string) => ({ rows:
      statement.includes('WHERE version=20') ? [{version:20}] : statement.includes('pg_constraint') ? [{ convalidated: true }] :
      statement.includes('indisvalid') ? [{ indisvalid: true }] : statement.includes('pg_roles') ? [{ rolname: 'olbia_projector' }] : [],
    }), release: () => {} } as never);
    vi.spyOn(AuroraDSQLPool.prototype, 'transaction').mockImplementation(async callback => callback({ query: async (s: string) =>
      ({ rows: s.includes('WHERE version=19') ? [{version:19}] : s.includes('WHERE version=18') ? [{version:18}] : s.includes('WHERE version=17') ? [{version:17}] : s.includes('WHERE version=16') ? [{version:16}] : s.includes('WHERE version=15') ? [{version:15}] : s.includes('WHERE version=14') ? [{version:14}] : s.includes('AS count FROM olbia.payroll') ? [{ count: 2 }] : [] }) } as never));
    vi.spyOn(AuroraDSQLPool.prototype, 'query').mockRejectedValue(Object.assign(new Error('private IAM detail'), { code: '28000' }));
    await expect(schemaHandler({ RequestType: 'Create', ResourceProperties: {} })).rejects.toThrow('runtime-connect-and-smoke (28000)');
  });
});
