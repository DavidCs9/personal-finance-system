import type { CommittedMsiRow } from "@finance/domain";
import { money, monthDate } from "../lib/format";
import type { MonthlyPlan, PlannedPayment } from "../monthly-plan";
import { PushPreference } from "../components/PushPreference";

export interface SummaryViewProps {
  readonly month: string;
  readonly plan: MonthlyPlan;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly spentMinor: number;
  readonly uncertainMinor: number;
  readonly upcomingMinor: number;
  readonly remainingMinor: number;
  readonly projectedRemainingMinor: number;
  readonly spendPercent: number;
  readonly isCurrentMonth: boolean;
  readonly risk: "danger" | "watch" | "steady";
  readonly committedMsiRows: readonly CommittedMsiRow[];
  readonly onEditIncome: () => void;
  readonly onAddPayment: () => void;
  readonly onEditPayment: (payment: PlannedPayment) => void;
  readonly onOpenMsiEvent: (eventId: string) => void;
  readonly onReviewLargest: () => void;
  readonly idToken: string;
  readonly demoMode: boolean;
}

export function SummaryView(props: SummaryViewProps) {
  const hasIncome = props.plan.configured && props.plan.incomeMinor > 0;
  const paymentMonth = new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" })
    .format(monthDate(props.month))
    .replace(".", "")
    .toUpperCase();

  return (
    <section className={`summary-view risk-${props.risk}`}>
      <div className="summary-scroll">
        {props.loading ? (
          <section className="setup-card plan-loading">
            <p className="eyebrow">CONFIGURACIÓN MENSUAL</p>
            <h1>Cargando este mes…</h1>
            <p>Estamos consultando tu ingreso y pagos próximos.</p>
          </section>
        ) : props.loadError ? (
          <section className="setup-card plan-error">
            <span className="setup-alert">!</span>
            <p className="eyebrow">NO PUDIMOS LEER ESTE MES</p>
            <h1>Tu configuración no está disponible.</h1>
            <p>{props.loadError} Intenta cargarla de nuevo antes de hacer cambios.</p>
            <button className="primary-button" onClick={props.onRetry}>
              Reintentar
            </button>
          </section>
        ) : !hasIncome ? (
          <section className="setup-card missing-income">
            <span className="setup-alert">!</span>
            <p className="eyebrow">EMPIEZA POR TU LÍMITE</p>
            <h1>Falta configurar tu ingreso.</h1>
            <p>
              Este mes todavía no tiene un ingreso. Registra el total de tus dos depósitos de nómina
              para calcular cuánto puedes gastar.
            </p>
            <button className="primary-button" onClick={props.onEditIncome}>
              Definir ingreso mensual
            </button>
          </section>
        ) : (
          <>
            <section className="spend-hero">
              <div className="spend-heading">
                <div>
                  <p className="eyebrow">GASTO ACUMULADO</p>
                  <h1>Has gastado</h1>
                </div>
                <button className="income-button" onClick={props.onEditIncome}>
                  <span>Ingreso</span>
                  <strong>{money(props.plan.incomeMinor)}</strong>
                </button>
              </div>
              <strong className="hero-amount">{money(props.spentMinor)}</strong>
              <div className="spend-meta">
                <strong>{props.spendPercent}%</strong>
                <span>de tu ingreso mensual</span>
              </div>
              {props.uncertainMinor > 0 && (
                <p className="uncertain-note">
                  <span>!</span> Incluye {money(props.uncertainMinor)} por confirmar
                </p>
              )}
            </section>

            <div className="number-grid">
              <section className="number-card">
                <p>Te quedan</p>
                <strong>{money(Math.max(props.remainingMinor, 0))}</strong>
                <span>después de pagos próximos</span>
              </section>
              <section className={`projection-card ${props.risk}`}>
                <p>{props.isCurrentMonth ? "A este ritmo" : "Cierre del mes"}</p>
                {props.projectedRemainingMinor < 0 ? (
                  <>
                    <strong>Te faltarán {money(Math.abs(props.projectedRemainingMinor))}</strong>
                    <span>si mantienes este paso</span>
                    <button onClick={props.onReviewLargest}>
                      Revisar gastos grandes <span>→</span>
                    </button>
                  </>
                ) : (
                  <>
                    <strong>Cerrarás con {money(props.projectedRemainingMinor)}</strong>
                    <span>
                      {props.isCurrentMonth ? "si mantienes este paso" : "según tus registros"}
                    </span>
                  </>
                )}
              </section>
            </div>
          </>
        )}

        {!props.loading && !props.loadError && hasIncome && (
          <section className="payments-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">DINERO COMPROMETIDO</p>
                <h2>Próximos pagos</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Agregar pago próximo"
                onClick={props.onAddPayment}
              >
                +
              </button>
            </div>
            {props.plan.upcomingPayments.length > 0 || props.committedMsiRows.length > 0 ? (
              <div className="payment-list">
                {props.committedMsiRows.map((row) => (
                  <button
                    key={`${row.eventId ?? row.name}-${row.installmentIndex}`}
                    className="payment-row"
                    onClick={() => {
                      if (row.eventId) props.onOpenMsiEvent(row.eventId);
                    }}
                  >
                    <span className="date-block">
                      <small>MSI</small>
                      <strong>{String(row.installmentIndex).padStart(2, "0")}</strong>
                    </span>
                    <span className="payment-name">
                      <strong>{row.name}</strong>
                      <small>Cuota pendiente de reconciliar</small>
                    </span>
                    <strong className="payment-amount">{money(row.amountMinor)}</strong>
                    <span className="chevron">›</span>
                  </button>
                ))}
                {props.plan.upcomingPayments.map((payment) => (
                  <button
                    key={payment.id}
                    className="payment-row"
                    onClick={() => props.onEditPayment(payment)}
                  >
                    <span className="date-block">
                      <small>{paymentMonth}</small>
                      <strong>{String(payment.dueDay).padStart(2, "0")}</strong>
                    </span>
                    <span className="payment-name">
                      <strong>{payment.name}</strong>
                      <small>Pago programado</small>
                    </span>
                    <strong className="payment-amount">{money(payment.amountMinor)}</strong>
                    <span className="chevron">›</span>
                  </button>
                ))}
                <div className="payment-total">
                  <span>Total comprometido</span>
                  <strong>{money(props.upcomingMinor)}</strong>
                </div>
              </div>
            ) : (
              <button className="empty-action" onClick={props.onAddPayment}>
                <span>+</span>
                <div>
                  <strong>Agrega tus pagos próximos</strong>
                  <small>Renta, servicios, seguros, MSI y otras obligaciones.</small>
                </div>
              </button>
            )}
          </section>
        )}

        {!props.loading && !props.loadError && (
          <PushPreference idToken={props.idToken} demoMode={props.demoMode} />
        )}
      </div>
    </section>
  );
}
