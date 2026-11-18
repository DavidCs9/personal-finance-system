import { useEffect, useRef, useState } from "react";
import type { GoalSummary } from "../api/planning-types";
import { longDateFormatter } from "../lib/format";
import { Amount, dayLabel, EvidenceButton, PlanBar, PlanMetric, ReadState, type PlanningAccess } from "./PlanningRead";
import { useFinancialGoal, useFinancialGoals } from "./planning-queries";

const statusLabel = { planned: "Planeada", active: "Activa", completed: "Completada", archived: "Archivada" } as const;
const actionLabel: Readonly<Record<string, string>> = {
  create_goal: "Meta creada", update_goal: "Meta actualizada", archive_goal: "Meta archivada",
  add_allocation: "Partida añadida", update_allocation: "Partida actualizada", archive_allocation: "Partida archivada",
  record_payment: "Pago registrado", correct_payment: "Pago corregido", void_payment: "Pago anulado",
};

function GoalDetailRead({ id, access, onBack, onOpenEvent }: {
  id: string; access: PlanningAccess; onBack: () => void;
  onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  const query = useFinancialGoal(id, access);
  const goal = query.data;
  return <div className="plan-read-body">
    <button type="button" className="text-button plan-action plan-back" autoFocus onClick={onBack}>← Todas las metas</button>
    {query.isError ? <ReadState label="No pudimos consultar esta meta." failed retry={() => void query.refetch()} />
      : !goal ? <ReadState label="Consultando meta…" /> : <>
      <section className="plan-feature">
        <p className="plan-meta">{statusLabel[goal.status]}{goal.targetDate ? ` · Fecha objetivo ${dayLabel(goal.targetDate)}` : ""}</p>
        <h3 className="plan-goal-title plan-sensitive">{goal.name}</h3>
        <p className="plan-meta">Pendiente total</p>
        <strong className="plan-big"><Amount value={goal.remainingMxnMinor} /></strong>
        <PlanBar value={goal.paidMxnMinor} limit={goal.totalBudgetMxnMinor} />
        <div className="plan-row-head">
          <span>Pagado <Amount value={goal.paidMxnMinor} /></span>
          <span>Presupuesto <Amount value={goal.totalBudgetMxnMinor} /></span>
        </div>
      </section>
      <dl className="plan-metric-grid">
        <PlanMetric label="Presupuesto original" value={<Amount value={goal.originalBudgetMxnMinor} />} />
        <PlanMetric label="Asignado" value={<Amount value={goal.allocatedMxnMinor} />} />
        <PlanMetric label="Sin asignar" value={<Amount value={goal.unallocatedMxnMinor} />} />
        <PlanMetric label="Pendiente de partidas" value={<Amount value={goal.outstandingAllocatedMxnMinor} />} />
      </dl>
      <section className="plan-section">
        <h3>Partidas y pagos</h3>
        <p className="plan-meta">Los pagos de la meta se muestran por su fuente. Un vínculo abre el cobro registrado.</p>
        {goal.allocations.length === 0 && <p className="plan-notice">Sin partidas asignadas.</p>}
        {goal.allocations.map(allocation => {
          const payments = goal.payments.filter(payment => payment.allocationId === allocation.id);
          return <details key={allocation.id} className="plan-disclosure">
            <summary><span className="plan-sensitive">{allocation.name}{allocation.status === "archived" ? " · Archivada" : ""}</span>
              <small>Pendiente <Amount value={allocation.remainingMxnMinor} /></small></summary>
            {allocation.expectedPaymentDate && <p className="plan-meta">Fecha prevista {dayLabel(allocation.expectedPaymentDate)}</p>}
            <PlanBar value={allocation.paidMxnMinor} limit={allocation.allocatedMxnMinor} />
            <div className="plan-row-head">
              <span>Pagado <Amount value={allocation.paidMxnMinor} /></span>
              <span>Asignado <Amount value={allocation.allocatedMxnMinor} /></span>
            </div>
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
      </section>
      <details className="plan-disclosure">
        <summary>Historial de cambios</summary>
        {!goal.history.length ? <p className="plan-meta">No hay cambios registrados.</p> :
          <ul className="plan-rows">{goal.history.map(change => <li key={change.operationId}>
            <strong>{Object.hasOwn(actionLabel, change.action) ? actionLabel[change.action] : "Cambio registrado"}</strong>
            <p className="plan-meta">{longDateFormatter.format(new Date(change.appliedAt))}</p>
          </li>)}</ul>}
      </details>
    </>}
  </div>;
}

function GoalRow({ goal, onOpen, focused }: { goal: GoalSummary; onOpen: () => void; focused: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);
  return <button ref={ref} type="button" className="goal-read-row" onClick={onOpen}>
    <span className="plan-row-head"><strong className="plan-sensitive">{goal.name}</strong><span aria-hidden="true">→</span></span>
    <span className="plan-meta">{statusLabel[goal.status]}{goal.targetDate ? ` · ${dayLabel(goal.targetDate)}` : ""}</span>
    <PlanBar value={goal.paidMxnMinor} limit={goal.totalBudgetMxnMinor} />
    <span className="plan-row-head">
      <span>Pagado <Amount value={goal.paidMxnMinor} /></span>
      <span>Pendiente <Amount value={goal.remainingMxnMinor} /></span>
    </span>
  </button>;
}

export function GoalsRead({ access, onOpenEvent }: {
  access: PlanningAccess; onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string>();
  const lastGoal = useRef<string | undefined>(undefined);
  const query = useFinancialGoals(access);
  const goals = query.data?.pages.flatMap(page => page.goals);
  if (selected) return <GoalDetailRead access={access} id={selected} onBack={() => { lastGoal.current = selected; setSelected(undefined); }} onOpenEvent={onOpenEvent} />;
  const visible = goals?.filter(goal => goal.status !== "archived") ?? [];
  const archived = goals?.filter(goal => goal.status === "archived") ?? [];
  return <div className="plan-read-body">
    <p className="plan-meta">Presupuestos, partidas y pagos de tus metas. Configúralas en ChatGPT con Olbia.</p>
    {!goals ? <ReadState label={query.isError ? "No pudimos consultar tus metas." : "Consultando tus metas…"}
      failed={query.isError} retry={query.isError ? () => void query.refetch() : undefined} /> : <>
      {query.isRefetchError && <ReadState label="No pudimos actualizar la consulta. Se muestra la última lectura."
        failed retry={() => void query.refetch()} />}
      {!visible.length && <p className="plan-notice">{goals.length ? "Las metas de esta lista están archivadas." : "Aún no hay metas configuradas en Olbia."}</p>}
      <div className="goal-read-list">{visible.map(goal => <GoalRow key={goal.id} goal={goal} focused={lastGoal.current === goal.id} onOpen={() => setSelected(goal.id)} />)}</div>
      {archived.length > 0 && <details className="plan-disclosure"><summary>Metas archivadas</summary>
        <div className="goal-read-list">{archived.map(goal => <GoalRow key={goal.id} goal={goal} focused={lastGoal.current === goal.id} onOpen={() => setSelected(goal.id)} />)}</div>
      </details>}
      {query.isFetchNextPageError && <ReadState label="No pudimos consultar más metas." failed />}
      {query.hasNextPage && <button type="button" className="secondary-button plan-action" disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Consultando…" : "Ver más metas"}</button>}
    </>}
  </div>;
}
