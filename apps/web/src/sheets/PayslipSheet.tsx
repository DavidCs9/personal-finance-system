import { money } from "../lib/format";
import type { Payslip, PayslipLine } from "../monthly-plan";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";

const kindLabel = (kind: PayslipLine["kind"]): string => {
  if (kind === "percepcion") return "Percepción";
  if (kind === "deduccion") return "Deducción";
  return "Otro pago";
};

const groupLabel = (group: PayslipLine["group"]): string => {
  if (group === "fondo") return "Fondo de ahorro";
  if (group === "isr") return "ISR";
  if (group === "imss") return "IMSS";
  return "Otro";
};

export function PayslipSheet({
  payslip,
  onClose,
}: {
  payslip: Payslip;
  onClose(): void;
}) {
  const fondoRetained = payslip.lines
    .filter((line) => line.group === "fondo" && line.kind === "deduccion")
    .reduce((sum, line) => sum + line.amountMinor, 0);

  return (
    <Sheet
      eyebrow={payslip.fechaPago}
      title="Desglose de nómina"
      onClose={onClose}
      className="payslip-sheet"
    >
      <div className="payslip-summary">
        <div>
          <p>Liquidez</p>
          <strong>
            <Amt>{money(payslip.totalMinor)}</Amt>
          </strong>
          <span>neto depositado</span>
        </div>
        <div>
          <p>Ahorro retenido</p>
          <strong>
            <Amt>{money(fondoRetained)}</Amt>
          </strong>
          <span>fondo (tus descuentos)</span>
        </div>
      </div>
      {payslip.employerName && <p className="payslip-employer">{payslip.employerName}</p>}
      <ul className="payslip-lines">
        {payslip.lines.map((line) => (
          <li key={`${line.kind}-${line.clave}-${line.concepto}`}>
            <div>
              <strong>{line.concepto}</strong>
              <span>
                {kindLabel(line.kind)} · {groupLabel(line.group)}
                {line.notCashInBank ? " · no es efectivo en banco" : ""}
              </span>
            </div>
            <Amt>{money(line.amountMinor)}</Amt>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
