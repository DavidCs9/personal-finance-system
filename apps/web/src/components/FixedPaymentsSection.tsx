import type { PlannedPayment } from "../monthly-plan";
import { paymentDueDayForMonth } from "../monthly-plan";
import { money, monthDate, monthKeyLabel } from "../lib/format";
import { Amt } from "./Amt";

export interface FixedPaymentsSectionProps {
  readonly month: string;
  readonly payments: readonly PlannedPayment[];
  readonly inheritedFromMonth?: string;
  readonly totalMinor?: number;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly onAdd: () => void;
  readonly onEdit: (payment: PlannedPayment) => void;
}

export function FixedPaymentsSection(props: FixedPaymentsSectionProps) {
  const paymentMonth = new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" })
    .format(monthDate(props.month)).replace(".", "").toUpperCase();

  return (
    <section className="planning-section fixed-payments-section">
      <details key={props.month} className="planning-disclosure">
        <summary className="planning-section-summary">
          <span className="planning-section-copy">
            <span className="eyebrow">SERVICIOS Y SUSCRIPCIONES</span>
            <strong role="heading" aria-level={2}>Gastos fijos</strong>
            {props.loading ? <span role="status">Consultando tus gastos fijos…</span>
              : props.loadError ? <small>Programación no disponible</small> : <>
                <small><Amt>{props.payments.length}</Amt> {props.payments.length === 1 ? "servicio programado" : "servicios programados"}</small>
                {props.inheritedFromMonth ? <small>Heredados de {monthKeyLabel(props.inheritedFromMonth)}</small> : null}
                <small>Programación; no confirma cobro.</small>
              </>}
          </span>
          <span className="planning-section-value">
            {!props.loading && !props.loadError && props.totalMinor !== undefined
              ? <strong><Amt>{money(props.totalMinor)}</Amt></strong> : null}
            <span className="planning-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        {!props.loading && !props.loadError ? <div className="planning-section-content">
          {props.payments.length > 0 ? <div className="planning-section-actions">
            <button type="button" className="text-button" onClick={props.onAdd}>Agregar gasto fijo</button>
          </div> : null}
          <p className="section-lede">
            {props.inheritedFromMonth
              ? `Según tus gastos fijos de ${monthKeyLabel(props.inheritedFromMonth)}; se repiten mientras no los cambies.`
              : `Programación de ${monthKeyLabel(props.month)}.`}
            {" "}No confirma si ya se cobraron.
          </p>
          {props.payments.length > 0 ? (
            <div className="payment-list">
              {props.payments.map((payment) => (
                <button key={payment.id} type="button" className="payment-row" onClick={() => props.onEdit(payment)}>
                  <span className="date-block">
                    <small>{paymentMonth}</small>
                    <strong>{String(paymentDueDayForMonth(props.month, payment.dueDay)).padStart(2, "0")}</strong>
                  </span>
                  <span className="payment-name">
                    <strong>{payment.name}</strong>
                    <small>Programado · cada mes · sin fecha de fin</small>
                  </span>
                  <strong className="payment-amount"><Amt>{money(payment.amountMinor)}</Amt></strong>
                  <span className="chevron">›</span>
                </button>
              ))}
              {props.totalMinor !== undefined && (
                <div className="payment-total">
                  <span>Total de gastos fijos programados</span>
                  <strong><Amt>{money(props.totalMinor)}</Amt></strong>
                </div>
              )}
            </div>
          ) : (
            <button type="button" className="empty-action" onClick={props.onAdd}>
              <span>+</span>
              <div>
                <strong>Agrega tus gastos fijos</strong>
                <small>No hay gastos fijos programados para este mes.</small>
              </div>
            </button>
          )}
        </div> : null}
      </details>
      {props.loadError && !props.loading ? <div role="alert" className="planning-section-error">
        <p>{props.loadError}</p>
        <button type="button" className="text-button" onClick={props.onRetry}>Reintentar gastos fijos</button>
      </div> : null}
    </section>
  );
}
