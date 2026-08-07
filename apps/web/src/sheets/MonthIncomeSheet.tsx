import { deriveMonthCompensation } from "@finance/domain";
import { money } from "../lib/format";
import type { MonthlyPlan, Payslip } from "../monthly-plan";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";

const monthLabel = (month: string): string => {
  const formatted = new Intl.DateTimeFormat("es-MX", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T12:00:00Z`));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
};

const payslipDayLabel = (fechaPago: string): { readonly month: string; readonly day: string } => {
  const day = fechaPago.slice(8, 10);
  const month = new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" })
    .format(new Date(`${fechaPago}T12:00:00Z`))
    .replace(".", "")
    .toUpperCase();
  return { month, day };
};

export function MonthIncomeSheet({
  plan,
  onClose,
  onOpenPayslip,
  onUploadNomina,
}: {
  plan: MonthlyPlan;
  onClose(): void;
  onOpenPayslip(payslip: Payslip): void;
  onUploadNomina(): void;
}) {
  const payslips = plan.payslips ?? [];
  const provisionalActive = Boolean(plan.provisionalActive);
  const estimateActive = Boolean(plan.estimateActive) && (plan.estimatedMinor ?? 0) > 0;
  const depositedMinor = plan.depositedMinor ?? payslips.reduce((sum, slip) => sum + slip.totalMinor, 0);
  const compensation = deriveMonthCompensation({
    payslips,
    incomeMinor: plan.incomeMinor,
    estimateActive,
    provisionalActive,
  });
  const fondoTotalMinor = compensation.fondoMinor + compensation.estimatedFondoMinor;

  return (
    <Sheet
      eyebrow={monthLabel(plan.month)}
      title="Nómina del mes"
      onClose={onClose}
      className="month-income-sheet"
    >
      <div className="month-income-hero">
        <p>{provisionalActive ? "Liquidez provisional" : "Liquidez del mes"}</p>
        <strong>
          <Amt>{money(plan.incomeMinor)}</Amt>
        </strong>
        <span>
          {provisionalActive
            ? "Patrón de nóminas ordinarias anteriores hasta subir el XML de este mes."
            : "Suma de netos depositados (CFDI Total) por FechaPago."}
          {estimateActive ? " Incluye estimado de la 2ª quincena." : ""}
        </span>
      </div>

      {compensation.compensationAvailable && (
        <div className="month-compensation">
          <p>Compensación del mes</p>
          <strong>
            <Amt>{money(compensation.compensationMinor)}</Amt>
          </strong>
          <span>
            Liquidez <Amt>{money(plan.incomeMinor)}</Amt>
            {" · "}
            Fondo <Amt>{money(fondoTotalMinor)}</Amt>
            {compensation.fondoEstimateActive ? " (incluye estimado de 2ª quincena)" : ""}
          </span>
        </div>
      )}

      <ul className="month-income-lines">
        {payslips.map((payslip) => {
          const label = payslipDayLabel(payslip.fechaPago);
          return (
            <li key={payslip.uuid}>
              <button type="button" className="month-income-row" onClick={() => onOpenPayslip(payslip)}>
                <span className="date-block">
                  <small>{label.month}</small>
                  <strong>{label.day}</strong>
                </span>
                <span className="payment-name">
                  <strong>
                    {payslip.tipoNomina === "O" ? "Nómina ordinaria" : "Nómina extraordinaria"}
                  </strong>
                  <small>{payslip.employerName ?? "Neto depositado"}</small>
                </span>
                <strong className="payment-amount">
                  <Amt>{money(payslip.totalMinor)}</Amt>
                </strong>
                <span className="chevron">›</span>
              </button>
            </li>
          );
        })}

        {estimateActive && (
          <li>
            <div className="month-income-row is-estimate">
              <span className="date-block estimate-mark" aria-hidden="true">
                <small>≈</small>
                <strong>—</strong>
              </span>
              <span className="payment-name">
                <strong>2ª quincena estimada</strong>
                <small>Misma liquidez que la ordinaria ya depositada</small>
              </span>
              <strong className="payment-amount">
                <Amt>{money(plan.estimatedMinor ?? 0)}</Amt>
              </strong>
            </div>
          </li>
        )}

        {provisionalActive && payslips.length === 0 && (
          <li>
            <div className="month-income-row is-estimate">
              <span className="date-block estimate-mark" aria-hidden="true">
                <small>≈</small>
                <strong>—</strong>
              </span>
              <span className="payment-name">
                <strong>Liquidez provisional</strong>
                <small>Pendiente nómina de este mes</small>
              </span>
              <strong className="payment-amount">
                <Amt>{money(plan.provisionalMinor ?? plan.incomeMinor)}</Amt>
              </strong>
            </div>
          </li>
        )}
      </ul>

      <div className="month-income-total">
        <span>
          {provisionalActive
            ? "Total provisional"
            : estimateActive
              ? "Depositado + estimado"
              : "Total depositado"}
        </span>
        <strong>
          <Amt>{money(plan.incomeMinor)}</Amt>
        </strong>
      </div>

      {!provisionalActive && estimateActive && depositedMinor > 0 && (
        <p className="month-income-footnote">
          Depositado: <Amt>{money(depositedMinor)}</Amt>
          {" · "}
          Estimado: <Amt>{money(plan.estimatedMinor ?? 0)}</Amt>
        </p>
      )}

      {(provisionalActive || payslips.length === 0) && (
        <button type="button" className="primary-button month-income-upload" onClick={onUploadNomina}>
          Subir nómina XML
        </button>
      )}
    </Sheet>
  );
}
