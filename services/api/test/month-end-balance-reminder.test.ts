import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sqlRuntime from '@finance/ledger/sql-runtime';
import type { WealthBalanceOverview } from '../src/wealth/service.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';
process.env.MONTH_END_REMINDER_OWNER ??= 'owner-1';
process.env.WEB_APP_URL ??= 'https://finance.example.test';

const {
  renderMonthEndBalanceReminder,
  runMonthEndBalanceReminder,
} = await import('../src/reports/month-end-balance-reminder.js');

const overview: WealthBalanceOverview = {
  currency: 'MXN',
  asOfDay: '2026-09-30',
  totalMxnMinor: 253_000_00,
  assetsMxnMinor: 253_000_00,
  liabilitiesMxnMinor: 36_000_00,
  netMxnMinor: 217_000_00,
  accounts: [
    {
      id: 'nu_cajita_emergencia',
      name: 'Cajita Nu',
      institution: 'Nu',
      role: 'emergency_fund',
      sync: 'manual',
      connected: true,
      latestSnapshot: {
        accountId: 'nu_cajita_emergencia',
        day: '2026-09-27',
        capturedAt: '2026-09-27T18:00:00.000Z',
        source: 'manual',
        currency: 'MXN',
        totalMxnMinor: 190_000_00,
        holdings: [],
      },
    },
    {
      id: 'fondo_ahorro',
      name: 'Fondo de ahorro',
      institution: 'Nómina',
      role: 'payroll_savings',
      sync: 'derived',
      connected: true,
      latestSnapshot: {
        accountId: 'fondo_ahorro',
        day: '2026-09-30',
        capturedAt: '2026-09-30T18:00:00.000Z',
        source: 'derived',
        currency: 'MXN',
        totalMxnMinor: 57_000_00,
        holdings: [],
      },
    },
    {
      id: 'bitso',
      name: 'Bitso',
      institution: 'Bitso',
      role: 'crypto',
      sync: 'api',
      connected: true,
      latestSnapshot: {
        accountId: 'bitso',
        day: '2026-09-30',
        capturedAt: '2026-09-30T12:30:00.000Z',
        source: 'api',
        currency: 'MXN',
        totalMxnMinor: 6_000_00,
        holdings: [],
      },
    },
    {
      id: 'ibkr',
      name: 'IBKR',
      institution: 'IBKR',
      role: 'brokerage',
      sync: 'flex',
      connected: false,
      latestSnapshot: null,
    },
  ],
  liabilities: [
    {
      cardId: 'amex',
      name: 'Amex <Gold>',
      latestSnapshot: {
        cardId: 'amex',
        day: '2026-09-30',
        capturedAt: '2026-09-30T18:00:00.000Z',
        source: 'manual',
        currency: 'MXN',
        totalMxnMinor: 36_000_00,
      },
    },
  ],
};

describe('month-end balance reminder rendering', () => {
  it('lists manual balances first and distinguishes automatic sources', () => {
    const email = renderMonthEndBalanceReminder(
      overview,
      '2026-09',
      '2026-09-30',
      'https://finance.example.test',
    );

    expect(email.subject).toBe('Cierra tus saldos de Septiembre · Olbia');
    expect(email.html).toContain('Deja el mes cerrado');
    expect(email.html).toContain('1 saldo por actualizar');
    expect(email.html).toContain('1 de 2 saldos manuales capturados hoy');
    expect(email.html).toContain('Captura en este orden');
    expect(email.html).toContain('Saldo disponible · última captura 27 sep 2026');
    expect(email.html).toContain('Lo que no captures hoy se arrastrará al cierre');
    expect(email.html).toContain('Amex &lt;Gold&gt;');
    expect(email.html).not.toContain('Amex <Gold>');
    expect(email.html).toContain('Listo hoy');
    expect(email.html).toContain('Derivado de las nóminas cargadas');
    expect(email.html).toContain('Automático · actualizado hoy');
    expect(email.html).toContain('Automático · sin datos disponibles');
    expect(email.text).toContain('En tarjetas captura todo lo que debes hoy, incluyendo compras a meses sin intereses.');
    expect(email.text).toContain('Abrir Olbia y entrar a Patrimonio: https://finance.example.test');
    expect(Buffer.byteLength(email.html, 'utf8')).toBeLessThan(100_000);
  });
});

describe('month-end balance reminder orchestration', () => {
  afterEach(()=>vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    // Pure orchestration injects all providers; native worker tests exercise the persisted SQL guard.
    vi.spyOn(sqlRuntime,'assertSqlMutationsAvailable').mockResolvedValue();
  });

  it('prepares, sends, and marks one reminder for the current month', async () => {
    const prepare = vi.fn();
    const markSent = vi.fn();
    const send = vi.fn().mockResolvedValue('ses-message-1');
    const loadOverview = vi.fn().mockResolvedValue(overview);
    const now = new Date('2026-10-01T00:00:00.000Z');

    const result = await runMonthEndBalanceReminder(now, {
      getRecord: vi.fn().mockResolvedValue(undefined),
      prepare,
      markSent,
      loadOverview,
      send,
    });

    expect(result).toEqual({ month: '2026-09', status: 'sent', messageId: 'ses-message-1' });
    expect(loadOverview).toHaveBeenCalledWith('owner-1', now);
    expect(prepare).toHaveBeenCalledWith('owner-1', '2026-09', expect.objectContaining({
      asOfDay: '2026-09-30',
      email: expect.objectContaining({ subject: 'Cierra tus saldos de Septiembre · Olbia' }),
    }), now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalledWith('owner-1', '2026-09', 'ses-message-1', now);
  });

  it('does not load balances or resend after the reminder is marked sent', async () => {
    const loadOverview = vi.fn();
    const send = vi.fn();

    const result = await runMonthEndBalanceReminder(new Date('2026-10-01T00:00:00.000Z'), {
      getRecord: vi.fn().mockResolvedValue({ status: 'sent' }),
      prepare: vi.fn(),
      markSent: vi.fn(),
      loadOverview,
      send,
    });

    expect(result).toEqual({ month: '2026-09', status: 'already_sent' });
    expect(loadOverview).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
