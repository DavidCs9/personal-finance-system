import { FormEvent, useState } from "react";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";

export function CajitaSheet({
  currentMinor,
  onClose,
  onSave,
}: {
  currentMinor?: number;
  onClose(): void;
  onSave(amountMinor: number): Promise<void>;
}) {
  const [value, setValue] = useState(currentMinor ? String(currentMinor / 100) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Escribe un monto válido en pesos.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave(Math.round(parsed * 100));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el saldo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet eyebrow="CAJITA NU" title="Registrar saldo" onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        <p className="sheet-lede">
          Solo el monto en MXN. La fecha es de hoy y la captura no se edita después.
        </p>
        <Field label="Saldo actual">
          <div className="money-input">
            <span>$</span>
            <input
              autoFocus
              inputMode="decimal"
              type="number"
              min="1"
              step="0.01"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="0.00"
            />
          </div>
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Guardando…" : "Guardar saldo"}
        </button>
      </form>
    </Sheet>
  );
}
