import { FormEvent, useState } from "react";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { institutionLabel } from "../lib/format";
import type { CardCycle } from "../card-cycle";

const CARD_INSTITUTIONS = ["american_express_mx", "santander_mx", "nu_mx"] as const;

export function CardSheet({
  card,
  onClose,
  onSave,
  onDelete,
}: {
  card?: CardCycle;
  onClose(): void;
  onSave(value: CardCycle): Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(card?.name ?? "");
  const [cutOffDay, setCutOffDay] = useState(card?.cutOffDay ?? 15);
  const [paymentDueDay, setPaymentDueDay] = useState(card?.paymentDueDay ?? 1);
  const [institution, setInstitution] = useState<CardCycle["institution"] | "">(
    card?.institution ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        id: card?.id ?? `card-${crypto.randomUUID()}`,
        name: name.trim(),
        cutOffDay,
        paymentDueDay,
        ...(institution ? { institution } : {}),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar la tarjeta.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      eyebrow="CICLOS DE TARJETA"
      title={card ? "Editar tarjeta" : "Nueva tarjeta"}
      onClose={onClose}
    >
      <p className="sheet-lede">
        Día de corte y día de pago. Estas fechas no restan de “Te quedan”; solo marcan el ciclo y
        disparan avisos si activaste Avisos de Olbia.
      </p>
      <form className="sheet-form" onSubmit={submit}>
        <Field label="Nombre">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ej. Amex Gold, Nu, Santander"
            required
          />
        </Field>
        <Field label="Institución (opcional)">
          <select
            value={institution}
            onChange={(event) =>
              setInstitution((event.target.value || "") as CardCycle["institution"] | "")
            }
          >
            <option value="">Sin especificar</option>
            {CARD_INSTITUTIONS.map((value) => (
              <option key={value} value={value}>
                {institutionLabel(value)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Día de corte">
          <input
            type="number"
            min="1"
            max="31"
            value={cutOffDay}
            onChange={(event) => setCutOffDay(Number(event.target.value))}
            required
          />
        </Field>
        <Field label="Día de pago">
          <input
            type="number"
            min="1"
            max="31"
            value={paymentDueDay}
            onChange={(event) => setPaymentDueDay(Number(event.target.value))}
            required
          />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Guardando…" : "Guardar tarjeta"}
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
                  setError(
                    reason instanceof Error ? reason.message : "No se pudo eliminar la tarjeta.",
                  ),
                )
                .finally(() => setSaving(false));
            }}
          >
            Eliminar tarjeta
          </button>
        )}
      </form>
    </Sheet>
  );
}
