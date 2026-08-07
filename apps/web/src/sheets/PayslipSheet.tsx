import { useState } from "react";
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

const sumGroup = (payslip: Payslip, group: PayslipLine["group"], kind?: PayslipLine["kind"]): number =>
  payslip.lines
    .filter((line) => line.group === group && (kind === undefined || line.kind === kind))
    .reduce((sum, line) => sum + line.amountMinor, 0);

export function PayslipSheet({
  payslip,
  onClose,
}: {
  payslip: Payslip;
  onClose(): void;
}) {
  const [showSatLines, setShowSatLines] = useState(false);
  const fondoRetained = sumGroup(payslip, "fondo", "deduccion");
  const isrMinor = sumGroup(payslip, "isr");
  const imssMinor = sumGroup(payslip, "imss");
  const employerFondo = sumGroup(payslip, "fondo", "percepcion");

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

      <div className="payslip-withholdings">
        <div>
          <p>ISR</p>
          <strong>
            <Amt>{money(isrMinor)}</Amt>
          </strong>
        </div>
        <div>
          <p>IMSS</p>
          <strong>
            <Amt>{money(imssMinor)}</Amt>
          </strong>
        </div>
        {employerFondo > 0 && (
          <div>
            <p>Fondo empresa</p>
            <strong>
              <Amt>{money(employerFondo)}</Amt>
            </strong>
            <span>no es efectivo en banco</span>
          </div>
        )}
      </div>

      {payslip.employerName && <p className="payslip-employer">{payslip.employerName}</p>}

      <p className="payslip-lede">
        {payslip.tipoNomina === "O" ? "Nómina ordinaria" : "Nómina extraordinaria"}
        {payslip.fechaInicialPago && payslip.fechaFinalPago
          ? ` · ${payslip.fechaInicialPago} → ${payslip.fechaFinalPago}`
          : ""}
      </p>

      <button
        type="button"
        className="payslip-sat-toggle"
        aria-expanded={showSatLines}
        onClick={() => setShowSatLines((open) => !open)}
      >
        <span>{showSatLines ? "Ocultar líneas del CFDI" : "Ver líneas del CFDI"}</span>
        <span aria-hidden="true">{showSatLines ? "▴" : "▾"}</span>
      </button>

      {showSatLines && (
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
      )}
    </Sheet>
  );
}
