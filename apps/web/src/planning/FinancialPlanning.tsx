import { BudgetRead, BudgetShortcut } from "./BudgetRead";
import { GoalsRead } from "./GoalsRead";
import { IncomeRead } from "./IncomeRead";
import { PlanningReadDialog, type PlanningAccess, type PlanningPane } from "./PlanningRead";

const titles: Record<PlanningPane, string> = {
  budget: "Presupuesto del mes", income: "Ingresos esperados",
};

export function PlanningEntries({ month, access, onOpen, onOpenEvent }: {
  month: string; access: PlanningAccess; onOpen: (pane: PlanningPane) => void;
  onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
}) {
  return <section className="financial-planning-entries" aria-labelledby="financial-planning-title">
    <h2 id="financial-planning-title">Tu plan financiero</h2>
    <GoalsRead access={access} onOpenEvent={onOpenEvent} />
    <BudgetShortcut month={month} access={access} onOpen={() => onOpen("budget")} />
    <button type="button" className="summary-shortcut" onClick={() => onOpen("income")}>
      <span><strong>Ingresos esperados</strong><small>Calendario, excepciones y recibos CFDI</small></span>
      <span className="chevron" aria-hidden="true">→</span>
    </button>
  </section>;
}

export function FinancialPlanningDialog({ pane, month, access, suspended, onClose, onOpenEvent, onOpenPayslip, onUploadNomina }: {
  pane: PlanningPane; month: string; access: PlanningAccess; suspended: boolean; onClose: () => void;
  onOpenEvent: (id: string, signal: AbortSignal) => Promise<void>;
  onOpenPayslip: (month: string, id: string, signal: AbortSignal) => Promise<void>;
  onUploadNomina?: () => void;
}) {
  return <PlanningReadDialog title={titles[pane]} suspended={suspended} onClose={onClose}>
    {pane === "budget" && <BudgetRead month={month} access={access} onOpenEvent={onOpenEvent} />}
    {pane === "income" && <IncomeRead month={month} access={access} onOpenPayslip={onOpenPayslip} onUploadNomina={onUploadNomina} />}
  </PlanningReadDialog>;
}
