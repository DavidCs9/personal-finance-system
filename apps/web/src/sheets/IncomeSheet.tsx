import { FormEvent, useState } from "react";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { monthDate, monthFormatter } from "../lib/format";

export function IncomeSheet({
  month,
  incomeMinor,
  onClose,
  onSave,
}: {
  month: string;
  incomeMinor: number;
  onClose(): void;
  onSave(value: number): Promise<void>;
}) {
  const [value, setValue] = useState(incomeMinor ? String(incomeMinor / 100) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(Math.round(parsed * 100));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el ingreso.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet eyebrow={monthFormatter.format(monthDate(month)).toUpperCase()} title="Ingreso mensual" onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        <p>Registra el total de tus dos depósitos de nómina. Podrás corregirlo cuando quieras.</p>
        <Field label="Total recibido">
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
          {saving ? "Guardando…" : "Guardar ingreso"}
        </button>
      </form>
    </Sheet>
  );
}
