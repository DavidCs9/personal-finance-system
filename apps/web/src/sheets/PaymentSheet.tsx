import { FormEvent, useState } from "react";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import type { PlannedPayment } from "../monthly-plan";

export function PaymentSheet({
  payment,
  onClose,
  onSave,
  onDelete,
}: {
  payment?: PlannedPayment;
  onClose(): void;
  onSave(value: PlannedPayment): Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(payment?.name ?? "");
  const [amount, setAmount] = useState(payment ? String(payment.amountMinor / 100) : "");
  const [dueDay, setDueDay] = useState(payment?.dueDay ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(amount);
    if (!name.trim() || !Number.isFinite(parsed) || parsed <= 0) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        id: payment?.id ?? `payment-${crypto.randomUUID()}`,
        name: name.trim(),
        amountMinor: Math.round(parsed * 100),
        dueDay,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el pago.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet eyebrow="DINERO COMPROMETIDO" title={payment ? "Editar pago" : "Nuevo pago próximo"} onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        <Field label="Nombre">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ej. Renta"
            required
          />
        </Field>
        <Field label="Cantidad">
          <div className="money-input">
            <span>$</span>
            <input
              inputMode="decimal"
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              required
            />
          </div>
        </Field>
        <Field label="Día de pago">
          <input
            type="number"
            min="1"
            max="31"
            value={dueDay}
            onChange={(event) => setDueDay(Number(event.target.value))}
            required
          />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Guardando…" : "Guardar pago"}
        </button>
        {onDelete && (
          <button
            className="delete-button"
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(undefined);
              void onDelete()
                .catch((reason) =>
                  setError(reason instanceof Error ? reason.message : "No se pudo eliminar el pago."),
                )
                .finally(() => setSaving(false));
            }}
          >
            Eliminar pago
          </button>
        )}
      </form>
    </Sheet>
  );
}
