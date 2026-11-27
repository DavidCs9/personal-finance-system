import { useState } from "react";
import { dayKeyInZone, type BankCredit, type IncomeOccurrence } from "@finance/domain";
import type { MonthDashboard } from "../api/planning-types";
import { Amt } from "../components/Amt";
import { exactMxn, institutionLabel, money, monthKeyLabel } from "../lib/format";
import { PlanningReadDialog } from "../planning/PlanningRead";
import { MonthlyReceivedDialog, type MonthlyReceivedEditor } from "./MonthlyReceivedDialog";
export type { MonthlyReceivedEditor } from "./MonthlyReceivedDialog";
import "./month-entries.css";

const shortDay = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLabel = (day: string) => shortDay.format(new Date(`${day}T12:00:00Z`));
const amount = (value: number) => value % 100 === 0 ? money(value) : exactMxn(value);
type Entry = { kind: "posted"; credit: BankCredit } | { kind: "expected"; occurrence: IncomeOccurrence };
const creditType = (credit: BankCredit) => credit.creditType === "card_payment" ? "Pago de tarjeta" : credit.creditType === "refund"
  ? credit.accountKind === "credit_card" ? "Devolución a tarjeta" : "Devolución a cuenta"
  : credit.incomeType === "finiquito" ? "Finiquito" : credit.incomeType === "nomina" ? "Nómina" : "Otro ingreso";

export function MonthEntryDetail({ entry, needsReconciliation }: { entry: Entry; needsReconciliation: boolean }) {
  if (entry.kind === "posted") {
    const credit = entry.credit;
    return <div className="month-entry-detail">
      <strong className="month-entry-detail-amount"><Amt>{amount(credit.amountMinor)}</Amt></strong>
      <p>{credit.accountKind === "credit_card" ? "Acreditada a tarjeta" : "Recibido"}</p>
      <dl>
        <div><dt>Concepto</dt><dd className="plan-sensitive">{credit.description}</dd></div>
        <div><dt>Tipo</dt><dd>{creditType(credit)}</dd></div>
        <div><dt>Fecha de acreditación</dt><dd>{dayLabel(credit.postedOn)}</dd></div>
        <div><dt>{credit.accountKind === "credit_card" ? "Tarjeta" : "Cuenta"}</dt>
          <dd>{institutionLabel(credit.institution)} · <span className="plan-sensitive">•• {credit.accountLastFour}</span></dd></div>
        <div><dt>Referencia bancaria</dt><dd className="plan-sensitive">{credit.evidenceReference}</dd></div>
      </dl>
      <p className="month-entry-note">{credit.creditType === "refund"
        ? credit.accountKind === "credit_card" ? "Esta devolución no se suma al efectivo recibido ni modifica la compra original."
          : "Incluida en lo recibido. Conserva su tipo de devolución y no modifica la compra original."
        : "Abono bancario registrado. No modifica los saldos capturados de tus cuentas."}</p>
    </div>;
  }
  const item = entry.occurrence;
  return <div className="month-entry-detail">
    <strong className="month-entry-detail-amount">{item.amountMxnMinor === null ? "Por confirmar" : <Amt>{amount(item.amountMxnMinor)}</Amt>}</strong>
    <p>{needsReconciliation || item.reconciliationStatus === "possible_payroll_overlap" ? "Por conciliar" : "Esperado"}
      {item.confidence === "estimated" ? " · Importe estimado" : " · Expectativa confirmada"}</p>
    <dl>
      <div><dt>Concepto</dt><dd className="plan-sensitive">{item.name}</dd></div>
      {item.employer && <div><dt>Empleador</dt><dd className="plan-sensitive">{item.employer}</dd></div>}
      <div><dt>Fecha esperada</dt><dd>{item.paymentDate ? dayLabel(item.paymentDate) : "Por confirmar"}</dd></div>
      <div><dt>Periodo</dt><dd>{monthKeyLabel(item.periodMonth)}</dd></div>
    </dl>
    {item.calendarStatus === "cnbv_calendar_provisional" && <p className="month-entry-note">La fecha usa un calendario bancario provisional.</p>}
    <p className="month-entry-note">{needsReconciliation || item.reconciliationStatus === "possible_payroll_overlap"
      ? "Falta conciliar esta programación con los ingresos registrados; no se considera dinero recibido ni pendiente confirmado."
      : "Esta expectativa no acredita un depósito y sólo se muestra en Por recibir."}</p>
  </div>;
}

export function MonthEntries({ month, dashboard, editor }: { month: string; dashboard: MonthDashboard; editor?: MonthlyReceivedEditor }) {
  const [editing, setEditing] = useState(false);
  const declared = dashboard.monthlyReceived;
  const [selected, setSelected] = useState<Entry>();
  const credits = dashboard.postedCredits;
  const future = dashboard.futureIncome;
  const cashCredits = credits.credits.filter(item => item.accountKind === "cash");
  const cardPayments = credits.cardPayments ?? [];
  const cardCredits = credits.credits.filter(item => item.accountKind === "credit_card");
  const expected = (future.occurrences ?? []).filter(item => item.amountMxnMinor !== 0);
  const today = dayKeyInZone(new Date(dashboard.generatedAt));
  const scheduledKnown = future.knownScheduledMinor ?? future.knownUpcomingMinor;
  const needsReconciliation = future.status === "reconciliation_needed";
  const expectedStatus = future.status === "closed" ? "Mes cerrado" : future.status === "unconfigured" ? "Sin programación"
    : needsReconciliation ? "Por conciliar" : "Por confirmar";
  const close = () => setSelected(undefined);
  const postedRow = (credit: BankCredit) => <li key={credit.movementId}>
    <button type="button" className="month-entry-row" onClick={() => setSelected({ kind: "posted", credit })}>
      <span className="month-entry-copy"><strong className="plan-sensitive">{credit.description}</strong>
        <small>{credit.creditType === "income" ? "Recibido" : creditType(credit)} · {dayLabel(credit.postedOn)}</small></span>
      <strong className="month-entry-amount"><Amt>{amount(credit.amountMinor)}</Amt></strong>
      <span className="chevron" aria-hidden="true">›</span>
    </button>
  </li>;
  return <section className="summary-budget-panel summary-entries" aria-labelledby="month-entries-title">
    <h2 id="month-entries-title">Entradas del mes</h2>
    <p>{monthKeyLabel(month)} · MXN</p>
    <dl className="month-entries-totals">
      <div><dt>{declared ? "Recibido" : "Recibido registrado"}</dt>
        <dd>{declared ? <Amt>{amount(declared.amountMinor)}</Amt> : cashCredits.length > 0
          ? <Amt>{amount(credits.recordedOperatingCashInflowsMinor)}</Amt> : <span className="month-entry-unknown">Sin registros</span>}</dd>
        {declared && <small>Declarado por ti</small>}
        {editor && !dashboard.summary.isFutureMonth && <button className="text-button plan-action month-received-edit"
          type="button" onClick={() => setEditing(true)}>{declared ? "Editar total recibido" : "Registrar total recibido"}</button>}
      </div>
      <div><dt>Por recibir</dt><dd>{future.scheduledMinor !== null
        ? <Amt>{amount(future.scheduledMinor)}</Amt> : <span className="month-entry-unknown">{expectedStatus}</span>}</dd>
        {future.scheduledMinor !== null && expected.some(item => item.confidence === "estimated") && <small>Incluye estimados</small>}
      </div>
    </dl>
    {future.hasMore && <p className="month-entry-note">La programación está incompleta. Hay más fuentes en Planificación → Ingresos esperados.</p>}
    {future.scheduledMinor === null && scheduledKnown > 0 && <p className="month-entry-note">
      Subtotal programado <Amt>{amount(scheduledKnown)}</Amt>
      {future.unknownOccurrences > 0 && <> · {future.unknownOccurrences === 1 ? "1 entrada por confirmar" : `${future.unknownOccurrences} entradas por confirmar`}</>}.
    </p>}
    {needsReconciliation && <p className="month-entry-note">Falta conciliar los ingresos registrados con la programación.</p>}
    {declared && cashCredits.length > 0 && <p className="month-entry-note">
      Abonos en Olbia: <Amt>{amount(credits.recordedOperatingCashInflowsMinor)}</Amt>. El total declarado se guarda aparte.
    </p>}
    <ul className="month-entries-list">
      {cashCredits.map(postedRow)}
      {expected.map(item => <li key={item.occurrenceId}>
        <button type="button" className="month-entry-row expected" onClick={() => setSelected({ kind: "expected", occurrence: item })}>
          <span className="month-entry-copy"><strong className="plan-sensitive">{item.name}</strong>
            <small>{needsReconciliation || item.reconciliationStatus === "possible_payroll_overlap"
              || item.paymentDate && item.paymentDate <= today ? "Por conciliar" : "Esperado"}
              {" · "}{item.paymentDate ? dayLabel(item.paymentDate) : "Fecha por confirmar"}
              {item.confidence === "estimated" ? " · Estimado" : ""}</small></span>
          <strong className="month-entry-amount">{item.amountMxnMinor === null ? <span className="month-entry-unknown">Por confirmar</span>
            : <Amt>{amount(item.amountMxnMinor)}</Amt>}</strong>
          <span className="chevron" aria-hidden="true">›</span>
        </button>
      </li>)}
    </ul>
    {!declared && credits.credits.length === 0 && expected.length === 0 && <p className="month-entry-empty">Sin entradas registradas para este mes.</p>}
    {cardPayments.length > 0 && <div className="month-entry-card-refunds">
      <h3>Pagos de tarjeta</h3><ul className="month-entries-list">{cardPayments.map(postedRow)}</ul>
    </div>}
    {cardCredits.length > 0 && <div className="month-entry-card-refunds">
      <h3>Devoluciones a tarjeta</h3><p>Fuera del efectivo recibido.</p>
      <ul className="month-entries-list">{cardCredits.map(postedRow)}</ul>
    </div>}
    {editing && editor && <MonthlyReceivedDialog month={month} current={declared} save={editor} onClose={() => setEditing(false)} />}
    {selected && <PlanningReadDialog title="Detalle de entrada" onClose={close} suspended={false}>
      <MonthEntryDetail entry={selected} needsReconciliation={needsReconciliation
        || Boolean(selected.kind === "expected" && selected.occurrence.paymentDate && selected.occurrence.paymentDate <= today)} />
    </PlanningReadDialog>}
  </section>;
}
