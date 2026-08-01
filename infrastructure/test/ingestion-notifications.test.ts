import { describe, expect, it } from 'vitest';
import { ingestionExceptionAlert } from '../lambda/ingestion-notifications.js';

describe('ingestionExceptionAlert', () => {
  it('explains a parser failure without including banking data', () => {
    const alert = ingestionExceptionAlert({
      id: 'exception-123',
      institution: 'nu_mx',
      reason: 'parser_failed',
      details: 'Nu MX outgoing-transfer alert is missing completed status',
      receivedAt: '2026-08-01T22:07:01.094Z',
      source: { bucket: 'encrypted-raw-email', key: 'inbound/message-123' },
    });

    expect(alert.subject).toBe('Movimiento requiere revisión: nu_mx');
    expect(alert.body).toContain('Motivo: parser_failed');
    expect(alert.body).toContain('ID de excepción: exception-123');
    expect(alert.body).toContain('s3://encrypted-raw-email/inbound/message-123');
    expect(alert.body).not.toMatch(/monto|clabe|destinatario/i);
  });

  it('labels an unsupported source with no identified institution', () => {
    const alert = ingestionExceptionAlert({
      id: 'exception-456',
      reason: 'unsupported_source',
      details: 'No configured parser accepted this SES-received email.',
      receivedAt: '2026-08-01T22:08:00.000Z',
      source: { bucket: 'encrypted-raw-email', key: 'inbound/message-456' },
    });

    expect(alert.subject).toBe('Movimiento requiere revisión: origen desconocido');
    expect(alert.body).toContain('Institución: no identificada');
  });
});
