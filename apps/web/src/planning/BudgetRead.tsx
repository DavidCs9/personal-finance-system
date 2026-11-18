import { useState } from "react";
import { Amt } from "../components/Amt";
import { monthKeyLabel } from "../lib/format";
import { Amount, EvidenceButton, PlanBar, PlanMetric, ReadState, shortPercent, type PlanningAccess } from "./PlanningRead";
import { useBudgetHistory, useBudgetStatus } from "./planning-queries";

const monthState = { closed: "Cerrado", partial: "En curso", future: "Futuro" } as const;

export function BudgetShortcut({ month, access, onOpen }: { month: string; access: PlanningAccess; onOpen: () => void }) {
  const query = useBudgetStatus(month, access);
  const budget = query.isError ? undefined : query.data;
  return <button type="button" className="summary-shortcut budget-shortcut" onClick={onOpen}>
    <span><strong>Presupuesto del mes</strong>
      <small>{query.isError ? "Consulta no disponible" : !budget ? "Consultando límite y gasto" : budget.configured
        ? "Gasto contado, límites y ritmo" : "Sin límite configurado para este mes"}</small>
    </span>
    {budget?.configured && budget.remainingMxnMinor !== null &&
      <span className={budget.remainingMxnMinor < 0 ? "plan-negative" : undefined}>
        <small>Te quedan del límite</small><strong><Amount value={budget.remainingMxnMinor} /></strong>
      </span>}
    <span className="chevron" aria-hidden="true">→</span>
  </button>;
}

function BudgetHistoryRead({ month, access }: { month: string; access: PlanningAccess }) {
  const query = useBudgetHistory(month, access);
  if (query.isError) return <ReadState label="No pudimos consultar el historial." failed retry={() => void query.refetch()} />;
  if (!query.data) return <ReadState label="Consultando los últimos tres meses…" />;
  return <div className="plan-history">
    <p className="plan-meta">Gasto contado frente al límite de cada mes. El mes en curso es parcial.</p>
    {query.data.months.map(row => <div className="plan-history-row" key={row.month}>
      <div className="plan-row-head"><strong>{monthKeyLabel(row.month)}</strong><span className="plan-meta">{monthState[row.periodStatus]}</span></div>
      <div className="plan-row-head"><span>Gasto <Amount value={row.countedSpentMxnMinor} /></span>
        <span>Límite <Amount value={row.configured ? row.budget?.totalMxnMinor ?? null : null} unknown="Sin configurar" /></span></div>
      {row.configured && row.budget && <PlanBar value={row.countedSpentMxnMinor} limit={row.budget.totalMxnMinor}
        tone={row.warning === "100" ? "over" : undefined} />}
    </div>)}
  </div>;
}

export function BudgetRead({ month, access, onOpenEvent }: {
  month: string; access: PlanningAccess; onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  const query = useBudgetStatus(month, access);
  const [showHistory, setShowHistory] = useState(false);
  const status = query.data;
  const limit = status?.configured ? status.budget?.totalMxnMinor ?? null : null;
  const exclusions = status?.exclusions.filter(entry => entry.status === "active") ?? [];
  const categories = status?.categories.filter(row => row.allocationConfigured || row.grossSpentMxnMinor !== 0) ?? [];
  return <div className="plan-read-body">
    <p className="plan-period">{monthKeyLabel(month)} · MXN</p>
    {query.isError ? <ReadState label="No pudimos consultar el presupuesto de este mes." failed retry={() => void query.refetch()} />
      : !status ? <ReadState label="Consultando presupuesto…" /> : <>
      <section className="plan-feature">
        <p className="plan-meta">{limit === null ? "Gasto del mes" : "Gasto contado"}</p>
        <strong className="plan-big"><Amount value={limit === null ? status.grossSpentMxnMinor : status.countedSpentMxnMinor} /></strong>
        {limit !== null ? <>
          <div className="plan-row-head">
            <span>Límite <Amount value={limit} /></span>
            {status.utilizationPercent !== null && <span><Amt>{shortPercent(status.utilizationPercent)}</Amt> usado</span>}
          </div>
          <PlanBar value={status.countedSpentMxnMinor} limit={limit} marker={status.remainingDays > 0 ? status.elapsedPercent : undefined}
            tone={status.warning === "100" ? "over" : status.warning === "90" || status.warning === "70" ? "watch" : undefined} />
          {status.remainingDays > 0 && <p className="plan-meta">La marca indica <Amt>{shortPercent(status.elapsedPercent)}</Amt> del mes transcurrido.</p>}
          {status.warning === "100" && <p className="plan-negative">
            {status.overspentMxnMinor && status.overspentMxnMinor > 0
              ? <>Excediste el límite por <Amount value={status.overspentMxnMinor} />.</> : "Alcanzaste el límite."}
          </p>}
        </> : <p>Sin límite configurado para este mes. Puedes configurarlo en ChatGPT con Olbia.</p>}
      </section>
      {limit !== null && <dl className="plan-metric-grid">
        <PlanMetric label="Te quedan del límite" value={<Amount value={status.remainingMxnMinor} />} negative={(status.remainingMxnMinor ?? 0) < 0} />
        {status.remainingDays > 0 && <>
          <PlanMetric label="Tras compromisos" value={<Amount value={status.remainingDiscretionaryMxnMinor} />}
            negative={(status.remainingDiscretionaryMxnMinor ?? 0) < 0} />
          <PlanMetric label="Disponible por día" value={<Amount value={status.safeDailyAllowanceMxnMinor} unknown="Sin estimación" />}
            footnote="Según el presupuesto y los compromisos conocidos" />
          <PlanMetric label="Compromisos conocidos" value={<Amount value={status.upcomingCommitmentsMxnMinor} />} />
        </>}
      </dl>}
      {(limit !== null || exclusions.length > 0) && <details className="plan-disclosure">
        <summary>Cómo se compone el gasto</summary>
        <dl className="plan-metric-grid">
          <PlanMetric label="Gasto registrado" value={<Amount value={status.grossSpentMxnMinor} />} />
          <PlanMetric label="Gasto contado" value={<Amount value={status.countedSpentMxnMinor} />} />
          <PlanMetric label="Gasto excluido" value={<Amount value={status.excludedSpentMxnMinor} />} />
          {status.uncertainMxnMinor !== 0 && <PlanMetric label="Importe por confirmar" value={<Amount value={status.uncertainMxnMinor} />} />}
        </dl>
        {exclusions.map(entry => <div className="plan-history-row" key={entry.id}>
          <strong className="plan-sensitive">{entry.reason}</strong>
          {status.inapplicableExclusionIds.includes(entry.id) && <p className="plan-meta">Sin gasto aplicable en este mes.</p>}
          <EvidenceButton label="Ver movimiento excluido" onOpen={signal => onOpenEvent(entry.movementId, signal)} />
        </div>)}
      </details>}
      {limit !== null && <>
        {status.incompleteScheduleMovementIds.length > 0 && <p className="plan-notice">Hay calendarios MSI incompletos. Falta confirmar el importe disponible por día.</p>}
        {status.invalidFixedPaymentLinkIds.length > 0 && <p className="plan-notice">Hay cargos fijos con vínculos por revisar.</p>}
        <section className="plan-section">
          <div className="plan-row-head"><h3>Categorías</h3>
            <span className="plan-meta">Sin asignar <Amount value={status.unallocatedMxnMinor} /></span></div>
          {categories.length === 0 ? <p className="plan-meta">Este mes no tiene categorías con gasto o asignación.</p>
            : <ul className="plan-rows">{categories.map(category => <li key={category.categoryId ?? "uncategorized"}>
              <div className="plan-row-head">
                <strong>{category.label}</strong>
                <span><Amount value={category.countedSpentMxnMinor} /> / <Amount value={category.limitMxnMinor} /></span>
              </div>
              <PlanBar value={category.countedSpentMxnMinor} limit={category.limitMxnMinor ?? 0}
                tone={(category.overspentMxnMinor ?? 0) > 0 ? "over" : undefined} />
              {!category.allocationConfigured && <p className="plan-meta">Sin asignación</p>}
              {(category.overspentMxnMinor ?? 0) > 0 && <p className="plan-meta plan-negative">Sobre el límite por <Amount value={category.overspentMxnMinor} /></p>}
            </li>)}</ul>}
        </section>
      </>}
    </>}
    <details className="plan-disclosure" onToggle={event => setShowHistory(event.currentTarget.open)}>
      <summary>Historial de presupuesto</summary>
      {showHistory && <BudgetHistoryRead month={month} access={access} />}
    </details>
  </div>;
}
