import { describe, expect, it } from 'vitest';
import { buildStatementCatalog, type StatementDocument } from './statement-catalog.js';

let id = 0;
const pdf = (to: string, overrides: Partial<StatementDocument> = {}): StatementDocument => ({
  provider: 'amex', importId: String(++id), status: 'applied', createdAt: `${to}T18:00:00.000Z`,
  accountLastFour: '1234', product: 'Gold', period: { from: `${to.slice(0, 7)}-01`, to }, ...overrides,
});
const now = new Date('2026-10-25T01:00:00Z'); // October 24 in Chihuahua.

describe('registered statement coverage', () => {
  it('finds elapsed gaps from the first statement and keeps duplicate versions in one covered month', () => {
    const documents = [pdf('2026-05-06'), pdf('2026-06-06'), pdf('2026-07-06'), pdf('2026-08-06'), pdf('2026-08-06')];
    const original = structuredClone(documents);
    const catalog = buildStatementCatalog(documents, now);
    expect(catalog.asOfDay).toBe('2026-10-24');
    const cycles = catalog.accounts[0]!.cycles;
    expect(cycles.filter(c => c.status === 'missing').map(c => c.expectedCut)).toEqual(['2026-10-06', '2026-09-06']);
    expect(cycles).toHaveLength(6);
    expect(cycles.find(c => c.month === '2026-08')?.documents).toHaveLength(2);
    expect(documents).toEqual(original);
  });
  it('keeps issuers and observed cards separate even when last four match', () => {
    const catalog = buildStatementCatalog([pdf('2026-09-22'), pdf('2026-09-22', { provider: 'santander' }), pdf('2026-09-06', { accountLastFour: '5678' })], now);
    expect(catalog.accounts).toHaveLength(3);
    expect(catalog.accounts.map(a => a.cycles.filter(c => c.status === 'missing').map(c => c.expectedCut)))
      .toEqual([['2026-10-22'], ['2026-10-06'], ['2026-10-22']]);
  });
  it('does not call a registered preview or failed PDF absent, or imply it was applied', () => {
    const catalog = buildStatementCatalog([pdf('2026-08-06', { status: 'previewed' }), pdf('2026-09-06', { status: 'failed' }),
      pdf('2026-10-06', { status: 'applied' }), pdf('2026-10-06', { status: 'processing' })], now);
    expect(catalog.accounts[0]!.cycles.map(c => c.status)).toEqual(['applied', 'registered', 'registered']);
  });
  it('retains every unidentified import without inventing card or period relationships', () => {
    const files = [pdf('2026-10-06', { status: 'processing', period: undefined }),
      pdf('2026-10-06', { status: 'failed', accountLastFour: undefined })];
    const catalog = buildStatementCatalog(files, now);
    expect(catalog.accounts).toEqual([]);
    expect(catalog.unidentifiedDocuments).toHaveLength(2);
  });
  it('uses Chihuahua day and waits until after the cut, including month-end clamping', () => {
    const documents = [pdf('2028-01-31')];
    expect(buildStatementCatalog(documents, new Date('2028-02-29T05:59:00Z')).accounts[0]!.cycles).toHaveLength(1);
    expect(buildStatementCatalog(documents, new Date('2028-03-01T05:59:00Z')).accounts[0]!.cycles).toHaveLength(1);
    const cycles = buildStatementCatalog(documents, new Date('2028-03-01T06:01:00Z')).accounts[0]!.cycles;
    expect(cycles[0]).toMatchObject({ expectedCut: '2028-02-29', status: 'missing' });
    expect(cycles).toHaveLength(2); // March cut still in the future.
  });
  it('keeps actual date precision when a cycle day changes and makes no gaps before the first cut', () => {
    const catalog = buildStatementCatalog([pdf('2026-09-20'), pdf('2026-10-22')], now);
    expect(catalog.accounts[0]).toMatchObject({ firstCut: '2026-09-20', latestCut: '2026-10-22', expectedCutDay: 22 });
    expect(catalog.accounts[0]!.cycles.map(c => c.documents[0]!.period!.to)).toEqual(['2026-10-22', '2026-09-20']);
  });
  it('returns an empty catalog honestly', () => {
    expect(buildStatementCatalog([], now)).toEqual({ asOfDay: '2026-10-24', accounts: [], unidentifiedDocuments: [] });
  });
});
