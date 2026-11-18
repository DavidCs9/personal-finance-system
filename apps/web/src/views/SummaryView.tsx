import type { SpendingAnalytics } from "@finance/domain";
import type { MonthDashboard } from "../api/planning-types";
import { money } from "../lib/format";
import type { MonthlyPlan } from "../monthly-plan";
import { Amt } from "../components/Amt";
import { PushPreference } from "../components/PushPreference";
import { AnalyticsPreview } from "../components/AnalyticsPreview";
import { SummaryBudget } from "./SummaryBudget";

export interface SummaryViewProps {
  readonly dashboard?: MonthDashboard;
  readonly dashboardLoading?: boolean;
  readonly dashboardError?: boolean;
  readonly privateMode?: boolean;
  readonly onOpenBudget?: () => void;
  readonly onRetryDashboard?: () => void;
  readonly spendAvailable?: boolean;
  readonly month: string;
  readonly plan: MonthlyPlan;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly spentMinor: number;
  readonly uncertainMinor: number;
  readonly billUpcomingMinor: number;
  readonly remainingMinor: number;
  readonly projectedSpendMinor: number;
  readonly projectedRemainingMinor: number;
  readonly isCurrentMonth: boolean;
  readonly isFutureMonth?: boolean;
  readonly fixedSpentMinor?: number;
  readonly risk: "danger" | "watch" | "steady";
  readonly msiSpentMinor: number;
  readonly msiCommittedMinor: number;
  readonly onUploadNomina: () => void;
  readonly onOpenIncome: () => void;
  readonly onOpenPlanning: () => void;
  readonly onReviewLargest: () => void;
  readonly analytics?: SpendingAnalytics;
  readonly analyticsLoading: boolean;
  readonly analyticsLoadError?: string;
  readonly onRetryAnalytics: () => void;
  readonly onOpenAnalytics: () => void;
  readonly onOpenAnalyticsMovements: (label: string, eventIds: readonly string[]) => void;
  readonly idToken: string;
  readonly demoMode: boolean;
}

export function SummaryView(props: SummaryViewProps) {
  const liquidity = props.dashboard?.liquidity;
  const incomeMinor = liquidity ? liquidity.incomeMinor : props.plan.configured ? props.plan.incomeMinor : null;
  const hasIncome = incomeMinor !== null && incomeMinor > 0;
  const spendAndCommitmentsMinor = liquidity?.totalCommittedSpendMinor ?? props.spentMinor + props.billUpcomingMinor + props.msiCommittedMinor;
  const spendAndCommitmentsPercent = hasIncome
    ? Math.round(liquidity?.committedSpendPercent ?? (spendAndCommitmentsMinor / incomeMinor) * 100)
    : 0;
  const spendAvailable = props.spendAvailable ?? (!props.loading && !props.loadError);
  const payslipCount = liquidity?.payslipCount ?? props.plan.payslips?.length ?? 0;
  const provisionalMinor = liquidity ? liquidity.provisionalMinor : props.plan.provisionalActive ? props.plan.provisionalMinor ?? 0 : null;
  const estimatedMinor = liquidity ? liquidity.estimatedMinor : props.plan.estimateActive ? props.plan.estimatedMinor ?? 0 : null;
  const provisionalActive = provisionalMinor !== null;
  const hasScheduledPayments = props.dashboard ? props.dashboard.summary.billScheduledMinor > 0 : props.plan.upcomingPayments.length > 0;

  const supportContent = <>
    {!props.dashboard && spendAvailable && (props.loading || props.loadError || !hasIncome) && (
      <section className="spend-hero">
        <div className="spend-heading"><h2>Has gastado</h2></div>
        <strong className="hero-amount"><Amt>{money(props.spentMinor)}</Amt></strong>
        <p className="spend-caption">En movimientos y cuotas MSI del mes</p>
        {props.uncertainMinor > 0 && <p className="spend-caption">Incluye <Amt>{money(props.uncertainMinor)}</Amt> por confirmar</p>}
      </section>
    )}
    {props.loading ? (
      <section className="setup-card plan-loading">
        <p className="eyebrow">CONFIGURACIÓN MENSUAL</p>
        <h2>Consultando tu liquidez…</h2>
        <p>Estamos consultando tu liquidez y pagos próximos.</p>
      </section>
    ) : props.loadError ? (
      <section className="setup-card plan-error">
        <span className="setup-alert">!</span>
        <p className="eyebrow">NO PUDIMOS LEER ESTE MES</p>
        <h2>Consulta incompleta</h2>
        <p>{props.loadError} Intenta cargarla de nuevo antes de hacer cambios.</p>
        <button className="primary-button" onClick={props.onRetry}>
          Reintentar
        </button>
      </section>
    ) : !hasIncome ? (
      <section className="setup-card missing-income">
        <span className="setup-alert">!</span>
        <h2>Falta tu nómina de este mes.</h2>
        <p>
          Sube el XML del CFDI de nómina para ver liquidez real, retenciones y cuánto te queda.
        </p>
        <button className="primary-button" onClick={props.onUploadNomina}>
          Subir nómina XML
        </button>
      </section>
    ) : (
      <>
        <section className="spend-hero">
          <div className="spend-heading">
            <div>
              <p className="eyebrow">GASTO ACUMULADO</p>
              <h2>Has gastado</h2>
            </div>
            <button
              className="income-button"
              onClick={() => {
                if (provisionalActive || payslipCount > 0) props.onOpenIncome();
                else props.onUploadNomina();
              }}
            >
              <span>{provisionalActive ? "Liquidez provisional" : "Liquidez"}</span>
              <strong>
                <Amt>{money(incomeMinor)}</Amt>
              </strong>
            </button>
          </div>
          <strong className="hero-amount">
            <Amt>{money(props.spentMinor)}</Amt>
          </strong>
          <p className="spend-caption">En movimientos y cuotas MSI del mes</p>
          <div className="spend-commitments">
            <h2>Con fijos y MSI pendientes</h2>
            <strong className="spend-commitments-amount">
              <Amt>{money(spendAndCommitmentsMinor)}</Amt>
            </strong>
            <div className="spend-meta">
              <strong>
                <Amt>{spendAndCommitmentsPercent}%</Amt>
              </strong>
              <span>de tu liquidez entre gasto y compromisos</span>
            </div>
            <details className="spend-breakdown" key={props.month}>
              <summary>Ver cómo se compone</summary>
              <dl>
                <div>
                  <dt>Has gastado</dt>
                  <dd><Amt>{money(props.spentMinor)}</Amt></dd>
                </div>
                <div>
                  <dt>Fijos sin cobro vinculado</dt>
                  <dd><Amt>{money(props.billUpcomingMinor)}</Amt></dd>
                </div>
                <div>
                  <dt>MSI pendientes del mes</dt>
                  <dd><Amt>{money(props.msiCommittedMinor)}</Amt></dd>
                </div>
              </dl>
              {props.msiSpentMinor > 0 && (
                <p>
                  Las cuotas MSI registradas (<Amt>{money(props.msiSpentMinor)}</Amt>) ya están
                  en Has gastado.
                </p>
              )}
              {(props.fixedSpentMinor ?? 0) > 0 && (
                <p>
                  Los cobros vinculados de fijos (<Amt>{money(props.fixedSpentMinor ?? 0)}</Amt>) ya están
                  en Has gastado y no se repiten.
                </p>
              )}
              <p>
                {hasScheduledPayments
                  ? "Los fijos sin cobro vinculado muestran programación; no confirma si ya se cobraron."
                  : "No hay gastos fijos programados para este mes."}
              </p>
            </details>
          </div>
          {(provisionalMinor ?? 0) > 0 || (estimatedMinor ?? 0) > 0 ||
          props.uncertainMinor > 0 ? (
            <div className="spend-notes">
              {provisionalMinor !== null && provisionalMinor > 0 && (
                <p className="uncertain-note">
                  <span className="note-icon" aria-hidden="true">
                    ≈
                  </span>
                  <span className="note-copy">
                    Liquidez provisional · pendiente nómina de este mes (
                    <Amt>{money(provisionalMinor)}</Amt>)
                  </span>
                </p>
              )}
              {estimatedMinor !== null && estimatedMinor > 0 && (
                <p className="uncertain-note">
                  <span className="note-icon" aria-hidden="true">
                    ≈
                  </span>
                  <span className="note-copy">
                    Incluye <Amt>{money(estimatedMinor)}</Amt> estimado de la 2ª
                    quincena
                  </span>
                </p>
              )}
              {props.uncertainMinor > 0 && (
                <p className="uncertain-note">
                  <span className="note-icon" aria-hidden="true">
                    !
                  </span>
                  <span className="note-copy">
                    Incluye <Amt>{money(props.uncertainMinor)}</Amt> por confirmar
                  </span>
                </p>
              )}
            </div>
          ) : null}
        </section>

        <div className="number-grid">
          <section className="number-card">
            <p>Te quedan</p>
            <strong>
              <Amt>{money(Math.max(props.remainingMinor, 0))}</Amt>
            </strong>
            <span>según tu gasto y compromisos del mes</span>
          </section>
          <section className={`projection-card ${props.risk}`}>
            <p>{props.isCurrentMonth ? "A este ritmo" : props.isFutureMonth ? "Compromisos del mes" : "Cierre del mes"}</p>
            <strong>
              {props.isCurrentMonth ? "Gastarás" : props.isFutureMonth ? "Programado" : "Gastaste"}{" "}
              <Amt>{money(props.isCurrentMonth ? props.projectedSpendMinor
                : props.isFutureMonth ? props.billUpcomingMinor + props.msiCommittedMinor : props.spentMinor)}</Amt>
            </strong>
            <span>
              {props.isCurrentMonth
                ? "si mantienes este paso · incluye fijos y MSI del mes"
                : props.isFutureMonth
                  ? "fijos sin cobro vinculado y cuotas MSI comprometidas"
                  : "según tus movimientos y cuotas MSI registrados"}
            </span>
            {props.isCurrentMonth && props.projectedRemainingMinor < 0 ? (
              <button onClick={props.onReviewLargest}>
                Revisar gastos grandes <span>→</span>
              </button>
            ) : null}
          </section>
        </div>
      </>
    )}
  </>;

  return (
    <section className={`summary-view risk-${props.risk}`}>
      <div className="summary-scroll">
        {props.dashboard && props.onOpenBudget ? <>
          <h1 className="summary-dashboard-title">Resumen</h1>
          <SummaryBudget status={props.dashboard.budget} privateMode={Boolean(props.privateMode)}
            onOpen={props.onOpenBudget} onOpenAnalytics={props.onOpenAnalytics} />
        </> : props.dashboardError || props.dashboardLoading ? <>
          <h1 className="summary-dashboard-title">Resumen</h1>
          <section className="summary-budget-panel" role={props.dashboardError ? "alert" : "status"}>
            <h2>Presupuesto mensual</h2>
            <p>{props.dashboardError ? "No pudimos consultar el presupuesto de este mes." : "Consultando presupuesto…"}</p>
            {props.dashboardError && <button type="button" className="text-button summary-budget-link"
              onClick={props.onRetryDashboard}>Reintentar</button>}
          </section>
        </> : null}
        {props.dashboard && liquidity ? <div className="summary-support">
          <section className="summary-budget-panel" aria-label="Gasto y liquidez del mes">
            <dl className="summary-observed-totals">
              <div><dt>Gasto registrado</dt><dd><Amt>{money(props.dashboard.summary.spentMinor)}</Amt></dd></div>
              <div><dt>Liquidez tras compromisos</dt>
                <dd>{liquidity.remainingMinor === null ? "Por confirmar" : <Amt>{money(Math.max(liquidity.remainingMinor, 0))}</Amt>}</dd></div>
              <div>
                <dt>{props.isCurrentMonth ? "Gasto estimado al cierre" : props.isFutureMonth ? "Compromisos conocidos" : "Gasto al cierre"}</dt>
                <dd>{props.isCurrentMonth
                  ? liquidity.projectedSpendMinor === null ? "Por confirmar" : <Amt>{money(liquidity.projectedSpendMinor)}</Amt>
                  : <Amt>{money(props.isFutureMonth ? props.dashboard.summary.upcomingMinor : props.dashboard.summary.spentMinor)}</Amt>}</dd>
              </div>
            </dl>
            {(provisionalActive || estimatedMinor !== null) && <p>{provisionalActive ? "Liquidez provisional" : "Incluye nómina estimada"}</p>}
            {props.uncertainMinor > 0 && <p>El gasto incluye <Amt>{money(props.uncertainMinor)}</Amt> por confirmar.</p>}
          </section>
          {hasIncome ? <details key={props.month} className="summary-support-details">
            <summary>Ver liquidez, nómina y desglose</summary>
            {supportContent}
          </details> : supportContent}
        </div> : supportContent}

        <section className="summary-shortcuts" aria-label="Explora tu mes">
          <button type="button" className="summary-shortcut" onClick={props.onOpenPlanning}>
            <span>
              <strong>Planificación</strong>
              <small>MSI, gastos fijos y fechas de tarjetas</small>
            </span>
            <span className="chevron" aria-hidden="true">→</span>
          </button>
        </section>

        {!props.dashboard && !props.dashboardLoading && <AnalyticsPreview
            analytics={props.analytics}
            loading={props.analyticsLoading}
            loadError={props.analyticsLoadError}
            onRetry={props.onRetryAnalytics}
            onOpen={props.onOpenAnalytics}
            onDrillDown={props.onOpenAnalyticsMovements}
        />}

        {!props.loading && !props.loadError && (
          <PushPreference idToken={props.idToken} demoMode={props.demoMode} />
        )}
      </div>
    </section>
  );
}
