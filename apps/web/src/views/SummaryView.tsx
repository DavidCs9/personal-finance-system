import type { SpendingAnalytics } from "@finance/domain";
import type { MonthDashboard } from "../api/planning-types";
import { money } from "../lib/format";
import { Amt } from "../components/Amt";
import { AnalyticsPreview } from "../components/AnalyticsPreview";
import { SummaryBudget } from "./SummaryBudget";
import { MonthEntries, type MonthlyReceivedEditor } from "./MonthEntries";

export interface SummaryViewProps {
  readonly receivedEditor?: MonthlyReceivedEditor;
  readonly dashboard?: MonthDashboard;
  readonly dashboardLoading?: boolean;
  readonly dashboardError?: boolean;
  readonly privateMode?: boolean;
  readonly onOpenBudget: () => void;
  readonly onRetryDashboard?: () => void;
  readonly spendAvailable?: boolean;
  readonly month: string;
  readonly spentMinor: number;
  readonly uncertainMinor: number;
  readonly analytics?: SpendingAnalytics;
  readonly analyticsLoading: boolean;
  readonly analyticsLoadError?: string;
  readonly onRetryAnalytics: () => void;
  readonly onOpenAnalytics: () => void;
  readonly onOpenAnalyticsMovements: (label: string, eventIds: readonly string[]) => void;
}

export function SummaryView(props: SummaryViewProps) {
  return <section className="summary-view">
    <div className="summary-scroll">
      <h1 className="summary-dashboard-title">Resumen</h1>
      {props.dashboard ? <>
        {props.dashboardError && <p className="banner-error" role="alert">
          No pudimos actualizar este mes. Se muestra la última lectura.
          <button type="button" className="text-button" onClick={props.onRetryDashboard}>Reintentar</button>
        </p>}
        <SummaryBudget status={props.dashboard.budget} privateMode={Boolean(props.privateMode)}
          recordedMinor={props.dashboard.spending.recordedMinor}
          onOpen={props.onOpenBudget} onOpenAnalytics={props.onOpenAnalytics} />
        <MonthEntries key={props.month} month={props.month} dashboard={props.dashboard} editor={props.receivedEditor} />
      </> : <>
        <section className="summary-budget-panel" role={props.dashboardError ? "alert" : "status"}>
          <h2>Presupuesto mensual</h2>
          <p>{props.dashboardError ? "No pudimos consultar el presupuesto de este mes." : "Consultando presupuesto…"}</p>
          {props.dashboardError && <button type="button" className="text-button summary-budget-link"
            onClick={props.onRetryDashboard}>Reintentar</button>}
        </section>
        {props.dashboardError && props.spendAvailable && <section className="summary-budget-panel summary-fallback-spend">
          <h2>Gasto total del mes</h2>
          <strong><Amt>{money(props.spentMinor)}</Amt></strong>
          {props.uncertainMinor > 0 && <p>Incluye <Amt>{money(props.uncertainMinor)}</Amt> por confirmar.</p>}
        </section>}
        {props.dashboardError && <AnalyticsPreview analytics={props.analytics}
          loading={props.analyticsLoading} loadError={props.analyticsLoadError} onRetry={props.onRetryAnalytics}
          onOpen={props.onOpenAnalytics} onDrillDown={props.onOpenAnalyticsMovements} />}
        <section className="summary-budget-panel summary-entries" role={props.dashboardError ? "alert" : "status"}>
          <h2>Entradas del mes</h2>
          <p>{props.dashboardError ? "No pudimos consultar las entradas de este mes." : "Consultando entradas…"}</p>
        </section>
      </>}
    </div>
  </section>;
}
