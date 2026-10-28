import { useEffect, useRef, useState } from "react";
import type { PlannedPayment } from "../monthly-plan";
import type { PurchaseEvent } from "../types";
import { monthKey, monthKeyLabel, timeZone } from "../lib/format";
import { Amt } from "./Amt";

export type ObservedEvent = PurchaseEvent;
const mxn = (minor: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(minor / 100);
const dayLabel = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone }).format(date)
    : "Fecha no disponible";
};
const eventAmount = (event: ObservedEvent) => event.personalAmountMinor ?? event.amount.amountMinor;
const chargeDate = (event: ObservedEvent) => new Date(event.occurredAt ?? event.receivedAt);

/** Eligibility is defensive; the server still validates the current movement at confirmation. */
export const eligibleReconciliationEvents = (events: readonly ObservedEvent[], month: string): readonly ObservedEvent[] =>
  events.filter(event => {
    const date = chargeDate(event);
    const gross = event.amount.amountMinor;
    const personal = eventAmount(event);
    return Boolean(event.id.trim()) && (event.status === "accepted" || event.status === "needs_review")
      && event.amount.currency === "MXN" && !event.msi && Number.isFinite(date.getTime())
      && monthKey(date) === month && Number.isSafeInteger(gross) && gross > 0
      && Number.isSafeInteger(personal) && personal >= 0 && personal <= gross;
  });

export function PaymentReconciliationConfirmation({ payment, month, event, unlink = false, busy, disabled = false, onConfirm, onCancel }: {
  readonly payment: PlannedPayment;
  readonly month: string;
  readonly event?: ObservedEvent;
  readonly unlink?: boolean;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onConfirm: (eventId: string | null) => void;
  readonly onCancel: () => void;
}) {
  return <section className="payment-reconciliation-confirmation" aria-label={unlink ? "Confirmar desvínculo" : "Confirmar vínculo"}>
    <h3>{unlink ? "Desvincular este cobro" : "Vincular este cobro"}</h3>
    <p><strong>{payment.name}</strong> · {monthKeyLabel(month)} · programado <Amt>{mxn(payment.amountMinor)}</Amt>.</p>
    {unlink ? <p>El cobro se conserva. Este fijo quedará por conciliar en este mes.</p> : event ? <>
      <p>Cobro: <strong>{event.merchantRaw}</strong> · {dayLabel(chargeDate(event).toISOString())}.</p>
      <p>Mi parte: <Amt>{mxn(eventAmount(event))}</Amt> · bruto bancario: <Amt>{mxn(event.amount.amountMinor)}</Amt>.</p>
      <p>Vincularás todo el fijo de este mes a este cobro. El gasto del cobro se conserva y el fijo dejará de sumarse como compromiso por conciliar.</p>
      {eventAmount(event) !== payment.amountMinor ? <p className="payment-reconciliation-warning">Los importes son distintos. El vínculo cubre todo el fijo programado de este mes.</p> : null}
      {event.status === "needs_review" ? <p className="payment-reconciliation-warning">El cobro sigue por confirmar; vincularlo no cambia ese estado.</p> : null}
    </> : null}
    <div className="payment-reconciliation-actions">
      <button type="button" className="primary-button" disabled={busy || disabled || (!unlink && !event)}
        onClick={() => { if (!busy && !disabled && (unlink || event)) onConfirm(unlink ? null : event!.id); }}>
        {busy ? "Guardando vínculo…" : unlink ? "Desvincular cobro" : "Vincular cobro"}
      </button>
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Volver</button>
    </div>
  </section>;
}

export function PaymentReconciliation({ payment, month, candidates, candidatesLoading, candidatesError,
  onRetryCandidates, onReconcile, onOpenEvent, disabled = false, onBusyChange }: {
  readonly payment: PlannedPayment;
  readonly month: string;
  readonly candidates: readonly ObservedEvent[];
  readonly candidatesLoading: boolean;
  readonly candidatesError?: string;
  readonly onRetryCandidates?: () => void;
  readonly onReconcile?: (eventId: string | null) => Promise<void>;
  readonly onOpenEvent?: (eventId: string, signal: AbortSignal) => Promise<void>;
  readonly disabled?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(!payment.reconciliation);
  const [confirmation, setConfirmation] = useState<"link" | "unlink">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState<{ id: string; status: "opening" | "failed" }>();
  const openingController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { openingController.current?.abort(); }, [month, payment.id]);
  const openEvidence = async (eventId: string) => {
    if (disabled || busy || !onOpenEvent) return;
    openingController.current?.abort();
    const controller = new AbortController();
    openingController.current = controller;
    const isCurrent = () => !controller.signal.aborted && openingController.current === controller;
    setOpening({ id: eventId, status: "opening" });
    try {
      await onOpenEvent(eventId, controller.signal);
      if (isCurrent()) setOpening(undefined);
    } catch {
      if (isCurrent()) setOpening({ id: eventId, status: "failed" });
    }
  };
  const eligible = eligibleReconciliationEvents(candidates, month);
  const selected = eligible.find(event => event.id === selectedId);
  const filtered = eligible.filter(event => event.merchantRaw.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));
  const link = payment.reconciliation;
  const unavailable = disabled || busy || !onReconcile;
  const confirm = async (eventId: string | null) => {
    if (unavailable || !confirmation || (confirmation === "link" && (!selected || candidatesLoading || candidatesError))) return;
    if ((confirmation === "link" && eventId !== selected?.id) || (confirmation === "unlink" && eventId !== null)) return;
    setBusy(true); onBusyChange?.(true); setError(undefined);
    try {
      await onReconcile!(eventId);
      setConfirmation(undefined); setSelectedId(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el vínculo. Intenta de nuevo.");
    } finally { setBusy(false); onBusyChange?.(false); }
  };
  return <section className="payment-reconciliation" aria-label="Conciliación del gasto fijo">
    <h3>{link ? link.valid ? "Cobro vinculado" : "Revisar vínculo" : "Por conciliar"}</h3>
    <p>Elige un cobro observado de {monthKeyLabel(month)}. No se seleccionan coincidencias automáticamente.</p>
    {link ? <div className="payment-reconciliation-current">
      <strong>{link.merchantRaw}</strong>
      <p>{dayLabel(link.occurredAt)} · Mi parte <Amt>{mxn(link.amountMinor)}</Amt> · bruto <Amt>{mxn(link.grossAmountMinor)}</Amt>.</p>
      {!link.valid ? <p role="alert">{link.invalidReason || "El cobro vinculado ya no cumple los requisitos."} Este vínculo no descuenta el fijo por conciliar. Revisa el cobro o desvincúlalo.</p> : null}
      <div className="payment-reconciliation-actions">
        {onOpenEvent ? <button type="button" className="text-button" disabled={disabled || busy || opening?.status === "opening"} onClick={() => void openEvidence(link.eventId)}>Ver cobro y evidencia</button> : null}
        <button type="button" className="text-button" disabled={unavailable} onClick={() => { setPickerOpen(true); setConfirmation(undefined); setSelectedId(undefined); }}>Elegir otro cobro</button>
        <button type="button" className="text-button" disabled={unavailable} onClick={() => setConfirmation("unlink")}>Revisar desvínculo</button>
      </div>
    </div> : null}
    {disabled ? <p className="payment-reconciliation-warning">Guarda o descarta los cambios del fijo antes de conciliar.</p> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    {opening?.status === "opening" ? <p role="status">Abriendo cobro y evidencia…</p> : null}
    {opening?.status === "failed" ? <div role="alert">
      <p>No pudimos abrir este cobro. Intenta de nuevo.</p>
      <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void openEvidence(opening.id)}>Reintentar evidencia</button>
    </div> : null}
    {confirmation === "unlink" || (confirmation === "link" && selected) ? <PaymentReconciliationConfirmation
      payment={payment} month={month} event={selected} unlink={confirmation === "unlink"} busy={busy}
      disabled={disabled || !onReconcile || (confirmation === "link" && (candidatesLoading || Boolean(candidatesError)))}
      onConfirm={eventId => void confirm(eventId)} onCancel={() => setConfirmation(undefined)} /> : null}
    {pickerOpen && confirmation !== "unlink" ? <div className="payment-reconciliation-picker">
      <label className="payment-reconciliation-search">Buscar cobro por comercio
        <input type="search" value={query} disabled={unavailable} onChange={event => setQuery(event.target.value)} placeholder="Comercio del cobro" />
      </label>
      {candidatesLoading ? <p role="status">Consultando cobros observados…</p> : candidatesError ? <div role="alert">
        <p>{candidatesError}</p>{onRetryCandidates ? <button type="button" className="text-button" disabled={unavailable} onClick={onRetryCandidates}>Reintentar cobros</button> : null}
      </div> : <>
        {!filtered.length ? <p>{eligible.length ? "No hay cobros con ese comercio." : "No hay cobros elegibles de este mes. Puedes revisar Movimientos o cargar la fuente que falta."}</p> : <fieldset className="payment-reconciliation-candidates">
          <legend>Cobros observados de {monthKeyLabel(month)}</legend>
          {filtered.map(event => <div className="payment-reconciliation-candidate" key={event.id}>
            <label><input type="radio" name={`payment-candidate-${payment.id}`} value={event.id} checked={selectedId === event.id}
              disabled={unavailable} onChange={() => { setSelectedId(event.id); setConfirmation(undefined); }} />
              <span><strong>{event.merchantRaw}</strong><small>{dayLabel(chargeDate(event).toISOString())}{event.status === "needs_review" ? " · Por confirmar" : ""}</small>
                <small>Mi parte <Amt>{mxn(eventAmount(event))}</Amt> · bruto <Amt>{mxn(event.amount.amountMinor)}</Amt></small></span>
            </label>
            {onOpenEvent ? <button type="button" className="text-button" disabled={disabled || busy || opening?.status === "opening"} onClick={() => void openEvidence(event.id)}>Ver cobro y evidencia</button> : null}
          </div>)}
        </fieldset>}
        <button type="button" className="secondary-button" disabled={unavailable || !selected} onClick={() => setConfirmation("link")}>Revisar vínculo</button>
      </>}
    </div> : null}
  </section>;
}
