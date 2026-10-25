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
    <section className="payments-section fixed-payments-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">GASTOS FIJOS</p>
          <h2>Servicios y suscripciones</h2>
          <p className="section-lede">Cargos programados cada mes, sin fecha de fin.</p>
        </div>
        {!props.loading && !props.loadError && (
          <button className="add-button" aria-label="Agregar gasto fijo" onClick={props.onAdd}>+</button>
        )}
      </div>
      {props.loading ? (
        <p role="status">Consultando tus gastos fijos…</p>
      ) : props.loadError ? (
        <div role="alert">
          <p>{props.loadError}</p>
          <button type="button" className="text-button" onClick={props.onRetry}>Reintentar gastos fijos</button>
        </div>
      ) : (
        <>
          <p className="section-lede">
            {props.inheritedFromMonth
              ? `Según tus gastos fijos de ${monthKeyLabel(props.inheritedFromMonth)}; se repiten mientras no los cambies.`
              : `Programación de ${monthKeyLabel(props.month)}.`}
            {" "}No confirma si ya se cobraron.
          </p>
          {props.payments.length > 0 ? (
            <div className="payment-list">
              {props.payments.map((payment) => (
                <button key={payment.id} className="payment-row" onClick={() => props.onEdit(payment)}>
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
            <button className="empty-action" onClick={props.onAdd}>
              <span>+</span>
              <div>
                <strong>Agrega tus gastos fijos</strong>
                <small>No hay gastos fijos programados para este mes.</small>
              </div>
            </button>
          )}
        </>
      )}
    </section>
  );
}
