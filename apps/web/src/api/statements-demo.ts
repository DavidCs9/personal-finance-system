import { buildStatementCatalog, type StatementDocument } from '@finance/domain';

const document = (id: string, provider: 'amex' | 'santander', to: string, status: StatementDocument['status'] = 'applied'): StatementDocument => ({
  provider, importId: id.repeat(64), status, createdAt: `${to}T18:00:00.000Z`,
  accountLastFour: provider === 'amex' ? '1234' : '5678',
  product: provider === 'amex' ? 'Gold' : 'Platinum',
  period: { from: `${to.slice(0, 7)}-01`, to },
});

export const mockStatementCatalog = (now: Date) => buildStatementCatalog([
  document('a', 'amex', '2026-05-06'),
  document('b', 'amex', '2026-07-06', 'previewed'),
  document('c', 'santander', '2026-05-20'),
  document('d', 'santander', '2026-06-20'),
  document('e', 'santander', '2026-06-20'),
  { provider: 'amex', importId: 'f'.repeat(64), status: 'failed', createdAt: '2026-07-09T18:00:00.000Z' },
], now);
