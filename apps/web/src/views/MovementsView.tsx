import { useState } from "react";
import { Amt } from "../components/Amt";
import { RecoveryNotice } from "../components/RecoveryNotice";
import {
  eventDateLabel,
  eventRecencyKey,
  institutionLabel,
  money,
  movementAmountMinor,
  movementMoney,
  statusLabel,
  visibleMovementEvents,
} from "../lib/format";
import { CaptureActionsSheet } from "../sheets/CaptureActionsSheet";
import { RecoveryReviewSheet } from "../sheets/RecoveryReviewSheet";
import type { IngestionException, PurchaseEvent } from "../types";

const normalizeSearchText = (value: string): string => value
  .normalize("NFD")
  .replace(/\p{M}/gu, "")
  .toLocaleLowerCase("es")
  .trim();

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
  evidenceFilter,
  onClearEvidenceFilter,
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
  evidenceFilter?: { readonly label: string; readonly eventIds: readonly string[] };
  onClearEvidenceFilter(): void;
}) {
  const [activeException, setActiveException] = useState<IngestionException>();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const visibleEvents = visibleMovementEvents(events);
  const availableTags = [...new Set(visibleEvents.flatMap((event) => event.tags ?? []))]
    .sort((left, right) => left.localeCompare(right, "es"));
  const searchNeedle = normalizeSearchText(searchTerm);
  const filteredEvents = visibleEvents.filter((event) => {
    if (evidenceFilter && !evidenceFilter.eventIds.includes(event.id)) return false;
    if (tagFilter && !event.tags?.includes(tagFilter)) return false;
    if (!searchNeedle) return true;
    const searchable = normalizeSearchText([
      event.merchantRaw,
      event.accountName,
      institutionLabel(event.institution),
      event.categoryId ?? "Sin categoría",
      ...(event.tags ?? []),
      statusLabel[event.status],
      eventDateLabel(event),
      movementMoney(event, month),
    ].join(" "));
    return searchable.includes(searchNeedle);
  });
  const filtersActive = Boolean(evidenceFilter || tagFilter || searchNeedle);
  const sorted = [...filteredEvents].sort((a, b) =>
    sort === "largest"
      ? movementAmountMinor(b, month) - movementAmountMinor(a, month)
      : eventRecencyKey(b).localeCompare(eventRecencyKey(a)),
  );

  return (
    <section className="movements-view">
      <header className="movements-heading">
        <div>
          <p className="eyebrow">TRAZABILIDAD</p>
          <h1>Movimientos</h1>
          <p>
            {filtersActive ? `${filteredEvents.length} de ${visibleEvents.length}` : visibleEvents.length} registros · <Amt>{money(spentMinor)}</Amt>
          </p>
        </div>
        <button
          type="button"
          className="secondary-button import-button"
          onClick={() => setCaptureOpen(true)}
        >
          Añadir
        </button>
        <div className="movement-toolbar" aria-label="Filtros de movimientos">
          <label className="movement-search">
            <span>Buscar</span>
            <span className="movement-search-field">
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Comercio, categoría o tag"
                autoComplete="off"
                spellCheck="false"
              />
              {searchTerm && (
                <button type="button" aria-label="Limpiar búsqueda" onClick={() => setSearchTerm("")}>
                  ×
                </button>
              )}
            </span>
          </label>
          <label className="sort-control">
            <span>Tag</span>
            <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
              <option value="">Todos</option>
              {availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
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
        {evidenceFilter ? (
          <div className="movement-evidence-filter">
            <span>Viendo evidencia de <strong>{evidenceFilter.label}</strong></span>
            <button type="button" onClick={onClearEvidenceFilter}>Ver todos</button>
          </div>
        ) : null}
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
              {event.status === "needs_review" || event.status === "pending_foreign"
                ? "!"
                : event.merchantRaw.slice(0, 1)}
            </span>
            <span className="movement-main">
              <strong>{event.merchantRaw}</strong>
              <small>
                {institutionLabel(event.institution)} · {eventDateLabel(event)}
                {event.msi?.needsScheduleCompletion ? " · sin plan" : ""}
              </small>
              <span className="movement-context">
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
                <span className="category-badge">
                  {event.categoryId ?? "Sin categoría"}
                </span>
              </span>
              {(event.tags ?? []).length > 0 && (
                <span className="movement-tagline" aria-label={`Tags: ${(event.tags ?? []).join(", ")}`}>
                  {(event.tags ?? []).slice(0, 1).map((tag) => (
                    <span className="movement-tag" key={tag}>#{tag}</span>
                  ))}
                  {(event.tags ?? []).length > 1 && (
                    <span className="movement-tag-more">+{(event.tags ?? []).length - 1}</span>
                  )}
                </span>
              )}
            </span>
            <span className="movement-value">
              <strong>
                <Amt>{movementMoney(event, month)}</Amt>
              </strong>
              <small className={event.status}>
                {event.personalAmountMinor !== undefined
                  ? `Mi parte · de ${money(event.amount.amountMinor)} pagados`
                  : statusLabel[event.status]}
              </small>
            </span>
            <span className="chevron">›</span>
          </button>
        ))}
        {!loading && sorted.length === 0 && (
          <div className="empty-state">
            <span>—</span>
            <h2>{filtersActive ? "Sin resultados" : "No hay movimientos"}</h2>
            <p>
              {filtersActive
                ? "Prueba otro comercio, categoría o tag."
                : "Cuando llegue una alerta bancaria, aparecerá aquí."}
            </p>
            {filtersActive && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSearchTerm("");
                  setTagFilter("");
                  onClearEvidenceFilter();
                }}
              >
                Limpiar filtros
              </button>
            )}
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
