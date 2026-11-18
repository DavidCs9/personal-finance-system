import type { IncomeSource } from "../api/planning-types";
import { monthKeyLabel } from "../lib/format";
import { Amount, dayLabel, EvidenceButton, ReadState, type PlanningAccess } from "./PlanningRead";
import { useExpectedIncome } from "./planning-queries";

const frequency = { monthly: "Mensual", semimonthly: "Quincenal", one_time: "Pago único" } as const;
const confidence = { estimated: "Estimado", confirmed: "Expectativa confirmada" } as const;
const ruleLabels = (source: IncomeSource) => source.paymentRules
  ? source.paymentRules.map(rule => rule.kind === "last_business_day" ? "Último día hábil"
    : rule.kind === "previous_business_day" ? `Día ${rule.day} o hábil anterior` : `Día ${rule.day}`).join(" · ")
  : source.expectedPaymentDate ? dayLabel(source.expectedPaymentDate) : source.paymentDays.map(day => `Día ${day}`).join(" · ");

export function IncomeRead({ month, access, onOpenPayslip }: {
  month: string; access: PlanningAccess;
  onOpenPayslip: (month: string, id: string, signal: AbortSignal) => Promise<void>;
}) {
  const query = useExpectedIncome(month, access);
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  if (!first) return <div className="plan-read-body">
    <ReadState label={query.isError ? "No pudimos consultar tus ingresos." : "Consultando tus ingresos…"}
      failed={query.isError} retry={query.isError ? () => void query.refetch() : undefined} />
  </div>;

  const paginated = pages.length > 1 || query.hasNextPage;
  return <div className="plan-read-body">
    <p className="plan-period">{monthKeyLabel(month)} – {monthKeyLabel(first.monthlyTotals.at(-1)?.month ?? month)} · MXN</p>
    {query.isRefetchError && <ReadState label="No pudimos actualizar la consulta. Se muestra la última lectura."
      failed retry={() => void query.refetch()} />}
    <section className="plan-section">
      <h3>Expectativas de ingreso</h3>
      <p className="plan-meta">Importes netos según la programación configurada en ChatGPT.</p>
      {first.sources.length === 0 && <p className="plan-notice">Aún no hay fuentes configuradas en Olbia.</p>}
      {pages.map((page, pageIndex) => {
        if (!page.sources.length) return null;
        const active = page.sources.some(source => source.status === "active");
        return <div className="plan-income-page" key={page.sources[0]?.id}>
          {paginated && <p className="plan-meta">Fuentes de la página {pageIndex + 1}. Los importes corresponden a estas fuentes.</p>}
          {page.monthlyTotals.map(total => {
            const occurrences = page.occurrences.filter(item => (item.paymentDate?.slice(0, 7) ?? item.periodMonth) === total.month);
            const unknown = total.unknownExpectedOccurrences > 0;
            return <details className="plan-disclosure" key={total.month} open={total.month === month}>
              <summary>
                <span>{monthKeyLabel(total.month)}</span>
                {occurrences.length > 0
                  ? <strong><Amount value={total.expectedScheduledMxnMinor} /></strong>
                  : <small className="plan-meta">Sin pagos previstos</small>}
              </summary>
              {unknown && <p className="plan-meta">
                {total.expectedKnownMxnMinor > 0 && <>Subtotal conocido <Amount value={total.expectedKnownMxnMinor} />. </>}
                Quedan importes por confirmar.
              </p>}
              {total.overlapStatus === "unresolved_payroll_overlap" && <p className="plan-notice">Hay coincidencia con nómina CFDI. Remanente por confirmar.</p>}
              {total.provisionalCalendarOccurrences > 0 && <p className="plan-meta">Algunas fechas usan un calendario bancario provisional.</p>}
              {occurrences.length > 0 && <ul className="plan-rows">{occurrences.map(item => <li key={item.occurrenceId}>
                <div className="plan-row-head">
                  <strong className="plan-sensitive">{item.name}</strong>
                  <Amount value={item.amountMxnMinor} unknown="Neto por confirmar" />
                </div>
                <p className="plan-meta">
                  {item.amountMxnMinor === 0 ? "Sin pago previsto" : item.paymentDate ? dayLabel(item.paymentDate) : "Fecha por confirmar"}
                  {" · "}{item.scheduleBasis === "partial_month_unknown" ? "Mes parcial"
                    : item.scheduleBasis === "month_override" ? "Excepción del mes" : confidence[item.confidence]}
                  {item.calendarStatus === "cnbv_calendar_provisional" ? " · Calendario provisional" : ""}
                </p>
                {item.paymentDate && item.periodMonth !== total.month && <p className="plan-meta">Periodo {monthKeyLabel(item.periodMonth)}</p>}
              </li>)}</ul>}
            </details>;
          })}
          <details className="plan-disclosure">
            <summary>Fuentes y reglas {paginated ? `de la página ${pageIndex + 1}` : ""}</summary>
            {!active && <p className="plan-meta">Todas estas fuentes están archivadas.</p>}
            <ul className="plan-rows">{page.sources.map(source => <li key={source.id}>
              <div className="plan-row-head"><strong className="plan-sensitive">{source.name}</strong><Amount value={source.amountMxnMinor} /></div>
              {source.employer && <p className="plan-meta plan-sensitive">{source.employer}</p>}
              <p className="plan-meta">{frequency[source.frequency]} · por pago · {confidence[source.confidence]}{source.status === "archived" ? " · Archivada" : ""}</p>
              <p className="plan-meta">{ruleLabels(source)}</p>
              <p className="plan-meta">Inicio {dayLabel(source.startDate)}{source.endDate ? ` · Fin ${dayLabel(source.endDate)}` : ""}</p>
              {source.confirmedTerminationDate && <p className="plan-meta">Salida confirmada {dayLabel(source.confirmedTerminationDate)}</p>}
              {source.monthOverrides?.filter(entry => entry.month >= month && entry.month <= (page.monthlyTotals.at(-1)?.month ?? month)).map(entry =>
                <p key={entry.month} className="plan-meta">Excepción de {monthKeyLabel(entry.month)} · <span className="plan-sensitive">{entry.reason}</span></p>)}
            </li>)}</ul>
          </details>
        </div>;
      })}
      {query.isFetchNextPageError && <ReadState label="No pudimos consultar más fuentes." failed />}
      {query.hasNextPage && <button type="button" className="secondary-button plan-action" disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Consultando…" : "Ver más fuentes"}</button>}
    </section>

    <section className="plan-section plan-payroll">
      <h3>Nómina CFDI registrada</h3>
      <p className="plan-meta">Neto según los XML importados, separado de las expectativas.</p>
      {first.actualPayroll.length === 0 ? <p className="plan-notice">Sin recibos de nómina en este periodo.</p>
        : first.monthlyTotals.filter(total => total.actualPayslipCount > 0).map(total => <details className="plan-disclosure" key={total.month} open={total.month === month}>
          <summary><span>{monthKeyLabel(total.month)}</span><strong><Amount value={total.actualPayrollMxnMinor} /></strong></summary>
          <ul className="plan-rows">{first.actualPayroll.filter(receipt => receipt.paymentDate.slice(0, 7) === total.month).map(receipt =>
            <li key={receipt.id}>
              <div className="plan-row-head"><strong className="plan-sensitive">{receipt.employer ?? "Empleador sin identificar"}</strong><Amount value={receipt.netMxnMinor} /></div>
              <p className="plan-meta">{dayLabel(receipt.paymentDate)}</p>
              <EvidenceButton label="Ver recibo CFDI" onOpen={signal => onOpenPayslip(total.month, receipt.id, signal)} />
            </li>)}</ul>
        </details>)}
    </section>
  </div>;
}
