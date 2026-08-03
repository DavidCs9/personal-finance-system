import { useState } from "react";
import { Amt } from "../components/Amt";
import { RecoveryNotice } from "../components/RecoveryNotice";
import {
  dateFormatter,
  eventDate,
  institutionLabel,
  money,
  movementAmountMinor,
  movementMoney,
  statusLabel,
} from "../lib/format";
import { CaptureActionsSheet } from "../sheets/CaptureActionsSheet";
import { RecoveryReviewSheet } from "../sheets/RecoveryReviewSheet";
import type { IngestionException, PurchaseEvent } from "../types";

export function MovementsView({
  events,
  month,
  spentMinor,
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
  onImportSantanderStatement,
  onRegisterCharge,
}: {
  events: readonly PurchaseEvent[];
  /** Selected calendar month (YYYY-MM); MSI rows show that month's cuota. */
  month: string;
  /** Month spend including MSI cuotas whose purchase may live in another month. */
  spentMinor: number;
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
  onImportSantanderStatement(): void;
  onRegisterCharge(): void;
}) {
  const [activeException, setActiveException] = useState<IngestionException>();
  const [captureOpen, setCaptureOpen] = useState(false);
  const sorted = [...events].sort((a, b) =>
    sort === "largest"
      ? movementAmountMinor(b, month) - movementAmountMinor(a, month)
      : eventDate(b).getTime() - eventDate(a).getTime(),
  );

  return (
    <section className="movements-view">
      <header className="movements-heading">
        <div>
          <p className="eyebrow">TRAZABILIDAD</p>
          <h1>Movimientos</h1>
          <p>
            {events.length} registros · <Amt>{money(spentMinor)}</Amt>
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
          onImportSantanderStatement={() => {
            setCaptureOpen(false);
            onImportSantanderStatement();
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
                {event.msi ? (
                  <span className="msi-badge">
                    {(() => {
                      const installment = event.msi.installments.find((item) => item.month === month);
                      return installment
                        ? `MSI ${installment.index}/${event.msi.months}`
                        : `MSI ${event.msi.months}`;
                    })()}
                  </span>
                ) : null}
              </strong>
              <small>
                {institutionLabel(event.institution)} · {dateFormatter.format(eventDate(event))}
                {event.msi?.needsScheduleCompletion ? " · sin plan" : ""}
              </small>
            </span>
            <span className="movement-value">
              <strong>
                <Amt>{movementMoney(event, month)}</Amt>
              </strong>
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
