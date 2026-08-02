import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { defaultCuotaMinor, monthKeyInZone, replaceMsiSchedule } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { Mark } from "../components/Brand";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import {
  eventDate,
  eventMoney,
  institutionLabel,
  longDateFormatter,
  money,
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
  const [msiEnabled, setMsiEnabled] = useState(Boolean(event.msi));
  const [msiMonths, setMsiMonths] = useState(String(event.msi?.months ?? 3));
  const [msiCuota, setMsiCuota] = useState(
    ((event.msi?.cuotaMinor ?? defaultCuotaMinor(event.amount.amountMinor, event.msi?.months ?? 3)) / 100).toFixed(2),
  );

  useEffect(() => {
    setRawEmail(undefined);
    setError(undefined);
    setMsiEnabled(Boolean(event.msi));
    setMsiMonths(String(event.msi?.months ?? 3));
    setMsiCuota(
      (
        (event.msi?.cuotaMinor ??
          defaultCuotaMinor(event.amount.amountMinor, event.msi?.months ?? 3)) /
        100
      ).toFixed(2),
    );
  }, [event.id, event.msi, event.amount.amountMinor]);

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
    setMsiEnabled(Boolean(updated.msi));
    if (updated.msi) {
      setMsiMonths(String(updated.msi.months));
      setMsiCuota((updated.msi.cuotaMinor / 100).toFixed(2));
    }
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

  const msiMutation = useMutation({
    mutationFn: async () => {
      if (!msiEnabled) {
        if (demoMode) return { ...event, msi: undefined };
        return ledgerApi.updateEventMsi(event.id, { action: "clear_msi" }, idToken);
      }
      const months = Number(msiMonths);
      const cuotaMinor = Math.round(Number(msiCuota) * 100);
      if (!Number.isInteger(months) || months < 1) throw new Error("Indica un número de meses válido.");
      if (!Number.isSafeInteger(cuotaMinor) || cuotaMinor <= 0) throw new Error("Indica una cuota válida.");
      if (demoMode) {
        const startMonth = monthKeyInZone(eventDate(event));
        const plan = replaceMsiSchedule(event.msi, {
          principalMinor: event.amount.amountMinor,
          months,
          startMonth,
          origin: event.msi?.origin === "amex_auto" ? "amex_auto" : "manual",
          cuotaMinor,
        });
        return { ...event, msi: { ...plan, needsScheduleCompletion: undefined } };
      }
      if (event.msi?.needsScheduleCompletion) {
        return ledgerApi.updateEventMsi(
          event.id,
          {
            action: "complete_msi_schedule",
            months,
            cuotaMinor,
            startMonth: monthKeyInZone(eventDate(event)),
          },
          idToken,
        );
      }
      return ledgerApi.updateEventMsi(event.id, { action: "set_msi", months, cuotaMinor }, idToken);
    },
    onSuccess: updateCache,
  });

  const cancelMsiMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({
            ...event,
            msi: event.msi
              ? {
                  ...event.msi,
                  status: "cancelled" as const,
                  installments: event.msi.installments.map((item) =>
                    item.status === "committed" ? { ...item, status: "cancelled" as const } : item,
                  ),
                }
              : undefined,
          })
        : ledgerApi.updateEventMsi(event.id, { action: "cancel_msi_remaining" }, idToken),
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

  const saveMsi = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    try {
      await msiMutation.mutateAsync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el MSI.");
    }
  };

  const isApplePayCapture = event.source.kind === "apple_pay_shortcut";
  const isManualCapture = event.source.kind === "manual_entry" || event.captureSource === "manual";
  const isCsvCapture = !isApplePayCapture && !isManualCapture && event.source.contentType === "text/csv";
  const isAmexStatement = event.captureSource === "amex_statement";
  const hasRawSource =
    isManualCapture || isCsvCapture || isAmexStatement || !isApplePayCapture || event.hasRawEmail === true;
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
        : isAmexStatement
          ? "Estado de cuenta Amex"
          : "Correo original";
  const evidenceSummary = isManualCapture
    ? "Alta manual conservada"
    : isApplePayCapture
      ? "Observación automática conservada"
      : isCsvCapture
        ? "CSV original conservado"
        : isAmexStatement
          ? "Estado de cuenta conservado"
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
          {event.msi ? ` · MSI ${event.msi.months}` : ""}
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

        <form className="sheet-form" onSubmit={(formEvent) => void saveMsi(formEvent)}>
          <div className="detail-section-heading">
            <div>
              <p className="eyebrow">MESES SIN INTERESES</p>
              <h3>{event.msi?.needsScheduleCompletion ? "Completar plan MSI" : "Plan MSI"}</h3>
            </div>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={msiEnabled}
              onChange={(change) => {
                setMsiEnabled(change.target.checked);
                if (change.target.checked) {
                  const months = Number(msiMonths) || 3;
                  setMsiCuota((defaultCuotaMinor(event.amount.amountMinor, months) / 100).toFixed(2));
                }
              }}
            />
            <span>Esta compra va a MSI</span>
          </label>
          {msiEnabled && (
            <>
              <Field label="Meses">
                <input
                  inputMode="numeric"
                  value={msiMonths}
                  onChange={(change) => {
                    const value = change.target.value;
                    setMsiMonths(value);
                    const months = Number(value);
                    if (Number.isInteger(months) && months > 0) {
                      setMsiCuota((defaultCuotaMinor(event.amount.amountMinor, months) / 100).toFixed(2));
                    }
                  }}
                />
              </Field>
              <Field label="Cuota mensual">
                <div className="money-input">
                  <span>$</span>
                  <input
                    inputMode="decimal"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={msiCuota}
                    onChange={(change) => setMsiCuota(change.target.value)}
                  />
                </div>
              </Field>
              {event.msi && (
                <p className="detail-subtitle">
                  {event.msi.installments.filter((item) => item.status === "spent").length} gastadas ·{" "}
                  {event.msi.installments.filter((item) => item.status === "committed").length}{" "}
                  comprometidas
                  {event.msi.origin === "amex_auto" ? " · Amex auto" : ""}
                </p>
              )}
            </>
          )}
          <button className="primary-button" type="submit" disabled={msiMutation.isPending}>
            {msiMutation.isPending ? "Guardando…" : "Guardar MSI"}
          </button>
          {event.msi && (
            <button
              className="secondary-button"
              type="button"
              disabled={cancelMsiMutation.isPending}
              onClick={() =>
                void cancelMsiMutation.mutateAsync().catch((reason) => {
                  setError(reason instanceof Error ? reason.message : "No se pudo cancelar el MSI.");
                })
              }
            >
              Cancelar cuotas restantes
            </button>
          )}
        </form>

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
        {event.msi && (
          <div className="payment-list">
            {event.msi.installments.map((installment) => (
              <div key={installment.index} className="payment-row" style={{ cursor: "default" }}>
                <span className="date-block">
                  <small>{installment.month.slice(5)}</small>
                  <strong>{String(installment.index).padStart(2, "0")}</strong>
                </span>
                <span className="payment-name">
                  <strong>
                    MSI {installment.index}/{event.msi?.months}
                  </strong>
                  <small>{installment.status}</small>
                </span>
                <strong className="payment-amount">{money(installment.amountMinor)}</strong>
              </div>
            ))}
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
