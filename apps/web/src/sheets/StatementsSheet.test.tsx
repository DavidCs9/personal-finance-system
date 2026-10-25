import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { buildStatementCatalog, type StatementDocument } from '@finance/domain';
import { mockStatementCatalog } from '../api/statements-demo';
import { StatementCatalogContent, StatementsSheet } from './StatementsSheet';
import { statementsQueryKey } from '../lib/query-keys';
const now = new Date('2026-07-12T18:00:00-06:00');
const renderContent = (data = mockStatementCatalog(now)) => renderToStaticMarkup(createElement(StatementCatalogContent, { data, onImport() {}, onSource() {} }));

describe('statement coverage presentation', () => {
  it('separates missing cuts, applied files, pending reconciliation, duplicates and unidentified failures', () => {
    const html = renderContent();
    for (const copy of ['6 PDF registrados', '1 corte sin archivo identificado', 'Por aplicar', 'Aplicado', 'Falta',
      'Error de lectura', 'Archivos por identificar', 'cobertura de un solo mes', 'Continuar conciliación', 'Ver PDF',
      'Cortes faltantes estimados', 'no confirma que todos tus gastos estén conciliados', 'Subir Amex', 'Subir Santander']) expect(html).toContain(copy);
    expect(html).not.toContain('evidence_bucket');
  });
  it('does not claim completeness for an empty catalog or one with only unidentified files', () => {
    const html = renderContent(buildStatementCatalog([], now));
    expect(html).toContain('Aún no tienes estados de cuenta registrados');
    expect(html).toContain('Sin estados registrados');
    const pending: StatementDocument = { importId: 'a', provider: 'amex', createdAt: now.toISOString(), status: 'processing' };
    const unidentified = renderContent(buildStatementCatalog([pending], now));
    expect(unidentified).toContain('Cobertura aún sin identificar');
    expect(unidentified).toContain('En lectura');
    expect(unidentified).not.toContain('Sin huecos');
    const known = { ...pending, importId: 'b', status: 'applied' as const, accountLastFour: '1234', period: { from: '2026-07-01', to: '2026-07-06' } };
    const partiallyIdentified = renderContent(buildStatementCatalog([pending, known], now));
    expect(partiallyIdentified).toContain('Cobertura por confirmar');
    expect(partiallyIdentified).not.toContain('Sin huecos');
  });
  it('shows honest loading and hides stale coverage when refetch fails', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(StatementsSheet, { idToken: 'test', demoMode: true, now, onClose() {}, onImport() {} })));
    expect(render()).toContain('Consultando tus estados de cuenta');
    client.setQueryData(statementsQueryKey, mockStatementCatalog(now));
    client.getQueryCache().find({ queryKey: statementsQueryKey })!.setState({ status: 'error', error: new Error('offline') });
    const html = render();
    expect(html).toContain('La cobertura no está disponible');
    expect(html).toContain('Reintentar');
    expect(html).not.toContain('6 PDF registrados');
  });
});
