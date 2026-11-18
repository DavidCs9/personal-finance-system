import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { nativeFixture } from './fixtures/native-ledger.js';
import { NATIVE_LEDGER_TABLES } from '../../ledger/src/dsql/ledger-schema.js';
import { NATIVE_PLANNING_TABLES } from '../../ledger/src/dsql/planning-schema.js';
import { NATIVE_FINANCIAL_PLAN_SCHEMA_STATEMENTS, NATIVE_FINANCIAL_PLAN_TABLES } from '../../ledger/src/dsql/financial-plan-schema.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool, s3: vi.fn() }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
vi.mock('../src/http/clients.js', () => ({ rawSourceBucketName: 'test-evidence', s3: { send: harness.s3 } }));
const service = await import('../src/financial-plans/service.js');
const { runAgentTool } = await import('../src/agent/tools.js');
const { handler: writeHandler } = await import('../src/agent/financial-write-tools-handler.js');
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let failBeforeCommit = false, failAfterCommit = false;
const now = new Date('2026-11-18T02:00:00Z');
const salary = { action: 'create', name: 'Future salary', employer: 'Employer', amountMxnMinor: 69228_00,
  frequency: 'monthly', paymentDays: [30], startDate: '2026-11-23', confidence: 'estimated' };
const wedding = { action: 'create_goal', name: 'Personal wedding commitment', totalBudgetMxnMinor: 400000_00, allocations: [
  { name: 'Planner', allocatedMxnMinor: 65000_00 }, { name: 'Remaining contribution', allocatedMxnMinor: 85000_00 },
  { name: 'Honeymoon', allocatedMxnMinor: 200000_00 }, { name: 'Dress', allocatedMxnMinor: 50000_00 },
] };
const preview = (kind: 'income' | 'goal' | 'manual_charge', input: Record<string, unknown>, owner = 'owner') => service.previewFinancialChange(owner, kind, input);
const apply = (operationId: unknown, owner = 'owner') => service.applyFinancialChange(owner, operationId);
const createGoal = async () => {
  const op = await preview('goal', wedding); const result = await apply(op.operationId);
  return result.goal as Awaited<ReturnType<typeof service.getFinancialGoal>>;
};
const takeSnapshot = async () => Object.fromEntries(await Promise.all(NATIVE_FINANCIAL_PLAN_TABLES.filter(table => table !== 'financial_write_operations' && table !== 'financial_change_receipts')
  .map(async table => [table, (await fixture.sql.query(`SELECT * FROM olbia.${table} ORDER BY 1`)).rows])));
beforeAll(async () => {
  fixture = await nativeFixture();
  for (const statement of NATIVE_FINANCIAL_PLAN_SCHEMA_STATEMENTS) await fixture.sql.query(statement);
  harness.pool = { query: fixture.pool.query, transaction: async fn => {
    const result = await fixture.pool.transaction(async client => {
      const value = await fn(client);
      if (failBeforeCommit) { failBeforeCommit = false; throw new Error('Interrupted before commit'); }
      return value;
    });
    if (failAfterCommit) { failAfterCommit = false; throw new Error('Interrupted after commit'); }
    return result;
  } };
}, 30_000);
afterAll(async () => { await fixture.sql.close(); });
beforeEach(async () => {
  await fixture.sql.exec(`TRUNCATE ${[...NATIVE_FINANCIAL_PLAN_TABLES, ...NATIVE_LEDGER_TABLES, ...NATIVE_PLANNING_TABLES,
    'ingestion_retry_attempts', 'projection_state', 'command_receipts', 'merchant_rules', 'bank_imports', 'bank_import_rows',
    'bank_import_candidates', 'category_lifecycle', 'category_catalog_changes', 'payslip_lines', 'payslips', 'payroll_closures'].map(table => `olbia.${table}`).join(',')}`);
  await fixture.sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.clearAllMocks(); harness.s3.mockResolvedValue({}); failBeforeCommit = false; failAfterCommit = false;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubEnv('AGENT_OWNER', 'owner');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('shared SQL financial planning service', () => {
  it('previews without business mutations; applies authentic income once, then reads the same record through MCP', async () => {
    const before = await takeSnapshot();
    const op = await preview('income', salary);
    expect(await takeSnapshot()).toEqual(before);
    expect(await service.getFinancialWriteStatus('owner', op.operationId)).toMatchObject({ status: 'pending', kind: 'income' });
    const first = await apply(op.operationId);
    expect(await apply(op.operationId)).toEqual(first);
    const income = first.income as { id: string };
    expect(await runAgentTool('owner', 'get_expected_income', { incomeId: income.id, fromMonth: '2026-11', toMonth: '2027-02' }))
      .toMatchObject({ sources: [{ id: income.id, amountMxnMinor: 69228_00, revision: 1 }], occurrences: [
        { paymentDate: '2026-11-30' }, { paymentDate: '2026-12-30' }, { paymentDate: '2027-01-30' }, { paymentDate: '2027-02-28' }],
      history: [{ operationId: op.operationId, action: 'create' }] });
    expect((await fixture.sql.query('SELECT operation_id FROM olbia.financial_change_receipts')).rows).toHaveLength(1);
    expect(harness.s3).not.toHaveBeenCalled();
  });
  it('keeps payroll actuals and expected occurrences separate and explicitly exposes unresolved overlap', async () => {
    const op = await preview('income', salary); await apply(op.operationId);
    const id = '11111111-1111-4111-8111-111111111111';
    await fixture.sql.query(`INSERT INTO olbia.payslips
      (uuid,owner,paid_on,payroll_type,total_mxn_minor,perceptions_mxn_minor,deductions_mxn_minor,other_payments_mxn_minor,employer_name,ingested_at,evidence_bucket,evidence_key,evidence_sha256,evidence_content_type)
      VALUES ($1,'owner','2026-11-30','O',6922800,6922800,0,0,'Employer',$2,'SECRET','SECRET',$3,'application/xml')`, [id, now.toISOString(), 'a'.repeat(64)]);
    const result = await service.listExpectedIncome('owner', { fromMonth: '2026-11', toMonth: '2026-12' });
    expect(result).toMatchObject({ monthlyTotals: [
      { month: '2026-11', expectedScheduledMxnMinor: 69228_00, actualPayrollMxnMinor: 69228_00, remainingExpectedMxnMinor: null,
        combinedActualAndExpectedMxnMinor: null, overlapStatus: 'unresolved_payroll_overlap' },
      { month: '2026-12', actualPayrollMxnMinor: 0, remainingExpectedMxnMinor: 69228_00, combinedActualAndExpectedMxnMinor: null },
    ] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('creates the wedding in one transaction, supports payment corrections/voids, and preserves immutable before/after receipts', async () => {
    const goal = await createGoal();
    const planner = goal.allocations.find(item => item.name === 'Planner')!;
    const op = await preview('goal', { action: 'record_payment', goalId: goal.id, expectedRevision: goal.revision,
      allocationId: planner.id, expectedAllocationRevision: planner.revision,
      payment: { source: 'manual_attestation', paymentDate: '2026-11-17', amountMxnMinor: 65000_00 } });
    const first = await apply(op.operationId);
    expect(await apply(op.operationId)).toEqual(first);
    const paid = await service.getFinancialGoal('owner', goal.id);
    expect(paid).toMatchObject({ originalBudgetMxnMinor: 400000_00, allocatedMxnMinor: 400000_00, paidMxnMinor: 65000_00, remainingMxnMinor: 335000_00 });
    const payment = paid.payments[0]!;
    const correction = await preview('goal', { action: 'correct_payment', goalId: goal.id, expectedRevision: paid.revision,
      paymentId: payment.id, expectedPaymentRevision: payment.revision, expectedAllocationRevision: planner.revision,
      reason: 'Correct amount', payment: { amountMxnMinor: 60000_00 } });
    await apply(correction.operationId);
    const voidOp = await preview('goal', { action: 'void_payment', goalId: goal.id, expectedRevision: paid.revision + 1,
      paymentId: payment.id, expectedPaymentRevision: payment.revision + 1, reason: 'Not a payment' });
    await apply(voidOp.operationId);
    expect(await service.getFinancialGoal('owner', goal.id)).toMatchObject({ paidMxnMinor: 0, remainingMxnMinor: 400000_00,
      payments: [{ id: payment.id, status: 'voided', revision: 3 }] });
    const receipt = (await fixture.sql.query('SELECT before_state,after_state FROM olbia.financial_change_receipts WHERE operation_id=$1', [correction.operationId])).rows[0]!;
    expect(receipt).toMatchObject({ before_state: { payments: [{ amountMxnMinor: 65000_00 }] }, after_state: { payments: [{ amountMxnMinor: 60000_00 }] } });
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([]);
    expect((await fixture.sql.query('SELECT id FROM olbia.asset_captures')).rows).toEqual([]);
  });
  it('links a real movement once across all goals and rejects changed evidence before apply', async () => {
    const movementId = await fixture.create({ amount: { amountMinor: 10000, currency: 'MXN' }, occurredAt: '2026-11-17T18:00:00Z' });
    const first = await createGoal(), second = await createGoal();
    const allocation = first.allocations[0]!;
    const op = await preview('goal', { action: 'record_payment', goalId: first.id, expectedRevision: first.revision,
      allocationId: allocation.id, expectedAllocationRevision: allocation.revision,
      payment: { source: 'linked_ledger_movement', ledgerMovementId: movementId, paymentDate: '2026-11-17', amountMxnMinor: 10000 } });
    await fixture.sql.query("UPDATE olbia.ledger_movements SET status='rejected' WHERE id=$1", [movementId]);
    await expect(apply(op.operationId)).rejects.toThrow(/movimiento/);
    expect(await service.getFinancialWriteStatus('owner', op.operationId)).toMatchObject({ status: 'failed' });
    await fixture.sql.query("UPDATE olbia.ledger_movements SET status='accepted' WHERE id=$1", [movementId]);
    const fresh = await preview('goal', { action: 'record_payment', goalId: first.id, expectedRevision: first.revision,
      allocationId: allocation.id, expectedAllocationRevision: allocation.revision,
      payment: { source: 'linked_ledger_movement', ledgerMovementId: movementId, paymentDate: '2026-11-17', amountMxnMinor: 10000 } });
    await apply(fresh.operationId);
    await expect(preview('goal', { action: 'record_payment', goalId: second.id, expectedRevision: second.revision,
      allocationId: second.allocations[0]!.id, expectedAllocationRevision: second.allocations[0]!.revision,
      payment: { source: 'linked_ledger_movement', ledgerMovementId: movementId, paymentDate: '2026-11-17', amountMxnMinor: 10000 } })).rejects.toThrow(/otro pago/);
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
  });
  it('rejects cross-owner access, invented IDs and expired previews without changing business records', async () => {
    const op = await preview('income', salary);
    await expect(apply(op.operationId, 'other-owner')).rejects.toThrow(/no encontrada/);
    expect(await service.getFinancialWriteStatus('other-owner', op.operationId)).toMatchObject({ status: 'not_found' });
    await expect(apply('not-a-uuid')).rejects.toThrow(/UUID/);
    vi.setSystemTime(new Date(now.getTime() + 16 * 60_000));
    expect(await service.getFinancialWriteStatus('owner', op.operationId)).toMatchObject({ status: 'expired' });
    await expect(apply(op.operationId)).rejects.toThrow(/expiró/);
    expect((await fixture.sql.query('SELECT id FROM olbia.expected_income')).rows).toEqual([]);
    const goal = await createGoal();
    await expect(service.getFinancialGoal('other-owner', goal.id)).rejects.toThrow(/no encontrada/);
    await expect(preview('goal', { action: 'archive_goal', goalId: goal.id, expectedRevision: 1 }, 'other-owner')).rejects.toThrow(/no encontrada/);
  });
  it('conflicts when a concurrent preview was superseded, and recovers unknown commit outcomes without duplicates', async () => {
    const goal = await createGoal();
    const first = await preview('goal', { action: 'update_goal', goalId: goal.id, expectedRevision: 1, name: 'First' });
    const second = await preview('goal', { action: 'update_goal', goalId: goal.id, expectedRevision: 1, name: 'Second' });
    await apply(first.operationId);
    await expect(apply(second.operationId)).rejects.toThrow(/cambiaron/);
    expect(await service.getFinancialWriteStatus('owner', second.operationId)).toMatchObject({ status: 'failed' });
    const income = await preview('income', salary);
    failAfterCommit = true;
    await expect(apply(income.operationId)).rejects.toThrow('Interrupted after commit');
    expect(await service.getFinancialWriteStatus('owner', income.operationId)).toMatchObject({ status: 'applied' });
    await apply(income.operationId);
    expect((await fixture.sql.query('SELECT id FROM olbia.expected_income')).rows).toHaveLength(1);
    const rollback = await preview('income', { ...salary, name: 'Other' });
    failBeforeCommit = true;
    await expect(apply(rollback.operationId)).rejects.toThrow('Interrupted before commit');
    expect(await service.getFinancialWriteStatus('owner', rollback.operationId)).toMatchObject({ status: 'pending' });
    await apply(rollback.operationId);
    expect((await fixture.sql.query('SELECT id FROM olbia.expected_income')).rows).toHaveLength(2);
  });
  it('registers a manual charge through the canonical service, with original evidence outside SQL retries and atomic receipt', async () => {
    const input = { institution: 'american_express_mx', merchantRaw: 'Observed charge', amountMinor: 300000,
      currency: 'MXN', occurredOn: '2026-11-17', note: 'Owner note' };
    const op = await preview('manual_charge', input);
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([]);
    expect(harness.s3).not.toHaveBeenCalled();
    const result = await apply(op.operationId);
    expect(result).toMatchObject({ movement: { amountMinor: 300000, currency: 'MXN', occurredOn: '2026-11-17', msi: { months: 3 } } });
    expect(await apply(op.operationId)).toEqual(result);
    expect(harness.s3).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/evidence|source|Owner note/);
    const duplicate = await preview('manual_charge', input); await apply(duplicate.operationId);
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
    expect(harness.s3).toHaveBeenCalledTimes(1);
  });
  it('preserves business name arguments and configured owner through native Gateway dispatch', async () => {
    const context = { clientContext: { custom: { bedrockAgentCoreToolName: 'olbia-financial-writes___preview_income_change' } } } as never;
    const op = await writeHandler({ ...salary, owner: 'untrusted' }, context) as { operationId: string };
    expect((await fixture.sql.query('SELECT owner,after_state FROM olbia.financial_write_operations WHERE operation_id=$1', [op.operationId])).rows[0])
      .toMatchObject({ owner: 'owner', after_state: { name: 'Future salary' } });
    expect(await writeHandler({ toolName: 'apply_income_change', operationId: op.operationId }, {} as never)).toMatchObject({ status: 'applied' });
  });
  it('paginates income sources and keeps actual payroll totals explicitly independent from page totals', async () => {
    for (let index = 0; index < 3; index++) { const op = await preview('income', { ...salary, name: `Source ${index}` }); await apply(op.operationId); }
    const first = await service.listExpectedIncome('owner', { limit: 2, fromMonth: '2026-12', toMonth: '2026-12' });
    const second = await service.listExpectedIncome('owner', { limit: 2, cursor: first.nextCursor, fromMonth: '2026-12', toMonth: '2026-12' });
    expect(first.sources).toHaveLength(2); expect(second.sources).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.sources, ...second.sources].map(item => item.id)).size).toBe(3);
    expect(first).toMatchObject({ expectedTotalsScope: 'returned_sources', actualPayrollScope: 'owner_month_range_do_not_sum_across_pages' });
  });
});

it('modifies expected salary/calendar and archives/restores through actual SQL with immutable receipts', async () => {
  const created = await preview('income', salary); const first = await apply(created.operationId);
  const income = first.income as { id: string; revision: number };
  const update = await preview('income', { action: 'update', incomeId: income.id, expectedRevision: 1,
    amountMxnMinor: 35000_00, frequency: 'semimonthly', paymentDays: [15, 30], endDate: '2027-06-30' });
  await apply(update.operationId);
  expect(await service.getExpectedIncome('owner', income.id, { fromMonth: '2027-02', toMonth: '2027-02' }))
    .toMatchObject({ sources: [{ amountMxnMinor: 35000_00, frequency: 'semimonthly', revision: 2 }],
      occurrences: [{ paymentDate: '2027-02-15' }, { paymentDate: '2027-02-28' }] });
  const archive = await preview('income', { action: 'archive', incomeId: income.id, expectedRevision: 2 });
  await apply(archive.operationId);
  expect(await service.getExpectedIncome('owner', income.id)).toMatchObject({ sources: [{ status: 'archived', revision: 3 }], occurrences: [] });
  const restore = await preview('income', { action: 'restore', incomeId: income.id, expectedRevision: 3 });
  await apply(restore.operationId);
  expect(await service.getExpectedIncome('owner', income.id)).toMatchObject({ sources: [{ status: 'active', revision: 4 }], history: expect.any(Array) });
});

it('applies using its granted writer role without requiring olbia_reader membership', async () => {
  const readers = await import('../src/events/sql-reads.js');
  const op = await preview('income', salary);
  vi.spyOn(readers, 'readerPool').mockImplementation(() => { throw new Error('No reader-role grant on bounded writer'); });
  expect(await apply(op.operationId)).toMatchObject({ status: 'applied' });
  expect(await apply(op.operationId)).toMatchObject({ status: 'applied' });
});

it('previews and applies business-day payroll and audited monthly exceptions through the existing MCP tools', async () => {
  const { paymentDays: _legacyDays, ...base } = salary;
  const args = { ...base, amountMxnMinor: 25000_00, frequency: 'semimonthly',
    paymentRules: [{ kind: 'previous_business_day', day: 15 }, { kind: 'last_business_day' }] };
  const call = (name: string, arguments_: Record<string, unknown>) => writeHandler({ toolName: name, arguments: arguments_ }, {} as never);
  const draft = await call('preview_income_change', args) as Awaited<ReturnType<typeof service.previewFinancialChange>>;
  expect(await takeSnapshot()).toMatchObject({ expected_income: [], expected_income_month_overrides: [] });
  const saved = await call('apply_income_change', { operationId: draft.operationId }) as Awaited<ReturnType<typeof service.applyFinancialChange>>;
  const income = saved.income as { id: string; revision: number };
  expect(await call('apply_income_change', { operationId: draft.operationId })).toEqual(saved);
  const read = () => runAgentTool('owner', 'get_expected_income', { incomeId: income.id, fromMonth: '2026-11', toMonth: '2026-12' });
  expect(await read()).toMatchObject({
    occurrences: [{ periodMonth: '2026-11', paymentDate: null, amountMxnMinor: null },
      { paymentDate: '2026-12-15', amountMxnMinor: 25000_00 }, { paymentDate: '2026-12-31', amountMxnMinor: 25000_00 }],
    actualPayroll: [],
    monthlyTotals: [{ month: '2026-11', expectedScheduledMxnMinor: null, unknownExpectedOccurrences: 1, remainingExpectedMxnMinor: null },
      { month: '2026-12', expectedScheduledMxnMinor: 50000_00, unknownExpectedOccurrences: 0 }],
  });
  const update = { action: 'update', incomeId: income.id, expectedRevision: income.revision };
  const override = await preview('income', { ...update,
    monthOverride: { month: '2026-11', paymentDate: '2026-11-27', amountMxnMinor: 12000_00, reason: 'Employer estimate' } });
  const stale = await preview('income', { ...update, monthOverride: { month: '2026-11', amountMxnMinor: 0, reason: 'No payment' } });
  expect((await fixture.sql.query('SELECT * FROM olbia.expected_income_month_overrides')).rows).toEqual([]);
  await apply(override.operationId);
  await expect(apply(stale.operationId)).rejects.toThrow(/cambió/);
  await expect(service.getExpectedIncome('other-owner', income.id)).rejects.toThrow(/no encontrado/);
  expect(await read()).toMatchObject({ actualPayroll: [], history: expect.arrayContaining([{ operationId: override.operationId, action: 'update', appliedAt: expect.any(String) }]),
    monthlyTotals: [{ month: '2026-11', expectedScheduledMxnMinor: 12000_00 }, { month: '2026-12', expectedScheduledMxnMinor: 50000_00 }] });
  const clear = await preview('income', { ...update, expectedRevision: 2, clearMonthOverride: '2026-11' });
  await apply(clear.operationId);
  expect(await read()).toMatchObject({ monthlyTotals: [{ expectedScheduledMxnMinor: null }, { expectedScheduledMxnMinor: 50000_00 }] });
});

describe('MCP reconciliation uses the shared SQL and dashboard authority', () => {
  it('previews an inherited fixed expense without materializing it, applies once and updates both dashboard reads', async () => {
    const { saveMonthlyPlan } = await import('../src/months/service.js');
    const { monthSnapshot } = await import('../src/agent/aggregates.js');
    const fixed = { id: 'membership', name: 'Membership', amountMinor: 720_00, dueDay: 9 };
    await saveMonthlyPlan('owner', '2026-10', { currency: 'MXN', upcomingPayments: [fixed] });
    const id = await fixture.create({ merchantRaw: 'Membership', occurredAt: '2026-11-09T18:00:00Z',
      amount: { amountMinor: 720_00, currency: 'MXN' } });
    const config = await service.previewFinancialChange('owner', 'budget', { action: 'set_recurring', month: '2026-11', totalMxnMinor: 2_000_00 });
    await apply(config.operationId);
    const before = await monthSnapshot('owner', '2026-11');
    expect(before.budget).toMatchObject({ countedSpentMxnMinor: 720_00, upcomingFixedMxnMinor: 720_00,
      reconciledFixedProgrammingMxnMinor: 0, remainingDiscretionaryMxnMinor: 560_00 });
    const op = await service.previewFinancialChange('owner', 'fixed_reconciliation', {
      action: 'link', month: '2026-11', paymentId: fixed.id, expectedPayment: fixed, eventId: id, reason: 'Confirmed merchant charge',
    });
    expect((await fixture.sql.query('SELECT month FROM olbia.month_plans')).rows).toEqual([{ month: '2026-10' }]);
    expect(await monthSnapshot('owner', '2026-11')).toEqual(before);
    await expect(service.applyFinancialChange('other', op.operationId, 'fixed_reconciliation')).rejects.toThrow(/no encontrada/);
    failAfterCommit = true;
    await expect(service.applyFinancialChange('owner', op.operationId, 'fixed_reconciliation')).rejects.toThrow(/after commit/);
    const first = await service.applyFinancialChange('owner', op.operationId, 'fixed_reconciliation');
    expect(await service.applyFinancialChange('owner', op.operationId, 'fixed_reconciliation')).toEqual(first);
    expect((await fixture.sql.query('SELECT * FROM olbia.planned_payment_charge_revisions')).rows).toHaveLength(1);
    const after = await runAgentTool('owner', 'month_snapshot', { month: '2026-11' });
    expect(after).toEqual(await monthSnapshot('owner', '2026-11'));
    expect(after).toMatchObject({
      budget: { countedSpentMxnMinor: 720_00, countedFixedSpendMxnMinor: 720_00, upcomingFixedMxnMinor: 0,
        reconciledFixedProgrammingMxnMinor: 720_00, remainingDiscretionaryMxnMinor: 1_280_00 },
      summary: { spentMinor: 720_00, billUpcomingMinor: 0 },
      liquidity: { status: 'missing', remainingMinor: null, projectedSpendMinor: null },
    });
    expect(await runAgentTool('owner', 'get_month_details', { month: '2026-11' })).toMatchObject({
      upcomingPayments: [{ id: fixed.id, linkedMovementId: id, effectiveReconciliation: true }],
    });
  });

  it('uses the literal Santander installment on one existing movement, with source retention and replay protection', async () => {
    const occurredAt = '2026-11-09T18:00:00Z';
    const row = { merchantRaw: 'Shop', occurredAt, amount: { amountMinor: 367_97, currency: 'MXN' },
      account: { institution: 'santander_mx', lastFour: '1234' } };
    const id = await fixture.create(row);
    const duplicateCandidate = await fixture.create(row);
    const importId = 'f'.repeat(64);
    await fixture.sql.query(`INSERT INTO olbia.bank_imports
      (kind,content_sha256,owner,status,created_at,applied_at,account_last_four,product,period_start,period_end,
      evidence_bucket,evidence_key,evidence_content_type,result_created,result_linked,result_skipped)
      VALUES ('santander_statement',$1,'owner','applied',$2,$2,'1234','Card','2026-11-01','2026-11-30',
      'originals','statement-key','application/pdf',0,0,1)`, [importId, now.toISOString()]);
    await fixture.sql.query(`INSERT INTO olbia.bank_import_rows
      (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,row_kind,
      installment_index,installment_months,original_amount_mxn_minor)
      VALUES ('santander_statement',$1,0,'bank-installment','2026-11-09','Shop',12266,'skipped','msi',1,3,36797)`, [importId]);
    const read = (movementId: string) => runAgentTool('owner', 'get_msi_reconciliation', { month: '2026-11', movementId }) as
      Promise<{ movements: { expectedRevision: string }[]; bankRows: { bankRow: Record<string, unknown> }[] }>;
    const current = await read(id);
    expect(current.bankRows[0]).toMatchObject({ amountMxnMinor: 122_66, originalAmountMxnMinor: 367_97 });
    const input = { action: 'correct_schedule', movementId: id, expectedRevision: current.movements[0]!.expectedRevision,
      bankRow: current.bankRows[0]!.bankRow, reason: 'Bank statement confirms the installment' };
    const op = await service.previewFinancialChange('owner', 'msi_reconciliation', input);
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_plans')).rows).toEqual([]);
    failBeforeCommit = true;
    await expect(service.applyFinancialChange('owner', op.operationId, 'msi_reconciliation')).rejects.toThrow(/before commit/);
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_plans')).rows).toEqual([]);
    const receipt = await service.applyFinancialChange('owner', op.operationId, 'msi_reconciliation');
    expect(await service.applyFinancialChange('owner', op.operationId, 'msi_reconciliation')).toEqual(receipt);
    expect(receipt).toMatchObject({ movementId: id, plan: { principalMinor: 367_97, cuotaMinor: 122_66, months: 3,
      installments: [{ index: 1, amountMinor: 122_66, status: 'spent', occurredOn: '2026-11-09' },
        { index: 2, status: 'committed' }, { index: 3, status: 'committed' }] } });
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(2);
    expect((await fixture.sql.query('SELECT movement_id,evidence_row_position FROM olbia.installment_entries WHERE evidence_origin=\'bank_row\'')).rows)
      .toEqual([{ movement_id: id, evidence_row_position: 0 }]);
    expect((await fixture.sql.query('SELECT token FROM olbia.source_claims')).rows).toHaveLength(1);
    expect((await fixture.sql.query('SELECT operation_id FROM olbia.financial_change_receipts')).rows).toHaveLength(1);
    const duplicate = await read(duplicateCandidate);
    await expect(service.previewFinancialChange('owner', 'msi_reconciliation', {
      ...input, movementId: duplicateCandidate, expectedRevision: duplicate.movements[0]!.expectedRevision,
    })).rejects.toThrow(/asociada a otro movimiento/);
    await expect(service.previewFinancialChange('owner', 'msi_reconciliation', input)).rejects.toThrow(/cambió/);
    expect(await runAgentTool('owner', 'month_snapshot', { month: '2026-11' })).toMatchObject({
      budget: { countedSpentMxnMinor: 490_63, countedMsiSpendMxnMinor: 122_66, upcomingMsiMxnMinor: 0 },
    });
  });
});
