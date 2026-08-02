import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ledgerApi } from "../api/client";
import { Mark } from "../components/Brand";
import { Sheet } from "../components/Sheet";
import {
  eventDate,
  eventMoney,
  institutionLabel,
  longDateFormatter,
  statusLabel,
} from "../lib/format";
import { eventsQueryKey } from "../lib/query-keys";
import type { PurchaseEvent } from "../types";

export function EventSheet({
  event,
  idToken,
  demoMode,
  onClose,
  onVerified,
}: {
  event: PurchaseEvent;
  idToken: string;
  demoMode: boolean;
  onClose(): void;
  onVerified(event: PurchaseEvent): void;
}) {
  const queryClient = useQueryClient();
  const [rawEmail, setRawEmail] = useState<string>();
  const [error, setError] = useState<string>();

  const updateCache = (updated: PurchaseEvent) => {
    queryClient.setQueryData<{ events: readonly PurchaseEvent[] }>(eventsQueryKey, (current) =>
      current
        ? {
            ...current,
            events: current.events.map((item) => (item.id === updated.id ? updated : item)),
          }
        : current,
    );
    void queryClient.invalidateQueries({ queryKey: eventsQueryKey });
    onVerified(updated);
  };

  const verifyMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({ ...event, status: "accepted" as const, parseWarnings: [] })
        : ledgerApi.markVerified(event.id, idToken),
    onSuccess: updateCache,
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({ ...event, status: "rejected" as const })
        : ledgerApi.markRejected(event.id, idToken),
    onSuccess: updateCache,
  });

  const toggleRaw = async () => {
    if (rawEmail) {
      setRawEmail(undefined);
      return;
    }
    try {
      setRawEmail(demoMode ? event.rawEmail : await ledgerApi.rawEmail(event.id, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo leer la fuente.");
    }
  };

  const verify = async () => {
    try {
      await verifyMutation.mutateAsync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo actualizar el movimiento.");
    }
  };

  const reject = async () => {
    try {
      await rejectMutation.mutateAsync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo rechazar el movimiento.");
    }
  };

  const isApplePayCapture = event.source.kind === "apple_pay_shortcut";
  const isManualCapture = event.source.kind === "manual_entry" || event.captureSource === "manual";
  const isCsvCapture = !isApplePayCapture && !isManualCapture && event.source.contentType === "text/csv";
  const hasRawSource = isManualCapture || isCsvCapture || !isApplePayCapture || event.hasRawEmail === true;
  const sources = event.captureSources ?? (event.captureSource ? [event.captureSource] : []);
  const hasLinkedEmail = sources.includes("email") || event.hasRawEmail === true;
  const evidenceTitle = isManualCapture
    ? hasLinkedEmail
      ? "Registro manual · también correo"
      : "Registro manual"
    : isApplePayCapture
      ? "Captura de Apple Pay"
      : isCsvCapture
        ? "CSV de Santander"
        : "Correo original";
  const evidenceSummary = isManualCapture
    ? "Alta manual conservada"
    : isApplePayCapture
      ? "Observación automática conservada"
      : isCsvCapture
        ? "CSV original conservado"
        : "Mensaje original conservado";
  const evidenceDetail = isApplePayCapture
    ? event.source.cardRaw
    : "key" in event.source
      ? event.source.key
      : event.id;

  return (
    <Sheet eyebrow="MOVIMIENTO OBSERVADO" title={event.merchantRaw} onClose={onClose}>
      <div className="event-detail">
        <div className="detail-amount">
          <strong>{eventMoney(event)}</strong>
          <span className={`status ${event.status}`}>{statusLabel[event.status]}</span>
        </div>
        <p className="detail-subtitle">
          {institutionLabel(event.institution)} · {event.accountName}
        </p>
        {event.parseWarnings.length > 0 && (
          <div className="warning">
            <span>!</span>
            <div>
              <strong>Necesita confirmación</strong>
              <p>{event.parseWarnings[0]}</p>
            </div>
            <button onClick={verify}>Confirmar</button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <dl className="facts">
          <div>
            <dt>Fecha de compra</dt>
            <dd>{longDateFormatter.format(eventDate(event))}</dd>
          </div>
          <div>
            <dt>Procesado</dt>
            <dd>{longDateFormatter.format(new Date(event.ingestedAt))}</dd>
          </div>
          <div>
            <dt>Parser</dt>
            <dd>{event.parserVersion}</dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>{statusLabel[event.status]}</dd>
          </div>
        </dl>
        <div className="detail-section-heading">
          <div>
            <p className="eyebrow">EVIDENCIA</p>
            <h3>{evidenceTitle}</h3>
          </div>
          {hasRawSource && (
            <button className="secondary-button" onClick={toggleRaw}>
              {rawEmail ? "Ocultar" : isApplePayCapture ? "Ver correo" : "Ver fuente"}
            </button>
          )}
        </div>
        {rawEmail ? (
          <pre className="raw-source">{rawEmail}</pre>
        ) : (
          <div className="source-summary">
            <Mark />
            <div>
              <strong>{evidenceSummary}</strong>
              <p>{evidenceDetail}</p>
            </div>
          </div>
        )}
        {event.status !== "rejected" && (
          <button
            className="delete-button"
            type="button"
            disabled={rejectMutation.isPending}
            onClick={() => void reject()}
          >
            {rejectMutation.isPending ? "Rechazando…" : "No cuenta en el mes"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
