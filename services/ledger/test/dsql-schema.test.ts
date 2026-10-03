import { describe, expect, it, vi } from 'vitest';
import { bootstrapSchema as realBootstrapSchema, ensureMovementCategoryForeignKey, ensureCardLiabilityRelationships, ensureLedgerPrimaryObservation } from '../src/dsql/schema.js';
import type { SqlClient } from '../src/dsql/projection.js';

const bootstrapSchema = (client: SqlClient, roleArns: readonly string[], options: Parameters<typeof realBootstrapSchema>[2] = {}) =>
  realBootstrapSchema(client, roleArns, { transactionPool: { transaction: callback => callback({ query: (s,v) =>
    s.includes('AS count FROM olbia.payroll') ? Promise.resolve({ rows: [{ count: 2 }] }) : client.query(s,v) }) }, ...options });
const ready = (statement: string) => ({ rows:
  statement.includes('WHERE version=19') ? [{ version: 19 }] :
  statement.includes('WHERE version=18') ? [{ version: 18 }] :
  statement.includes('WHERE version=17') ? [{ version: 17 }] :
  statement.includes('WHERE version=16') ? [{ version: 16 }] :
  statement.includes('WHERE version=15') ? [{ version: 15 }] :
  statement.includes('WHERE version=14') ? [{ version: 14 }] :
  statement.includes('pg_constraint') ? [{ convalidated: true }] :
  statement.includes('indisvalid') ? [{ indisvalid: true }] :
  statement.includes('pg_roles') ? [{ rolname: 'olbia_projector' }] : [],
});
describe('DSQL-specific schema bootstrap', () => {
  it('adds a missing FK and waits for native validation before marking the migration complete', async () => {
    let polls = 0;
    const query = vi.fn(async (statement: string) => ({ rows:
      statement.includes('pg_constraint') ? (++polls === 1 ? [] : [{ convalidated: polls >= 5 }]) :
      statement.startsWith('ALTER TABLE ASYNC') ? [{ job_id: 'native-job' }] :
      statement.includes('sys.jobs') ? [{ status: 'processing' }] : [],
    }));
    const pause = vi.fn(async () => {});
    await ensureMovementCategoryForeignKey({ query } as SqlClient, { pause });
    const statements = query.mock.calls.map(([statement]) => statement);
    expect(statements.some(statement => statement.includes('ADD CONSTRAINT movements_category_fk') && statement.includes('NOT VALID'))).toBe(true);
    expect(statements).toContain('ALTER TABLE ASYNC olbia.movements VALIDATE CONSTRAINT movements_category_fk');
    expect(pause).toHaveBeenCalledWith(1_000);
    expect(statements.at(-1)).toContain('VALUES (8,');
  });
  it('resumes an unvalidated FK without adding it twice and skips already validated work', async () => {
    for (const validated of [false, true]) {
      let polls = 0;
      const query = vi.fn(async (statement: string) => ({ rows:
        statement.includes('pg_constraint') ? [{ convalidated: validated || ++polls > 1 }] :
        statement.startsWith('ALTER TABLE ASYNC') ? [{ job_id: 'resumed-job' }] : [],
      }));
      await ensureMovementCategoryForeignKey({ query } as SqlClient);
      const statements = query.mock.calls.map(([statement]) => statement);
      expect(statements.join()).not.toContain('ADD CONSTRAINT');
      expect(statements.some(statement => statement.startsWith('ALTER TABLE ASYNC'))).toBe(!validated);
    }
  });
  it('does not complete the FK migration on failed jobs, timeout or missing job identity', async () => {
    for (const status of ['failed', 'processing', 'missing']) {
      const query = vi.fn(async (statement: string) => ({ rows:
        statement.includes('pg_constraint') ? [{ convalidated: false }] :
        statement.startsWith('ALTER TABLE ASYNC') ? (status === 'missing' ? [] : [{ job_id: 'job' }]) :
        statement.includes('sys.jobs') ? [{ status }] : [],
      }));
      await expect(ensureMovementCategoryForeignKey({ query } as SqlClient, { waitMs: 0 })).rejects.toThrow(
        status === 'failed' ? 'category-fk-validation' : status === 'missing' ? 'category-fk-job' : 'category-fk-timeout');
      expect(query.mock.calls.some(([statement]) => statement.includes('VALUES (8,'))).toBe(false);
    }
  });
  it('grants reader IAM identities only SELECT on the exact read tables, with no projection or admin role membership', async () => {
    const query = vi.fn(async (statement: string) => statement.includes("rolname='olbia_reader'") ? { rows: [] } : ready(statement));
    await bootstrapSchema({ query } as SqlClient, [], { readerRoleArns: ['arn:aws:iam::225989371926:role/api-reader'] });
    const statements = query.mock.calls.map(([statement]) => statement).filter(statement => statement.includes('olbia_reader'));
    expect(statements).toContain('CREATE ROLE olbia_reader WITH LOGIN');
    expect(statements).toContain('GRANT USAGE ON SCHEMA olbia TO olbia_reader');
    expect(statements.some(s=>s.startsWith('GRANT SELECT ON olbia.ledger_movements'))).toBe(true);
    expect(statements.some(s=>s.startsWith('REVOKE ALL PRIVILEGES ON olbia.projection_state,olbia.command_receipts'))).toBe(true);
    expect(statements.join()).not.toContain('GRANT SELECT ON olbia.movements,');
    expect(statements).toContain("AWS IAM GRANT olbia_reader TO 'arn:aws:iam::225989371926:role/api-reader'");
    expect(statements.join()).not.toMatch(/GRANT (?:ALL|INSERT|UPDATE|DELETE)|olbia_projector TO/);
    await expect(bootstrapSchema({ query } as SqlClient, [], { readerRoleArns: ["unsafe' ARN"] })).rejects.toThrow('Invalid reader role ARN');
  });
  it('isolates nine operational verification grants from product readers and rejects unsafe IAM identities', async () => {
    const query = vi.fn(async (statement: string) => ready(statement));
    await bootstrapSchema({ query } as SqlClient, [], { operationalVerifierRoleArns: ['arn:aws:iam::225989371926:role/probe'] });
    const statements = query.mock.calls.map(([statement]) => statement).filter(statement => statement.includes('olbia_operational_verifier'));
    expect(statements).toContain('GRANT SELECT ON olbia.dedupe_claims,olbia.exception_claims,olbia.ingestion_exceptions,olbia.ingestion_retries,olbia.import_records,olbia.bulk_edit_operations,olbia.delivery_records,olbia.push_subscriptions,olbia.assistant_threads TO olbia_operational_verifier');
    expect(statements.join()).not.toMatch(/GRANT (?:ALL|INSERT|UPDATE|DELETE)|olbia_projector TO/);
    await expect(bootstrapSchema({ query } as SqlClient, [], { operationalVerifierRoleArns: ["unsafe' ARN"] })).rejects.toThrow('Invalid verifier role ARN');
  });
  it('waits for native readiness and maps only validated runtime ARNs with scoped SQL grants', async () => {
    let polls = 0;
    const query = vi.fn(async (statement: string) => statement.includes('indisvalid') && ++polls === 1
      ? { rows: [{ indisvalid: false }] } : statement.includes('sys.jobs') ? { rows: [{ status: 'processing' }] } : ready(statement));
    const pause = vi.fn(async () => {});
    await bootstrapSchema({ query } as SqlClient, ['arn:aws:iam::225989371926:role/projector'], { pause });
    expect(pause).toHaveBeenCalledWith(1_000);
    expect(query.mock.calls.some(([statement]) => statement.includes('sys.wait_for_job'))).toBe(false);
    expect(query.mock.calls.some(([statement]) => statement === "AWS IAM GRANT olbia_projector TO 'arn:aws:iam::225989371926:role/projector'")).toBe(true);
    expect(query.mock.calls.some(([statement]) => statement.includes('GRANT ALL'))).toBe(false);
    await expect(bootstrapSchema({ query } as SqlClient, ["bad' ARN"])).rejects.toThrow('Invalid runtime role ARN');
  });
  it('resumes an already-running index when IF NOT EXISTS returns no job ID', async () => {
    let polls = 0;
    const query = vi.fn(async (statement: string) => statement.includes('indisvalid') && ++polls < 3
      ? { rows: [{ indisvalid: false }] } : statement.includes('sys.jobs') ? { rows: [{ status: 'submitted' }] } : ready(statement));
    await bootstrapSchema({ query } as SqlClient, [], { pause: async () => {} });
    expect(query.mock.calls.filter(([statement]) => statement.includes('sys.jobs'))).toHaveLength(2);
  });
  it('blocks capture when a native build fails or exceeds its deadline', async () => {
    for (const status of ['failed', 'processing']) {
      const query = vi.fn(async (statement: string) => ({ rows: statement.includes('pg_constraint') ? [{ convalidated: true }] : statement.includes('indisvalid') ? [{ indisvalid: false }] : statement.includes('sys.jobs') ? [{ status }] : [] }));
      await expect(bootstrapSchema({ query } as SqlClient, [], { indexWaitMs: 0 })).rejects.toThrow(status === 'failed' ? 'index-build' : 'index-timeout');
      expect(query.mock.calls.some(([statement]) => statement.startsWith('AWS IAM GRANT'))).toBe(false);
    }
  });
  it('retries native catalog OCC and preserves a safe statement stage/code on failure', async () => {
    let attempts = 0;
    const pause = vi.fn(async () => {});
    const query = vi.fn(async (statement: string) => {
      if (++attempts === 1) throw Object.assign(new Error('catalog updated (OC001)'), { code: '40001' });
      return ready(statement);
    });
    await bootstrapSchema({ query } as SqlClient, [], { pause });
    expect(pause).toHaveBeenCalledWith(25);
    const failure = vi.fn(async () => { throw Object.assign(new Error('private token/value'), { code: '0A000', detail: 'private' }); });
    await expect(bootstrapSchema({ query: failure } as SqlClient, [])).rejects.toThrow('schema-statement-1 (0A000)');
    expect(failure).toHaveBeenCalledTimes(1);
    try { await bootstrapSchema({ query: failure } as SqlClient, []); }
    catch (error) { expect(String(error)).not.toContain('private'); }
  });
});

it('separates product write permissions from the authority operator and keeps envelope probes read-only',async()=>{
  const query=vi.fn(async(statement:string)=>ready(statement));
  await bootstrapSchema({query} as SqlClient,[],{applicationRoleArns:['arn:aws:iam::225989371926:role/product'],storeReaderRoleArns:['arn:aws:iam::225989371926:role/probe'],cutoverRoleArns:['arn:aws:iam::225989371926:role/operator']});
  const statements=query.mock.calls.map(([statement])=>statement);
  expect(statements.filter(statement=>statement.endsWith('TO olbia_application')).join()).not.toContain('UPDATE ON olbia.runtime_state');
  expect(statements).toContain('GRANT INSERT,UPDATE ON olbia.bank_imports TO olbia_application');
  expect(statements).toContain('GRANT INSERT,DELETE ON olbia.bank_import_rows,olbia.bank_import_candidates TO olbia_application');
  expect(statements.filter(statement=>statement.includes('bank_import') && statement.endsWith('TO olbia_application')).join()).not.toMatch(/GRANT (?:ALL|DELETE) ON olbia.bank_imports|GRANT UPDATE ON olbia.bank_import_rows/);
  expect(statements).toContain('GRANT UPDATE ON olbia.runtime_state TO olbia_cutover');
  for(const role of ['olbia_application','olbia_cutover']) {
    expect(statements).toContain(`REVOKE INSERT,DELETE ON olbia.application_barrier FROM ${role}`);
    expect(statements).toContain(`GRANT SELECT,UPDATE ON olbia.application_barrier TO ${role}`);
  }
  expect(statements.filter(statement=>statement.includes('TO olbia_store_reader')).join()).not.toMatch(/INSERT|UPDATE|DELETE/);
  expect(statements.filter(statement=>statement.includes('TO olbia_application')).join()).toContain('olbia.movement_months');
});

it('does not mark liability relationships complete until every native constraint is validated', async () => {
  const query = vi.fn(async (statement: string, values?: unknown[]) => ({ rows:
    statement.includes('pg_constraint') ? [{ convalidated: values?.[1] !== 'liability_versions_card_fk' }] :
    statement.startsWith('ALTER TABLE ASYNC') ? [{ job_id: 'card-job' }] :
    statement.includes('sys.jobs') ? [{ status: 'failed' }] : [],
  }));
  await expect(ensureCardLiabilityRelationships({ query })).rejects.toThrow('card-fk-validation');
  expect(query.mock.calls.some(([statement]) => statement.includes('VALUES (10,'))).toBe(false);
});


it('validates native primary ownership before activation and completes grants/indexes before atomic copy', async () => {
  const query = vi.fn(async (statement: string) => ready(statement));
  await bootstrapSchema({query}, [], {applicationRoleArns:['arn:aws:iam::225989371926:role/product'],readerRoleArns:['arn:aws:iam::225989371926:role/api-reader']});
  const statements = query.mock.calls.map(([statement]) => statement);
  const activation = statements.findIndex(statement => statement.includes('WHERE version=14'));
  expect(activation).toBeGreaterThan(statements.findIndex(statement => statement.includes('ledger_revisions_movement_idx')));
  expect(activation).toBeGreaterThan(statements.findIndex(statement => statement.startsWith('GRANT INSERT ON olbia.ledger_observations')));
  const wealthActivation = statements.findIndex(statement => statement.includes('WHERE version=15'));
  expect(wealthActivation).toBeGreaterThan(activation);
  expect(wealthActivation).toBeGreaterThan(statements.findIndex(statement => statement.startsWith('GRANT INSERT ON olbia.asset_captures')));
  expect(wealthActivation).toBeGreaterThan(statements.findIndex(statement => statement.startsWith('REVOKE ALL PRIVILEGES ON olbia.wealth_snapshots')));
  expect(statements).toContain('GRANT UPDATE (capture_id) ON olbia.asset_daily_captures TO olbia_application');
  expect(statements).toContain('GRANT UPDATE (capture_id) ON olbia.liability_daily_captures TO olbia_application');
  const pushActivation = statements.findIndex(statement => statement.includes('WHERE version=16'));
  expect(pushActivation).toBeGreaterThan(wealthActivation);
  expect(pushActivation).toBeGreaterThan(statements.findIndex(statement => statement.startsWith('GRANT INSERT,DELETE ON olbia.web_push_subscriptions')));
  expect(pushActivation).toBeGreaterThan(statements.findIndex(statement => statement === 'REVOKE ALL PRIVILEGES ON olbia.push_subscriptions FROM olbia_application'));
  const deliveryActivation = statements.findIndex(statement => statement.includes('WHERE version=17'));
  expect(deliveryActivation).toBeGreaterThan(pushActivation);
  expect(deliveryActivation).toBeGreaterThan(statements.findIndex(statement=>statement.startsWith('GRANT INSERT ON olbia.monthly_email_preparations')));
  expect(deliveryActivation).toBeGreaterThan(statements.findIndex(statement=>statement.startsWith('REVOKE ALL PRIVILEGES ON olbia.delivery_records')));
  const threadActivation = statements.findIndex(statement => statement.includes('WHERE version=18'));
  expect(threadActivation).toBeGreaterThan(deliveryActivation);
  expect(threadActivation).toBeGreaterThan(statements.findIndex(statement=>statement.startsWith('GRANT UPDATE (thread_id,updated_at) ON olbia.assistant_thread_selection')));
  expect(threadActivation).toBeGreaterThan(statements.findIndex(statement=>statement === 'REVOKE ALL PRIVILEGES ON olbia.assistant_threads FROM olbia_application'));
  const exceptionActivation = statements.findIndex(statement => statement.includes('WHERE version=19'));
  expect(exceptionActivation).toBeGreaterThan(threadActivation);
  expect(exceptionActivation).toBeGreaterThan(statements.findIndex(statement=>statement.startsWith('GRANT INSERT ON olbia.ingestion_review_exceptions')));
  expect(exceptionActivation).toBeGreaterThan(statements.findIndex(statement=>statement === 'REVOKE ALL PRIVILEGES ON olbia.ingestion_exceptions,olbia.exception_claims,olbia.ingestion_retries FROM olbia_application'));
  const recoveryRevoke=statements.findIndex(statement=>statement.startsWith('REVOKE ALL PRIVILEGES ON olbia.projection_state,olbia.command_receipts')&&statement.endsWith('FROM olbia_application'));
  expect(recoveryRevoke).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(recoveryRevoke);
  expect(exceptionActivation).toBeGreaterThan(statements.findIndex(statement=>statement.startsWith('REVOKE INSERT,UPDATE,DELETE ON olbia.projection_state,olbia.command_receipts')&&statement.endsWith('FROM olbia_projector')));
  expect(statements).toContain('GRANT SELECT (subscription_id,owner,content_mode,active,created_at,updated_at) ON olbia.web_push_subscriptions TO olbia_reader');
  expect(statements).toContain('GRANT UPDATE (status,applied_at,undone_at) ON olbia.ledger_bulk_operations TO olbia_application');
  const failure = vi.fn(async (statement: string) => ({ rows:
    statement.includes('pg_constraint') ? [{convalidated:false}] :
    statement.startsWith('ALTER TABLE ASYNC') ? [{job_id:'ownership-job'}] :
    statement.includes('sys.jobs') ? [{status:'failed'}] : [],
  }));
  await expect(ensureLedgerPrimaryObservation({query:failure})).rejects.toThrow('ledger-primary-validation');
  expect(failure.mock.calls.map(([statement]) => statement).join()).not.toContain('schema_migrations');
});
