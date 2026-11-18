import { FormEvent, useState } from "react";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";

export function CashBalanceSheet({
  accountName,
  allowsZero,
  currentMinor,
  onClose,
  onSave,
}: {
  accountName: string;
  allowsZero: boolean;
  currentMinor?: number;
  onClose(): void;
  onSave(amountMinor: number): Promise<void>;
}) {
  const [value, setValue] = useState(currentMinor === undefined ? "" : String(currentMinor / 100));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(value);
    const amountMinor = Math.round(parsed * 100);
    if (!value.trim() || !Number.isSafeInteger(amountMinor) || amountMinor < (allowsZero ? 0 : 1)) {
      setError("Escribe un monto válido en pesos.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave(amountMinor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el saldo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet eyebrow={accountName} title="Registrar saldo" onClose={onClose}>
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
              min={allowsZero ? "0" : "0.01"}
              step="0.01"
              required
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
