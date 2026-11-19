import { useId, useState } from "react";
import type { GoalSummary } from "../api/planning-types";
import { longDateFormatter } from "../lib/format";
import { Amount, dayLabel, EvidenceButton, ReadState, type PlanningAccess } from "./PlanningRead";
import { useFinancialGoal, useFinancialGoals } from "./planning-queries";

const statusLabel = { planned: "Planeada", active: "Activa", completed: "Completada", archived: "Archivada" } as const;
const actionLabel: Readonly<Record<string, string>> = {
  create_goal: "Meta creada", update_goal: "Meta actualizada", archive_goal: "Meta archivada",
  add_allocation: "Partida añadida", update_allocation: "Partida actualizada", archive_allocation: "Partida archivada",
  record_payment: "Pago registrado", correct_payment: "Pago corregido", void_payment: "Pago anulado",
};

function GoalHistory({ id, access }: { id: string; access: PlanningAccess }) {
  const query = useFinancialGoal(id, access);
  const history = query.data?.history;
  return <>
    {query.isError && <ReadState failed retry={() => void query.refetch()}
      label={history ? "No pudimos actualizar el historial. Se muestra la última lectura." : "No pudimos consultar el historial."} />}
    {query.isPending && <ReadState label="Consultando historial…" />}
    {history && (history.length === 0 ? <p className="plan-meta">No hay cambios registrados.</p> :
          <ul className="plan-rows">{history.map(change => <li key={change.operationId}>
            <strong>{Object.hasOwn(actionLabel, change.action) ? actionLabel[change.action] : "Cambio registrado"}</strong>
            <p className="plan-meta">{longDateFormatter.format(new Date(change.appliedAt))}</p>
          </li>)}</ul>)}
  </>;
}

function GoalDetail({ goal, access, onOpenEvent }: {
  goal: GoalSummary; access: PlanningAccess;
  onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return <div className="goal-detail">
    <dl className="goal-detail-metrics">
      <div><dt>Presupuesto original</dt><dd><Amount value={goal.originalBudgetMxnMinor} /></dd></div>
      <div><dt>Sin asignar, incluido en el pendiente</dt><dd><Amount value={goal.unallocatedMxnMinor} /></dd></div>
    </dl>
    <h4>Partidas y pagos</h4>
    {goal.allocations.length === 0 && <p className="plan-meta">Sin partidas asignadas.</p>}
    {goal.allocations.map(allocation => {
      const payments = goal.payments.filter(payment => payment.allocationId === allocation.id);
      return <details key={allocation.id} className="plan-disclosure goal-allocation">
        <summary>
          <span className="goal-allocation-summary">
            <span className="plan-row-head">
              <strong className="plan-sensitive">{allocation.name}{allocation.status === "archived" ? " · Archivada" : ""}</strong>
              <span><Amount value={allocation.remainingMxnMinor} /> por pagar</span>
            </span>
            <span className="plan-meta"><Amount value={allocation.paidMxnMinor} /> pagados de <Amount value={allocation.allocatedMxnMinor} /> asignados</span>
          </span>
        </summary>
        {allocation.expectedPaymentDate && <p className="plan-meta">Fecha prevista {dayLabel(allocation.expectedPaymentDate)}</p>}
        {!payments.length && <p className="plan-meta">Sin pagos registrados.</p>}
        <ul className="plan-rows">{payments.map(payment => {
          const warning = goal.linkedPaymentWarnings.find(item => item.paymentId === payment.id);
          const movement = payment.ledgerMovementId;
          return <li key={payment.id}>
            <div className="plan-row-head"><strong>{dayLabel(payment.paymentDate)}</strong><Amount value={payment.amountMxnMinor} /></div>
            <p className="plan-meta">{payment.status === "voided" ? "Pago anulado · " : ""}
              {payment.source === "manual_attestation" ? "Pago declarado" : "Cargo de Ledger vinculado"}</p>
            {warning && <p className="plan-notice">{warning.message}</p>}
            {movement && <EvidenceButton label="Ver movimiento vinculado" onOpen={signal => onOpenEvent(movement, signal)} />}
          </li>;
        })}</ul>
      </details>;
    })}
    <details className="plan-disclosure" onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary>Historial de cambios</summary>
      {historyOpen && <GoalHistory id={goal.id} access={access} />}
    </details>
  </div>;
}

function GoalCard({ goal, group, access, onOpenEvent }: {
  goal: GoalSummary; group: string; access: PlanningAccess;
  onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // These proportions only draw the three amounts already calculated by Olbia.
  const portion = (amount: number) => `${goal.totalBudgetMxnMinor > 0 ? amount / goal.totalBudgetMxnMinor * 100 : 0}%`;
  return <details className="goal-card" name={group} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="goal-overview">
      <span className="goal-card-top">
        <span>
          <strong className="goal-name plan-sensitive">{goal.name}</strong>
          <span className="plan-meta goal-date">{goal.status !== "active" ? `${statusLabel[goal.status]} · ` : ""}
            {goal.targetDate ? dayLabel(goal.targetDate) : "Sin fecha objetivo"}</span>
        </span>
        <span className="goal-outstanding"><strong><Amount value={goal.remainingMxnMinor} /></strong>
          <span className="plan-meta">Pendiente total</span></span>
        <span className="goal-chevron" aria-hidden="true" />
      </span>
      <span className="plan-bar goal-progress" aria-hidden="true">
        <span className="goal-paid" style={{ width: portion(goal.paidMxnMinor) }} />
        <span className="goal-allocated" style={{ width: portion(goal.outstandingAllocatedMxnMinor) }} />
        <span className="goal-unallocated" style={{ width: portion(goal.unallocatedMxnMinor) }} />
      </span>
      <span className="goal-card-figures">
        <span>Pagado <strong><Amount value={goal.paidMxnMinor} /></strong></span>
        <span>Presupuesto vigente <strong><Amount value={goal.totalBudgetMxnMinor} /></strong></span>
      </span>
      {goal.linkedPaymentWarnings.length > 0 && <span className="plan-meta plan-negative">Revisar evidencia de pago</span>}
    </summary>
    {open && <GoalDetail goal={goal} access={access} onOpenEvent={onOpenEvent} />}
  </details>;
}

const byTargetDate = (a: GoalSummary, b: GoalSummary) =>
  (a.targetDate ?? "9999-12-31").localeCompare(b.targetDate ?? "9999-12-31") || a.name.localeCompare(b.name, "es-MX");

export function GoalsRead({ access, onOpenEvent }: {
  access: PlanningAccess; onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  const group = useId();
  const query = useFinancialGoals(access);
  const goals = query.data?.pages.flatMap(page => page.goals).sort(byTargetDate);
  const visible = goals?.filter(goal => goal.status !== "archived") ?? [];
  const archived = goals?.filter(goal => goal.status === "archived") ?? [];
  return <section className="goal-section" aria-labelledby={group}>
    <header className="goal-section-header">
      <h3 id={group}>Metas financieras</h3>
      <span className="plan-meta">Todos los periodos · MXN</span>
    </header>
    {!goals ? <ReadState label={query.isError ? "No pudimos consultar tus metas." : "Consultando tus metas…"}
      failed={query.isError} retry={query.isError ? () => void query.refetch() : undefined} /> : <>
      {query.isRefetchError && <ReadState label="No pudimos actualizar la consulta. Se muestra la última lectura."
        failed retry={() => void query.refetch()} />}
      {!visible.length && !query.hasNextPage && <p className="plan-notice">{archived.length ? "Todas tus metas están archivadas." : "Crea tu primera meta en ChatGPT con Olbia."}</p>}
      {visible.length > 0 && <div className="goal-read-list">{visible.map(goal =>
        <GoalCard key={goal.id} goal={goal} group={group} access={access} onOpenEvent={onOpenEvent} />)}</div>}
      {goals.length > 0 && <div className="goal-legend">
        <span><b className="goal-paid" aria-hidden="true" />Pagado</span>
        <span><b className="goal-allocated" aria-hidden="true" />Partidas por pagar</span>
        <span><b className="goal-unallocated" aria-hidden="true" />Sin asignar</span>
      </div>}
      {archived.length > 0 && <details className="plan-disclosure"><summary>Metas archivadas</summary>
        <div className="goal-read-list">{archived.map(goal =>
          <GoalCard key={goal.id} goal={goal} group={group} access={access} onOpenEvent={onOpenEvent} />)}</div>
      </details>}
      {query.isFetchNextPageError && <ReadState label="No pudimos consultar más metas." failed />}
      {query.hasNextPage && <button type="button" className="secondary-button plan-action" disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Consultando…" : "Ver más metas"}</button>}
    </>}
  </section>;
}
