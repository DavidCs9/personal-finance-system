import { FormEvent, useState } from "react";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import type { PlannedPayment } from "../monthly-plan";
import { PaymentReconciliation, type ObservedEvent } from "../components/PaymentReconciliation";

export function PaymentSheet({
  payment,
  month,
  candidates,
  candidatesLoading,
  candidatesError,
  onRetryCandidates,
  onReconcile,
  onOpenEvent,
  onClose,
  onSave,
  onDelete,
}: {
  payment?: PlannedPayment;
  month: string;
  candidates: readonly ObservedEvent[];
  candidatesLoading: boolean;
  candidatesError?: string;
  onRetryCandidates?: () => void;
  onReconcile?: (eventId: string | null) => Promise<void>;
  onOpenEvent?: (eventId: string) => void;
  onClose(): void;
  onSave(value: PlannedPayment): Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(payment?.name ?? "");
  const [amount, setAmount] = useState(payment ? String(payment.amountMinor / 100) : "");
  const [dueDay, setDueDay] = useState(payment?.dueDay ?? 1);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string>();
  const parsedAmountMinor = Math.round(Number(amount) * 100);
  const changed = Boolean(payment && (name.trim() !== payment.name || parsedAmountMinor !== payment.amountMinor || dueDay !== payment.dueDay));
  const busy = saving || reconciling;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(amount);
    if (busy || !name.trim() || !Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(parsedAmountMinor)
      || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        id: payment?.id ?? `payment-${crypto.randomUUID()}`,
        name: name.trim(),
        amountMinor: Math.round(parsed * 100),
        dueDay,
        ...(payment?.reconciliation && !changed ? { reconciliation: payment.reconciliation } : {}),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el pago.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      eyebrow="GASTOS FIJOS"
      title={payment ? "Editar gasto fijo" : "Nuevo gasto fijo"}
      onClose={() => { if (!busy) onClose(); }}
    >
      <p className="sheet-lede">
        Servicios, suscripciones y otros cargos que se repiten cada mes, sin fecha de fin. Los MSI
        se gestionan desde el plan de la compra.
      </p>
      <form className="sheet-form" onSubmit={submit}>
        <Field label="Nombre">
          <input
            autoFocus
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ej. iCloud, renta, celular"
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
              disabled={busy}
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
            disabled={busy}
          />
        </Field>
        {payment?.reconciliation && changed ? <p className="payment-reconciliation-warning">
          Si guardas cambios en nombre, cantidad o día, se desvinculará el cobro de este fijo en el mes elegido.
        </p> : null}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>
          {saving ? "Guardando…" : "Guardar gasto fijo"}
        </button>
        {onDelete && (
          <button
            className="delete-button"
            type="button"
            disabled={busy || Boolean(payment?.reconciliation)}
            onClick={() => {
              if (busy || payment?.reconciliation) return;
              setSaving(true);
              setError(undefined);
              void onDelete()
                .catch((reason) =>
                  setError(reason instanceof Error ? reason.message : "No se pudo eliminar el gasto."),
                )
                .finally(() => setSaving(false));
            }}
          >
            Eliminar gasto fijo
          </button>
        )}
        {onDelete && payment?.reconciliation ? <p className="payment-reconciliation-warning">
          Desvincula el cobro antes de eliminar este gasto fijo, también si el vínculo requiere revisión.
        </p> : null}
      </form>
      {payment ? <PaymentReconciliation key={`${month}:${payment.id}:${payment.reconciliation?.eventId ?? "none"}:${payment.reconciliation?.valid ?? "none"}`}
        payment={payment} month={month} candidates={candidates} candidatesLoading={candidatesLoading}
        candidatesError={candidatesError} onRetryCandidates={onRetryCandidates} onReconcile={onReconcile}
        onOpenEvent={onOpenEvent} disabled={saving || changed} onBusyChange={setReconciling} /> : <p className="sheet-lede">
        Guarda el gasto fijo antes de vincular un cobro observado.
      </p>}
    </Sheet>
  );
}
