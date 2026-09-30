import { describe, expect, it, vi } from 'vitest';
import { bootstrapSchema } from '../src/dsql/schema.js';
import type { SqlClient } from '../src/dsql/projection.js';

describe('DSQL-specific schema bootstrap', () => {
  it('waits for native indexes and maps only validated runtime ARNs with scoped SQL grants', async () => {
    const query = vi.fn(async (statement: string) => ({ rows:
      statement.startsWith('CREATE INDEX ASYNC') ? [{ job_id: 'job' }] :
      statement.includes('sys.wait_for_job') ? [{ completed: true }] :
      statement.includes('indisvalid') ? [{ indisvalid: true }] :
      statement.includes('pg_roles') ? [{ rolname: 'olbia_projector' }] : [],
    }));
    await bootstrapSchema({ query } as SqlClient, ['arn:aws:iam::225989371926:role/projector']);
    expect(query.mock.calls.filter(([statement]) => statement.includes('sys.wait_for_job'))).toHaveLength(2);
    expect(query.mock.calls.some(([statement]) => statement === "AWS IAM GRANT olbia_projector TO 'arn:aws:iam::225989371926:role/projector'")).toBe(true);
    expect(query.mock.calls.some(([statement]) => statement.includes('GRANT ALL'))).toBe(false);
    await expect(bootstrapSchema({ query } as SqlClient, ["bad' ARN"])).rejects.toThrow('Invalid runtime role ARN');
  });
  it('blocks capture bootstrap when the native index build fails', async () => {
    const query = vi.fn(async (statement: string) => ({ rows: statement.startsWith('CREATE INDEX ASYNC') ? [{ job_id: 'job' }] : statement.includes('sys.wait_for_job') ? [{ completed: false }] : [] }));
    await expect(bootstrapSchema({ query } as SqlClient, [])).rejects.toThrow('index build failed');
    expect(query.mock.calls.some(([statement]) => statement.startsWith('AWS IAM GRANT'))).toBe(false);
  });
});
