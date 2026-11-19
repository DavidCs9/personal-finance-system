import { useState, type FormEvent } from "react";
import { monthKeyLabel } from "../lib/format";
import { PlanningReadDialog } from "../planning/PlanningRead";
import type { MonthlyReceivedTotal } from "@finance/domain";

export type MonthlyReceivedEditor = (amountMinor: number, revision: number) => Promise<void>;

export function MonthlyReceivedDialog({ month, current, save, onClose }: {
  month: string; current?: MonthlyReceivedTotal | null; save: MonthlyReceivedEditor; onClose: () => void;
}) {
  const [revision] = useState(current?.revision ?? 0);
  const [value, setValue] = useState(() => current
    ? `${Math.floor(current.amountMinor / 100)}.${String(current.amountMinor % 100).padStart(2, "0")}` : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(value.trim());
    const minor = parsed ? Number(parsed[1]) * 100 + Number((parsed[2] ?? "").padEnd(2, "0")) : NaN;
    if (!Number.isSafeInteger(minor)) {
      setError("Escribe un importe en pesos con hasta dos decimales, sin separador de miles.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await save(minor, revision);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No pudimos guardar el total. Actualiza el mes y vuelve a intentar.");
    } finally {
      setBusy(false);
    }
  }

  return <PlanningReadDialog title={revision ? "Editar total recibido" : "Registrar total recibido"}
    onClose={() => { if (!busy) onClose(); }} suspended={false}>
    <form className="plan-read-body month-received-form" onSubmit={submit} aria-busy={busy}>
      <p className="plan-meta">{monthKeyLabel(month)} · MXN</p>
      <p>Incluye todo lo que recibiste en el mes, también los abonos que ya registraste.</p>
      <p className="plan-meta">Deja fuera los importes esperados y las devoluciones a tarjeta.</p>
      <label htmlFor="monthly-received-amount">Total recibido en MXN</label>
      <input id="monthly-received-amount" className="amt" inputMode="decimal" autoComplete="off"
        value={value} onChange={event => setValue(event.target.value)} disabled={busy} autoFocus required />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar total"}</button>
    </form>
  </PlanningReadDialog>;
}
