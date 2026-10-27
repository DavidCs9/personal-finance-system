import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dayKeyInZone } from '@finance/domain';
import type { StatementAccountCoverage, StatementCatalog, StatementCycle, StatementDocument, StatementProvider } from '@finance/domain';
import { ledgerApi } from '../api/client';
import { mockStatementCatalog } from '../api/statements-demo';
import { Sheet } from '../components/Sheet';
import { statementsQueryKey } from '../lib/query-keys';
import { monthKeyLabel } from '../lib/format';

const providerLabel = (provider: StatementProvider) => provider === 'amex' ? 'Amex' : 'Santander';
const dayLabel = (day: string) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const statusLabel = { processing: 'En lectura', previewed: 'Por aplicar', applied: 'Aplicado', failed: 'Error de lectura' } as const;

type CatalogActions = {
  readonly onImport: (provider: StatementProvider, importId?: string) => void;
  readonly onSource: (document: StatementDocument) => void;
  readonly openingSource?: string;
};

/** Actual document periods stay visible separately from estimated missing cuts. */
export function StatementCatalogContent({ data, onImport, onSource, openingSource }: { readonly data: StatementCatalog } & CatalogActions) {
  const cycles = data.accounts.flatMap(account => account.cycles);
  const missingCount = cycles.filter(cycle => cycle.status === 'missing').length;
  const files = cycles.reduce((sum, cycle) => sum + cycle.documents.length, data.unidentifiedDocuments.length);
  const byMonth = new Map<string, { account: StatementAccountCoverage; cycle: StatementCycle }[]>();
  for (const account of data.accounts) {
    for (const cycle of account.cycles) {
      const rows = byMonth.get(cycle.month) ?? [];
      rows.push({ account, cycle });
      byMonth.set(cycle.month, rows);
    }
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a));
  const fileRow = (document: StatementDocument, index: number) => <div className="statement-file" key={`${document.provider}-${document.importId}`}>
    <div>
      <strong>{statusLabel[document.status]}{index > 0 ? ' · archivo adicional' : ''}</strong>
      <small>{document.period ? `${dayLabel(document.period.from)} – ${dayLabel(document.period.to)}` : 'Tarjeta o periodo aún sin identificar'}</small>
      <small>Registrado {dayLabel(dayKeyInZone(new Date(document.createdAt)))}</small>
    </div>
    <div className="statement-file-actions">
      <button type="button" className="text-button" disabled={Boolean(openingSource)} onClick={() => onSource(document)}>
        {openingSource === `${document.provider}:${document.importId}` ? 'Abriendo…' : 'Ver PDF'}
      </button>
      {document.status !== 'applied' ? <button type="button" className="text-button"
        onClick={() => onImport(document.provider, document.status === 'failed' ? undefined : document.importId)}>
        {document.status === 'failed' ? 'Volver a subir' : document.status === 'processing' ? 'Consultar lectura' : 'Continuar conciliación'}
      </button> : null}
    </div>
  </div>;
  return <>
    <div className="statement-overview">
      <strong>{files} {files === 1 ? 'PDF registrado' : 'PDF registrados'}</strong>
      <span>{!files ? 'Sin estados registrados' : !data.accounts.length ? 'Cobertura aún sin identificar' : missingCount ? `${missingCount} ${missingCount === 1 ? 'corte sin archivo identificado' : 'cortes sin archivo identificado'}` : data.unidentifiedDocuments.length ? 'Cobertura por confirmar: hay PDF por identificar' : 'Sin huecos desde el primer corte registrado'}</span>
      <small>Revisión al {dayLabel(data.asOfDay)} · todas las fechas, independiente del mes seleccionado</small>
    </div>
    <p className="sheet-lede">Cada archivo conserva su periodo y estado de conciliación. Aplicado significa que procesaste ese PDF; no confirma que todos tus gastos estén conciliados.</p>
    <div className="statement-upload-actions">
      <button type="button" className="secondary-button" onClick={() => onImport('amex')}>Subir Amex</button>
      <button type="button" className="secondary-button" onClick={() => onImport('santander')}>Subir Santander</button>
    </div>
    {!files ? <p>Aún no tienes estados de cuenta registrados. Sube el primer PDF de cada tarjeta para empezar a ver su cobertura.</p> : null}
    {data.unidentifiedDocuments.length ? <details className="statement-unidentified">
      <summary><span><strong>Archivos por identificar</strong><small>Podrían cubrir alguno de los huecos</small></span><span>{data.unidentifiedDocuments.length}</span></summary>
      <p>Estos PDF están registrados, pero aún no tienen tarjeta o periodo identificado. Podrían cubrir alguno de los huecos de abajo.</p>
      {data.unidentifiedDocuments.map((document) => <div key={`${document.provider}-${document.importId}`}>
        <p className="eyebrow">{providerLabel(document.provider)}{document.accountLastFour ? ` · ${document.accountLastFour}` : ''}</p>
        {fileRow(document, 0)}
      </div>)}
    </details> : null}
    {months.map(([month, rows]) => {
      const missing = rows.filter(({ cycle }) => cycle.status === 'missing').length;
      const registered = rows.length - missing;
      return <section className="statement-month" key={month}>
        <header><h3>{monthKeyLabel(month)}</h3>
          <p>{registered} {registered === 1 ? 'corte con PDF' : 'cortes con PDF'} · {missing ? `${missing} ${missing === 1 ? 'faltante' : 'faltantes'}` : 'Sin cortes faltantes estimados'}</p>
        </header>
        {rows.map(({ account, cycle }) => <details className={`statement-cycle ${cycle.status}`} key={`${account.provider}:${account.accountLastFour}`} open={cycle.status === 'missing'}>
          <summary>
            <span><strong>{providerLabel(account.provider)} · {account.accountLastFour}</strong>
              {account.product ? <small>{account.product}</small> : null}
              <small>{cycle.documents.length ? `${cycle.documents.length} ${cycle.documents.length === 1 ? 'archivo' : 'archivos'}${cycle.documents.length > 1 ? ' · cobertura de un solo mes' : ''}` : `Corte esperado ${dayLabel(cycle.expectedCut)}`}</small>
            </span>
            <span className="statement-cycle-status">{cycle.status === 'missing' ? 'Falta' : cycle.status === 'applied' ? 'Aplicado' : 'Por conciliar'}<span aria-hidden="true">⌄</span></span>
          </summary>
          <div className="statement-cycle-detail">{cycle.documents.length ? cycle.documents.map(fileRow) : <>
            <p>No hay un PDF identificado para este corte.</p>
            <button type="button" className="text-button" onClick={() => onImport(account.provider)}>Subir {providerLabel(account.provider)}</button>
          </>}</div>
        </details>)}
      </section>;
    })}
    {data.accounts.length ? <details className="statement-coverage">
      <summary>Cómo se estiman los cortes faltantes</summary>
      <p className="statement-coverage-note">Sólo se evalúan cortes anteriores a hoy, desde el primer PDF de cada tarjeta. Los archivos por identificar podrían cubrir huecos.</p>
      {data.accounts.map(account => <div key={`${account.provider}:${account.accountLastFour}`}>
        <strong>{providerLabel(account.provider)} · {account.accountLastFour}</strong>
        <p className="statement-coverage-note">Desde el corte del {dayLabel(account.firstCut)}. Cortes faltantes estimados con el día {account.expectedCutDay}, según el último PDF; pueden cambiar. No se evalúan fechas anteriores ni cortes de hoy o futuros.</p>
      </div>)}
    </details> : null}
    <p className="statement-coverage-note">Sólo estados de cuenta PDF registrados en Olbia. Un CSV o un aviso de compra no cubre un corte. Subir distintas versiones del mismo mes no amplía la cobertura.</p>
  </>;
}

export function StatementsSheet({ idToken, demoMode, now, onClose, onImport }: {
  readonly idToken: string;
  readonly demoMode: boolean;
  readonly now: Date;
  readonly onClose: () => void;
} & Pick<CatalogActions, 'onImport'>) {
  const [openingSource, setOpeningSource] = useState<string>();
  const [sourceError, setSourceError] = useState<string>();
  const query = useQuery({ queryKey: statementsQueryKey, refetchOnMount: "always", refetchOnWindowFocus: true, refetchOnReconnect: true, queryFn: () => demoMode
    ? Promise.resolve(mockStatementCatalog(now)) : ledgerApi.statements(idToken) });
  const openSource = async (document: StatementDocument) => {
    if (demoMode) { setSourceError('Los PDF originales están disponibles al iniciar sesión.'); return; }
    setOpeningSource(`${document.provider}:${document.importId}`); setSourceError(undefined);
    try {
      const source = await ledgerApi.statementSource(document.provider, document.importId, idToken);
      window.location.assign(source.url);
    } catch { setSourceError('No pudimos abrir el PDF original. Intenta de nuevo.'); }
    finally { setOpeningSource(undefined); }
  };
  return <Sheet title="Estados de cuenta" eyebrow="TUS ARCHIVOS Y CORTES" onClose={onClose} className="statements-sheet">
    {sourceError ? <p role="alert">{sourceError}</p> : null}
    {query.isPending ? <p role="status">Consultando tus estados de cuenta…</p> : query.isError ? <div role="alert">
      <p>No pudimos consultar tus estados de cuenta. La cobertura no está disponible.</p>
      <button type="button" className="secondary-button" onClick={() => void query.refetch()}>Reintentar</button>
    </div> : query.data ? <StatementCatalogContent data={query.data} onImport={onImport} onSource={document => void openSource(document)} openingSource={openingSource} /> : null}
  </Sheet>;
}
