import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ledgerApi } from "../api/client";
import type { FixedExpenseChange, FixedExpenseEntry, FixedExpensePreview } from "../api/fixed-expense-types";
import { Amt } from "../components/Amt";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { money, monthKeyLabel } from "../lib/format";

export function FixedExpenseSheet({ initialMonth, initialId, idToken, onClose, onApplied }: {
  initialMonth: string;
  initialId?: string;
  idToken: string;
  onClose(): void;
  onApplied(): Promise<void>;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [scope, setScope] = useState<FixedExpenseChange["scope"]>("recurring");
  const [id, setId] = useState(initialId ?? "");
  const [locked, setLocked] = useState(false);
  const query = useQuery({
    queryKey: ["fixed-expenses", month],
    queryFn: () => ledgerApi.fixedExpenses(month, idToken),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
  const entries = query.data?.expenses.filter(entry => scope === "recurring" ? entry.recurring : entry.recurring || (entry.override && entry.override.status !== "inherit")) ?? [];
  const selected = entries.find(entry => entry.id === id);
  return (
    <Sheet eyebrow="PLANIFICACIÓN" title="Configurar gastos fijos" onClose={() => { if (!locked) onClose(); }}>
      <div className="sheet-form">
        <Field label="Mes de vigencia">
          <input type="month" value={month} min={query.data?.currentMonth} disabled={locked} required
            onChange={event => setMonth(event.target.value)} />
        </Field>
        <Field label="Alcance">
          <select value={scope} disabled={locked} onChange={event => setScope(event.target.value as FixedExpenseChange["scope"])}>
            <option value="recurring">Recurrente desde este mes</option>
            <option value="month">Sólo este mes</option>
          </select>
        </Field>
        {query.isPending && month ? <p role="status">Consultando gastos fijos…</p> : null}
        {query.isError ? <p role="alert">No se pudieron consultar los gastos fijos. <button type="button" className="text-button"
          onClick={() => { void query.refetch(); }}>Reintentar</button></p> : null}
        {query.data ? <Field label="Gasto fijo">
          <select value={id} disabled={locked} onChange={event => setId(event.target.value)}>
            <option value="">Nuevo gasto fijo</option>
            {id && !selected ? <option value={id} disabled>Gasto seleccionado (sin configuración)</option> : null}
            {entries.map(entry => {
              const configuration = scope === "month" && entry.override?.status !== "inherit" ? entry.override ?? entry.recurring : entry.recurring;
              return <option key={entry.id} value={entry.id}>
                {configuration?.name ?? entry.occurrence?.name}{configuration?.status === "archived" ? " · Archivado" : ""}
              </option>;
            })}
          </select>
        </Field> : null}
      </div>
      {query.data && !query.isError && (selected || !id) && month >= query.data.currentMonth ?
        <FixedExpenseForm key={JSON.stringify([month, scope, id, selected?.expectedRevision])}
          month={month} scope={scope} entry={selected} idToken={idToken} setLocked={setLocked} onApplied={onApplied} />
        : query.data && month < query.data.currentMonth ? <p>Este mes ya está cerrado.</p>
          : query.data && id && !selected ? <p>El gasto elegido no tiene configuración para este alcance en este mes.</p> : null}
    </Sheet>
  );
}

function FixedExpenseForm({ month, scope, entry, idToken, setLocked, onApplied }: {
  month: string;
  scope: FixedExpenseChange["scope"];
  entry?: FixedExpenseEntry;
  idToken: string;
  setLocked(locked: boolean): void;
  onApplied(): Promise<void>;
}) {
  const prior = scope === "month" && entry?.override?.status !== "inherit" ? entry?.override ?? entry?.recurring : entry?.recurring;
  const defaultAction = !entry ? "create" : prior?.status === "archived" ? "restore" : "update";
  const [action, setAction] = useState<FixedExpenseChange["action"]>(defaultAction);
  const [name, setName] = useState(prior?.name ?? "");
  const [amount, setAmount] = useState(prior ? String(prior.amountMinor / 100) : "");
  const [dueDay, setDueDay] = useState(prior?.dueDay ?? 1);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<FixedExpensePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const edits = action === "create" || action === "update";
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setLocked(true);
    setError(undefined);
    try { await work(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "No pudimos guardar el gasto fijo."); }
    finally { setBusy(false); setLocked(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (preview) {
        try {
          await ledgerApi.applyFixedExpense(preview.operationId, idToken);
        } catch (failure) {
          const receipt = await ledgerApi.financialWriteStatus(preview.operationId, idToken);
          if (receipt.status !== "applied") {
            if (receipt.status === "failed" || receipt.status === "expired") setPreview(undefined);
            throw failure;
          }
        }
        await onApplied();
      } else {
        setPreview(await ledgerApi.previewFixedExpense({
          action, scope, month, reason,
          ...(entry ? { paymentId: entry.id, expectedRevision: entry.expectedRevision } : {}),
          ...(edits ? { name, amountMinor: Math.round(Number(amount) * 100), dueDay } : {}),
        }, idToken));
      }
    });
  };
  const blocked = scope === "month" && Boolean(entry?.linkedMovementId);

  return <form className="sheet-form" onSubmit={submit}>
    {preview ? <>
      <p>{preview.after.name} · {monthKeyLabel(month)} · {scope === "month" ? "Sólo este mes" : "Recurrente"}</p>
      {prior?.status === "active" && action === "update" ? <p>Programación anterior · {prior.name} · <Amt>{money(prior.amountMinor)}</Amt> · día {prior.dueDay}</p> : null}
      {preview.after.status === "active" ? <p><Amt>{money(preview.after.amountMinor)}</Amt> · día {preview.after.dueDay}</p>
        : <p>{preview.after.status === "archived" ? "Archivar gasto fijo" : "Quitar ajuste mensual"}</p>}
      {preview.nextEffectiveMonth ? <p>Hay otra versión a partir de {monthKeyLabel(preview.nextEffectiveMonth)}.</p> : null}
      {preview.linkedOccurrenceRetained ? <p>El cobro vinculado conserva su programación en este mes.</p> : null}
    </> : <>
      {entry ? <Field label="Acción">
        <select value={action} disabled={busy} onChange={event => setAction(event.target.value as FixedExpenseChange["action"])}>
          {prior?.status === "archived" ? <option value="restore">Restaurar</option> : <>
            <option value="update">Editar</option><option value="archive">Archivar</option>
          </>}
          {scope === "month" && entry.override && entry.override.status !== "inherit" ?
            <option value="clear_override">Quitar ajuste mensual</option> : null}
        </select>
      </Field> : null}
      {edits ? <>
        <Field label="Nombre"><input required maxLength={100} value={name} disabled={busy}
          onChange={event => setName(event.target.value)} /></Field>
        <Field label="Cantidad MXN"><input required type="number" min="0.01" step="0.01" value={amount} disabled={busy}
          onChange={event => setAmount(event.target.value)} /></Field>
        <Field label="Día de pago"><input required type="number" min="1" max="31" value={dueDay} disabled={busy}
          onChange={event => setDueDay(event.target.valueAsNumber)} /></Field>
      </> : null}
      <Field label="Motivo"><input required maxLength={200} value={reason} disabled={busy}
        onChange={event => setReason(event.target.value)} /></Field>
    </>}
    {blocked ? <p>Este mes tiene un cobro vinculado. Elige un cambio recurrente o un mes posterior.</p> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <button className="primary-button" type="submit" disabled={busy || blocked}>
      {busy ? "Procesando…" : preview ? "Confirmar cambio" : "Revisar cambio"}
    </button>
    {preview ? <button type="button" className="text-button" disabled={busy} onClick={() => setPreview(undefined)}>Volver a editar</button> : null}
  </form>;
}
