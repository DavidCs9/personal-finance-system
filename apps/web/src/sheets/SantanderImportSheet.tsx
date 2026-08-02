import { FormEvent, useState } from "react";
import { ledgerApi } from "../api/client";
import { Sheet } from "../components/Sheet";
import { money } from "../lib/format";
import type {
  SantanderImportDecision,
  SantanderImportPreview,
  SantanderImportResult,
} from "../types";

export function SantanderImportSheet({
  idToken,
  onClose,
  onApplied,
}: {
  idToken: string;
  onClose(): void;
  onApplied(result: SantanderImportResult): void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<SantanderImportPreview>();
  const [decisions, setDecisions] = useState<Readonly<Record<string, SantanderImportDecision>>>({});
  const [result, setResult] = useState<SantanderImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ambiguous = preview?.rows.filter((row) => row.status === "ambiguous") ?? [];
  const unresolved = ambiguous.filter((row) => !decisions[row.identity]).length;

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await ledgerApi.previewSantanderCsv(file, idToken));
      setDecisions({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo analizar el CSV.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || unresolved > 0) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await ledgerApi.applySantanderCsv(preview.importId, decisions, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo aplicar la conciliación.");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Sheet eyebrow="CONCILIACIÓN TERMINADA" title="CSV Santander aplicado" onClose={() => onApplied(result)}>
        <div className="import-result">
          <span className="result-mark">✓</span>
          <p>
            <strong>{result.summary.created}</strong> movimientos nuevos
          </p>
          <p>
            <strong>{result.summary.linked}</strong> conciliados con correo
          </p>
          <p>
            <strong>{result.summary.skipped}</strong> omitidos o ya existentes
          </p>
          <button className="primary-button" onClick={() => onApplied(result)}>
            Ver movimientos
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet eyebrow="RESPALDO SANTANDER" title="Conciliar movimientos" onClose={onClose}>
      {!preview ? (
        <form className="sheet-form" onSubmit={inspect}>
          <p>
            Selecciona el CSV descargado desde Santander. Primero verás una previsualización; ningún
            movimiento se guardará todavía.
          </p>
          <label className="file-drop">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setError(undefined);
              }}
            />
            <span>{file ? file.name : "Seleccionar CSV de Santander"}</span>
            <small>{file ? `${Math.ceil(file.size / 1024)} KB` : "Máximo 2 MB"}</small>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={!file || busy}>
            {busy ? "Analizando…" : "Previsualizar conciliación"}
          </button>
        </form>
      ) : (
        <div className="import-preview">
          <p className="import-account">
            Tarjeta •••• {preview.accountLastFour} · {preview.period.from} a {preview.period.to}
          </p>
          <div className="import-summary">
            <div>
              <strong>{preview.summary.new}</strong>
              <span>Nuevos</span>
            </div>
            <div>
              <strong>{preview.summary.matched}</strong>
              <span>Con correo</span>
            </div>
            <div>
              <strong>{preview.summary.duplicate}</strong>
              <span>Ya cargados</span>
            </div>
            <div className={preview.summary.ambiguous ? "attention" : ""}>
              <strong>{preview.summary.ambiguous}</strong>
              <span>Por decidir</span>
            </div>
          </div>
          {preview.summary.excluded > 0 && (
            <p className="import-note">
              {preview.summary.excluded} pago o abono queda fuera del gasto mensual.
            </p>
          )}
          {ambiguous.length > 0 && (
            <section className="ambiguous-list">
              <p className="eyebrow">DECISIONES NECESARIAS</p>
              {ambiguous.map((row) => (
                <div className="ambiguous-row" key={row.identity}>
                  <div>
                    <strong>{row.merchantRaw}</strong>
                    <small>
                      {row.occurredOn} · {money(row.amountMinor)}
                    </small>
                  </div>
                  <select
                    aria-label={`Decisión para ${row.merchantRaw}`}
                    value={
                      decisions[row.identity]?.action === "create"
                        ? "create"
                        : decisions[row.identity]?.eventId ?? ""
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setDecisions((current) => ({
                        ...current,
                        [row.identity]:
                          value === "create"
                            ? { action: "create" }
                            : { action: "link", eventId: value },
                      }));
                    }}
                  >
                    <option value="" disabled>
                      Elegir…
                    </option>
                    {row.candidates.map((candidate) => (
                      <option value={candidate.id} key={candidate.id}>
                        Vincular: {candidate.merchantRaw}
                      </option>
                    ))}
                    <option value="create">Importar como nuevo</option>
                  </select>
                </div>
              ))}
            </section>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="import-footer">
            <button
              className="text-button"
              onClick={() => {
                setPreview(undefined);
                setFile(undefined);
                setDecisions({});
              }}
            >
              Elegir otro archivo
            </button>
            <button
              className="primary-button"
              disabled={busy || unresolved > 0}
              onClick={() => void apply()}
            >
              {busy
                ? "Aplicando…"
                : unresolved > 0
                  ? `Faltan ${unresolved} decisiones`
                  : "Aplicar conciliación"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
