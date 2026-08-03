import { FormEvent, useState } from "react";
import { ledgerApi } from "../api/client";
import { Amt } from "../components/Amt";
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
  const [planDrafts, setPlanDrafts] = useState<
    Readonly<Record<string, { months: string; cuota: string }>>
  >({});
  const [result, setResult] = useState<SantanderImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ambiguous = preview?.rows.filter((row) => row.status === "ambiguous") ?? [];
  const msiDecide = preview?.rows.filter((row) => row.status === "needs_decision") ?? [];
  const decisionOk = (decision: SantanderImportDecision | undefined): boolean => {
    if (!decision) return false;
    if (decision.action === "skip" || decision.action === "create") return true;
    if (decision.action === "link" || decision.action === "confirm_msi") return Boolean(decision.eventId);
    if (decision.action === "create_plan") {
      return Number.isInteger(decision.months) && Number.isInteger(decision.cuotaMinor);
    }
    return false;
  };
  const unresolved =
    ambiguous.filter((row) => !decisionOk(decisions[row.identity])).length
    + msiDecide.filter((row) => !decisionOk(decisions[row.identity])).length;

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await ledgerApi.previewSantanderCsv(file, idToken));
      setDecisions({});
      setPlanDrafts({});
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
            <div className={preview.summary.ambiguous || (preview.summary.needsDecision ?? 0) ? "attention" : ""}>
              <strong>
                {preview.summary.ambiguous + (preview.summary.needsDecision ?? 0)}
              </strong>
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
                      {row.occurredOn} · <Amt>{money(row.amountMinor)}</Amt>
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
          {msiDecide.length > 0 && (
            <section className="ambiguous-list">
              <p className="eyebrow">MSI SIN PLAN</p>
              {msiDecide.map((row) => {
                const draft = planDrafts[row.identity] ?? {
                  months: "3",
                  cuota: (row.amountMinor / 100).toFixed(2),
                };
                const selected = decisions[row.identity];
                return (
                  <div className="ambiguous-row" key={row.identity}>
                    <div>
                      <strong>{row.merchantRaw}</strong>
                      <small>
                        {row.occurredOn} · <Amt>{money(row.amountMinor)}</Amt>
                      </small>
                    </div>
                    <div className="msi-decide">
                      {row.candidates.length > 0 && (
                        <select
                          aria-label={`Confirmar MSI ${row.merchantRaw}`}
                          value={
                            selected?.action === "confirm_msi" || selected?.action === "link"
                              ? selected.eventId ?? ""
                              : ""
                          }
                          onChange={(event) => {
                            const eventId = event.target.value;
                            if (!eventId) return;
                            setDecisions((current) => ({
                              ...current,
                              [row.identity]: { action: "confirm_msi", eventId },
                            }));
                          }}
                        >
                          <option value="" disabled>
                            Confirmar en plan…
                          </option>
                          {row.candidates.map((candidate) => (
                            <option value={candidate.id} key={candidate.id}>
                              {candidate.merchantRaw}
                            </option>
                          ))}
                        </select>
                      )}
                      <label>
                        Meses
                        <input
                          type="number"
                          min={1}
                          max={48}
                          value={draft.months}
                          onChange={(event) =>
                            setPlanDrafts((current) => ({
                              ...current,
                              [row.identity]: { ...draft, months: event.target.value },
                            }))
                          }
                        />
                      </label>
                      <label>
                        Cuota
                        <input
                          type="number"
                          min={0.01}
                          step={0.01}
                          value={draft.cuota}
                          onChange={(event) =>
                            setPlanDrafts((current) => ({
                              ...current,
                              [row.identity]: { ...draft, cuota: event.target.value },
                            }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          const months = Number.parseInt(draft.months, 10);
                          const cuotaMajor = Number.parseFloat(draft.cuota);
                          if (!Number.isInteger(months) || months < 1 || !(cuotaMajor > 0)) return;
                          setDecisions((current) => ({
                            ...current,
                            [row.identity]: {
                              action: "create_plan",
                              months,
                              cuotaMinor: Math.round(cuotaMajor * 100),
                            },
                          }));
                        }}
                      >
                        {selected?.action === "create_plan" ? "Plan listo ✓" : "Crear plan"}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setDecisions((current) => ({
                            ...current,
                            [row.identity]: { action: "skip" },
                          }))
                        }
                      >
                        {selected?.action === "skip" ? "Omitido ✓" : "Omitir"}
                      </button>
                    </div>
                  </div>
                );
              })}
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
                setPlanDrafts({});
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
