import { useState, type FormEvent } from "react";
import type { PayrollCloseCandidate, PayrollClosure } from "@finance/domain";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";

type ClosureInput = Omit<PayrollClosure, "employerName"> & { payslipUuid: string };

export function PayrollClosureSheet({ candidate, today, onClose, onSave }: {
  candidate: PayrollCloseCandidate;
  today: string;
  onClose: () => void;
  onSave: (input: ClosureInput) => Promise<void>;
}) {
  const [endedOn, setEndedOn] = useState("");
  const [fundPaidOn, setFundPaidOn] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fundPaidMinor = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(fundPaidMinor) || fundPaidMinor <= 0) {
      setError("Escribe el monto recibido del fondo.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave({ payslipUuid: candidate.payslipUuid, endedOn, fundPaidOn, fundPaidMinor });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cerrar la nómina.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet eyebrow={candidate.employerName} title="Cerrar nómina y fondo" onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        <p className="sheet-lede">Olbia deja de estimar esta nómina y deja de contar el fondo en tu neto desde la fecha del depósito.</p>
        <Field label="Último día de trabajo">
          <input type="date" value={endedOn} max={today} onChange={event => setEndedOn(event.target.value)} required />
        </Field>
        <Field label="Fecha del depósito del fondo">
          <input type="date" value={fundPaidOn} min={endedOn || undefined} max={today} onChange={event => setFundPaidOn(event.target.value)} required />
        </Field>
        <Field label="Depósito del fondo en MXN">
          <div className="money-input">
            <span>$</span>
            <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount}
              onChange={event => setAmount(event.target.value)} placeholder="0.00" required />
          </div>
        </Field>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Guardando…" : "Confirmar cierre"}
        </button>
      </form>
    </Sheet>
  );
}
