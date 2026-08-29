import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';

const send = vi.fn();
const listCards = vi.fn();
const listPayslipsForYear = vi.fn();

vi.mock('../src/http/clients.js', () => ({
  database: { send },
  s3: { send: vi.fn() },
  tableName: 'test-metadata',
  rawSourceBucketName: 'test-raw-email',
}));
vi.mock('../src/cards/cards.js', () => ({
  isValidCardId: vi.fn().mockReturnValue(true),
  listCards,
}));
vi.mock('../src/imports/cfdi-nomina-flow.js', () => ({ listPayslipsForYear }));

const { getWealthOverviewAsOf } = await import('../src/wealth/service.js');

const wealthItem = (accountId: string, day: string, amountMinor: number) => ({
  accountId,
  day,
  capturedAt: `${day}T12:00:00.000Z`,
  source: accountId === 'ibkr' ? 'flex' : 'manual',
  totalMxnMinor: amountMinor,
  holdings: [],
});

const liabilityItem = (day: string, amountMinor: number) => ({
  cardId: 'amex',
  day,
  capturedAt: `${day}T12:00:00.000Z`,
  source: 'manual',
  totalMxnMinor: amountMinor,
});

const fondoPayslip = (fechaPago: string, amountMinor: number) => ({
  uuid: fechaPago,
  fechaPago,
  month: fechaPago.slice(0, 7),
  tipoNomina: 'O',
  totalMinor: 10_000_00,
  totalPercepcionesMinor: 12_000_00,
  totalDeduccionesMinor: 2_000_00,
  totalOtrosPagosMinor: 0,
  lines: [{ kind: 'deduccion', tipo: '004', clave: 'FONDO', concepto: 'Fondo', amountMinor, group: 'fondo' }],
});

describe('historical wealth overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCards.mockResolvedValue([{ id: 'amex', name: 'Amex', cutOffDay: 10, paymentDueDay: 28, createdAt: '', updatedAt: '' }]);
    listPayslipsForYear.mockResolvedValue([
      fondoPayslip('2026-08-15', 5_000_00),
      fondoPayslip('2026-09-01', 7_000_00),
    ]);
    send.mockImplementation(async (command: { input?: { ExpressionAttributeValues?: Record<string, string> } }) => {
      const prefix = command.input?.ExpressionAttributeValues?.[':sk'];
      if (prefix === 'WEALTH_SNAP#') {
        return { Items: [
          wealthItem('ibkr', '2026-08-30', 100_000_00),
          wealthItem('ibkr', '2026-09-01', 120_000_00),
          wealthItem('nu_cajita_emergencia', '2026-08-20', 50_000_00),
        ] };
      }
      if (prefix === 'LIAB_SNAP#') {
        return { Items: [liabilityItem('2026-08-31', 10_000_00), liabilityItem('2026-09-01', 20_000_00)] };
      }
      throw new Error(`Unexpected database command prefix ${prefix}`);
    });
  });

  it('carries balances forward to month end and excludes first-day snapshots and payslips', async () => {
    const overview = await getWealthOverviewAsOf('owner-1', '2026-08-31');

    expect(overview.asOfDay).toBe('2026-08-31');
    expect(overview.accounts.find((account) => account.id === 'ibkr')?.latestSnapshot).toMatchObject({
      day: '2026-08-30',
      totalMxnMinor: 100_000_00,
    });
    expect(overview.accounts.find((account) => account.id === 'fondo_ahorro')?.latestSnapshot).toMatchObject({
      day: '2026-08-31',
      totalMxnMinor: 5_000_00,
    });
    expect(overview.assetsMxnMinor).toBe(155_000_00);
    expect(overview.liabilitiesMxnMinor).toBe(10_000_00);
    expect(overview.netMxnMinor).toBe(145_000_00);
  });
});
