import { useState } from "react";
import { computeMonthSummary, monthKeyInZone } from "@finance/domain";
import { RecoveryNotice } from "../components/RecoveryNotice";
import {
  dateFormatter,
  eventDate,
  eventMoney,
  institutionLabel,
  money,
  statusLabel,
} from "../lib/format";
import { CaptureActionsSheet } from "../sheets/CaptureActionsSheet";
import { RecoveryReviewSheet } from "../sheets/RecoveryReviewSheet";
import type { IngestionException, PurchaseEvent } from "../types";

export function MovementsView({
  events,
  exceptions,
  loading,
  sort,
  onSortChange,
  onOpen,
  onRetryException,
  onDiscardException,
  onReadExceptionRaw,
  onImport,
  onImportAmex,
  onRegisterCharge,
}: {
  events: readonly PurchaseEvent[];
  exceptions: readonly IngestionException[];
  loading: boolean;
  sort: "recent" | "largest";
  onSortChange(value: "recent" | "largest"): void;
  onOpen(event: PurchaseEvent): void;
  onRetryException(id: string): Promise<void>;
  onDiscardException(id: string): Promise<void>;
  onReadExceptionRaw(id: string): Promise<string>;
  onImport(): void;
  onImportAmex(): void;
  onRegisterCharge(): void;
}) {
  const [activeException, setActiveException] = useState<IngestionException>();
  const [captureOpen, setCaptureOpen] = useState(false);
  const sorted = [...events].sort((a, b) =>
    sort === "largest"
      ? b.amount.amountMinor - a.amount.amountMinor
      : eventDate(b).getTime() - eventDate(a).getTime(),
  );
  const month = events[0] ? monthKeyInZone(eventDate(events[0])) : monthKeyInZone(new Date());
  const total = computeMonthSummary({
    events: events.map((event) => ({
      amountMinor: event.amount.amountMinor,
      status: event.status,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      merchantRaw: event.merchantRaw,
      msi: event.msi,
    })),
    month,
    incomeMinor: 0,
    incomeConfigured: false,
    upcomingPaymentsMinor: 0,
    now: new Date(),
  }).spentMinor;

  return (
    <section className="movements-view">
      <header className="movements-heading">
        <div>
          <p className="eyebrow">TRAZABILIDAD</p>
          <h1>Movimientos</h1>
          <p>
            {events.length} registros · {money(total)}
          </p>
        </div>
        <div className="movement-actions">
          <button
            type="button"
            className="secondary-button import-button"
            onClick={() => setCaptureOpen(true)}
          >
            Añadir
          </button>
          <label className="sort-control">
            <span>Ordenar</span>
            <select
              value={sort}
              onChange={(event) => onSortChange(event.target.value as "recent" | "largest")}
            >
              <option value="recent">Más recientes</option>
              <option value="largest">Mayor gasto</option>
            </select>
          </label>
        </div>
      </header>
      {captureOpen && (
        <CaptureActionsSheet
          onClose={() => setCaptureOpen(false)}
          onRegisterCharge={() => {
            setCaptureOpen(false);
            onRegisterCharge();
          }}
          onImport={() => {
            setCaptureOpen(false);
            onImport();
          }}
          onImportAmex={() => {
            setCaptureOpen(false);
            onImportAmex();
          }}
        />
      )}
      {exceptions.length > 0 && (
        <details className="recovery-section">
          <summary>
            <span>Correos por revisar</span>
            <small>{exceptions.length}</small>
          </summary>
          <div>
            {exceptions.map((exception) => (
              <RecoveryNotice
                key={exception.id}
                exception={exception}
                onReview={() => setActiveException(exception)}
              />
            ))}
          </div>
        </details>
      )}
      <div className="movement-list">
        {sorted.map((event) => (
          <button className="movement-row" key={event.id} onClick={() => onOpen(event)}>
            <span className={`movement-icon ${event.status}`} aria-hidden="true">
              {event.status === "needs_review" ? "!" : event.merchantRaw.slice(0, 1)}
            </span>
            <span className="movement-main">
              <strong>
                {event.merchantRaw}
                {event.msi ? <span className="msi-badge">MSI {event.msi.months}</span> : null}
              </strong>
              <small>
                {institutionLabel(event.institution)} · {dateFormatter.format(eventDate(event))}
                {event.msi?.needsScheduleCompletion ? " · sin plan" : ""}
              </small>
            </span>
            <span className="movement-value">
              <strong>{eventMoney(event)}</strong>
              <small className={event.status}>{statusLabel[event.status]}</small>
            </span>
            <span className="chevron">›</span>
          </button>
        ))}
        {!loading && sorted.length === 0 && (
          <div className="empty-state">
            <span>—</span>
            <h2>No hay movimientos</h2>
            <p>Cuando llegue una alerta bancaria, aparecerá aquí.</p>
          </div>
        )}
        {loading && (
          <div className="empty-state">
            <p>Cargando movimientos…</p>
          </div>
        )}
      </div>
      {activeException && (
        <RecoveryReviewSheet
          exception={activeException}
          onClose={() => setActiveException(undefined)}
          onRetry={() => onRetryException(activeException.id)}
          onDiscard={() => onDiscardException(activeException.id)}
          onReadRaw={() => onReadExceptionRaw(activeException.id)}
        />
      )}
    </section>
  );
}
