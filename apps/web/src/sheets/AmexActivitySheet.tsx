import { useRef, useEffect, useState, type FormEvent } from "react";
import { ledgerApi } from "../api/client";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";
import { money } from "../lib/format";
import type { AmexImportPreview, AmexImportResult, StatementImportDecision, StatementImportRow } from "../types";

const statusLabels: Record<string, string> = {
  new: "Nuevo", matched: "Vincular al existente", ambiguous: "Revisar coincidencias", duplicate: "Ya registrado",
  excluded: "Pago o abono · fuera del gasto", needs_decision: "Revisar plan MSI", skipped: "Omitido",
};
const needsDecision = (row: StatementImportRow) => row.status === "ambiguous" || row.status === "needs_decision";

export function AmexActivitySheet({ idToken, onClose, onApplied }: {
  idToken: string; onClose(): void; onApplied(result: AmexImportResult): void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<AmexImportPreview>();
  const [decisions, setDecisions] = useState<Record<string, StatementImportDecision>>({});
  const [result, setResult] = useState<AmexImportResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const unresolved = preview?.alreadyApplied ? 0 : preview?.rows?.filter(row => needsDecision(row) && !decisions[row.identity]).length ?? 0;
  const inspect = async (event: FormEvent) => {
    event.preventDefault(); if (!file || busy) return;
    setBusy(true); setError(undefined);
    try {
      const ready = await ledgerApi.previewAmexActivity(file, idToken);
      if (active.current) { setPreview(ready); setDecisions({}); }
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : "No se pudo leer el Excel."); }
    finally { if (active.current) setBusy(false); }
  };
  const apply = async () => {
    if (!preview || unresolved || busy) return;
    setBusy(true); setError(undefined);
    try {
      const applied = await ledgerApi.applyAmexActivity(preview.importId, decisions, idToken);
      // Refresh queries even when the sheet was closed while the request was running.
      if (!active.current) onApplied(applied);
      else setResult(applied);
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : "No se pudo aplicar el Excel."); }
    finally { if (active.current) setBusy(false); }
  };
  const reset = () => { setPreview(undefined); setDecisions({}); setError(undefined); };
  const select = (row: StatementImportRow, value: string) => {
    if (!value) { setDecisions(current => { const next = { ...current }; delete next[row.identity]; return next; }); return; }
    const decision: StatementImportDecision = value === "skip" ? { action: "skip" }
      : value === "create" ? { action: "create" }
        : value === "create_plan" ? { action: "create_plan", months: row.installmentMonths!, cuotaMinor: row.amountMinor }
          : row.kind === "msi" ? { action: "confirm_msi", eventId: value } : { action: "link", eventId: value };
    setDecisions(current => ({ ...current, [row.identity]: decision }));
  };
  return <Sheet eyebrow="ACTIVIDAD AMEX" title={result ? "Actividad importada" : "Importar Excel Amex"}
    onClose={result ? () => onApplied(result) : onClose}>
    {result ? <div className="import-result" role="status">
      <p><strong>{result.summary.created}</strong> movimientos nuevos</p>
      <p><strong>{result.summary.linked}</strong> vinculados a movimientos existentes</p>
      <p><strong>{result.summary.msiConfirmed}</strong> cuotas MSI registradas</p>
      <p><strong>{result.summary.skipped}</strong> omitidos, pagos o ya registrados</p>
      <button type="button" className="primary-button" onClick={() => onApplied(result)}>Ver movimientos</button>
    </div> : !preview ? <form className="sheet-form" onSubmit={event => void inspect(event)}>
      <p>Sube la actividad descargada de la web de Amex. Puedes descargar el periodo completo cada semana.
        Revisarás los movimientos antes de sumarlos.</p>
      <label className="file-field"><span>Archivo Excel (.xlsx) · máximo 2 MB</span>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined); }} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={!file || busy}>{busy ? "Leyendo…" : "Revisar actividad"}</button>
    </form> : <div className="import-preview">
      <p className="import-account">{preview.product} · •••• {preview.accountLastFour}<br />
        Periodo del archivo: {preview.period?.from} a {preview.period?.to}</p>
      <p>Las referencias ya registradas se omiten. Las coincidencias únicas se vinculan y las dudosas requieren tu decisión.
        El periodo del archivo no acredita un estado de cuenta completo.</p>
      {preview.alreadyApplied && <p role="status">Este archivo ya fue aplicado. No se volverán a sumar sus movimientos.</p>}
      <div className="import-summary">
        <div><strong>{preview.summary?.new ?? 0}</strong><span>Nuevos</span></div>
        <div><strong>{preview.summary?.matched ?? 0}</strong><span>Por vincular</span></div>
        <div><strong>{preview.summary?.duplicate ?? 0}</strong><span>Ya registrados</span></div>
        <div><strong>{unresolved}</strong><span>Por decidir</span></div>
      </div>
      <div className="amex-activity-rows">
        {preview.rows?.map(row => <div className="amex-activity-row" key={row.identity}>
          <div><strong>{row.merchantRaw}</strong><small>{row.occurredOn} · {statusLabels[row.status]}</small>
            {row.kind === "msi" && <small>{row.installmentIndex && row.installmentMonths
              ? `Cuota ${row.installmentIndex}/${row.installmentMonths}` : "Cuota sin plazo: requiere PDF para crear o vincular el plan"}</small>}
            {row.purchaseOn && row.purchaseOn !== row.occurredOn && <small>Fecha de compra del archivo: {row.purchaseOn}</small>}
          </div>
          <strong><Amt>{money(row.amountMinor)}</Amt></strong>
          {needsDecision(row) && !preview.alreadyApplied && <label className="amex-activity-decision">
            <span>Decisión para {row.merchantRaw}</span>
            <select value={decisions[row.identity]?.eventId ?? decisions[row.identity]?.action ?? ""}
              disabled={busy} onChange={event => select(row, event.target.value)}>
              <option value="">Elegir…</option>
              {row.candidates?.map(candidate => <option value={candidate.id} key={candidate.id}>
                Vincular: {candidate.merchantRaw}{candidate.occurredAt ? ` · ${candidate.occurredAt.slice(0, 10)}` : ""} · {candidate.id.slice(-6)}
              </option>)}
              {row.kind === "purchase" && <option value="create">Es otra compra: importar como nueva</option>}
              {row.kind === "msi" && !row.candidateEventIds?.length && row.installmentMonths &&
                <option value="create_plan">Crear plan de {row.installmentMonths} cuotas</option>}
              <option value="skip">Omitir este movimiento</option>
            </select>
            {row.kind === "msi" && row.installmentMonths && !row.candidateEventIds?.length && <small>
              Si creas el plan, el total se calculará con la cuota y el plazo leídos. El PDF permitirá contrastarlo.
            </small>}
          </label>}
        </div>)}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="import-footer">
        <button type="button" className="text-button" disabled={busy} onClick={reset}>Volver a revisar</button>
        <button type="button" className="primary-button" disabled={busy || unresolved > 0 && !preview.alreadyApplied}
          onClick={() => void apply()}>{busy ? "Guardando…" : preview.alreadyApplied ? "Ver resultado"
            : unresolved ? `Faltan ${unresolved} decisiones` : "Importar actividad"}</button>
      </div>
    </div>}
  </Sheet>;
}
