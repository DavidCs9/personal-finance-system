import { FormEvent, useEffect, useRef, useState } from "react";
import { ledgerApi } from "../api/client";
import { Sheet } from "../components/Sheet";
import { money } from "../lib/format";
import type {
  AmexImportPreview,
  AmexImportResult,
  StatementImportDecision,
} from "../types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Provider = "amex" | "santander";

export function StatementImportSheet({
  provider,
  idToken,
  onClose,
  onApplied,
}: {
  provider: Provider;
  idToken: string;
  onClose(): void;
  onApplied(result: AmexImportResult): void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<AmexImportPreview>();
  const [decisions, setDecisions] = useState<Readonly<Record<string, StatementImportDecision>>>({});
  const [result, setResult] = useState<AmexImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelledRef = useRef(false);
  const ambiguous = preview?.rows?.filter((row) => row.status === "ambiguous") ?? [];
  const unresolved = ambiguous.filter((row) => !decisions[row.identity]).length;
  const label = provider === "amex" ? "Amex" : "Santander";

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const waitUntilReady = async (importId: string): Promise<AmexImportPreview> => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      if (cancelledRef.current) throw new Error("Importación cancelada.");
      const status =
        provider === "amex"
          ? await ledgerApi.getAmexStatementImport(importId, idToken)
          : await ledgerApi.getSantanderStatementImport(importId, idToken);
      if (status.status === "ready" && status.rows) return status;
      await sleep(2_000);
    }
    throw new Error("Textract tardó demasiado. Intenta de nuevo en un momento.");
  };

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const started =
        provider === "amex"
          ? await ledgerApi.previewAmexStatement(file, idToken)
          : await ledgerApi.previewSantanderStatement(file, idToken);
      if (started.status === "ready" && started.rows) {
        setPreview(started);
        setDecisions({});
        return;
      }
      setPreview(started);
      const ready = await waitUntilReady(started.importId);
      if (!cancelledRef.current) {
        setPreview(ready);
        setDecisions({});
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `No se pudo analizar el estado ${label}.`,
      );
      setPreview(undefined);
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || preview.status !== "ready" || unresolved > 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const applied =
        provider === "amex"
          ? await ledgerApi.applyAmexStatement(preview.importId, decisions, idToken)
          : await ledgerApi.applySantanderStatement(preview.importId, decisions, idToken);
      setResult(applied);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `No se pudo aplicar la conciliación ${label}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Sheet
        eyebrow="CONCILIACIÓN TERMINADA"
        title={`Estado ${label} aplicado`}
        onClose={() => onApplied(result)}
      >
        <div className="import-result">
          <span className="result-mark">✓</span>
          <p>
            <strong>{result.summary.created}</strong> movimientos nuevos
          </p>
          <p>
            <strong>{result.summary.linked}</strong> conciliados
          </p>
          <p>
            <strong>{result.summary.msiConfirmed}</strong> cuotas MSI confirmadas
          </p>
          <p>
            <strong>{result.summary.createdUnplanned}</strong> MSI sin plan
          </p>
          <p>
            <strong>{result.summary.skipped}</strong> omitidos
          </p>
          <button className="primary-button" onClick={() => onApplied(result)}>
            Ver movimientos
          </button>
        </div>
      </Sheet>
    );
  }

  const readyPreview =
    preview?.status === "ready" && preview.rows && preview.summary
      ? preview
      : undefined;

  return (
    <Sheet eyebrow={`ESTADO ${label.toUpperCase()}`} title="Conciliar periodo" onClose={onClose}>
      {!readyPreview ? (
        <form className="sheet-form" onSubmit={(event) => void inspect(event)}>
          <p>
            Sube el PDF del estado de cuenta. Conciliamos compras del periodo y confirmamos cuotas
            MSI.
          </p>
          <label className="file-field">
            <span>Archivo PDF</span>
            <input
              type="file"
              accept="application/pdf,text/plain,.pdf,.txt"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
          {preview?.status === "processing" && (
            <p className="form-hint">Leyendo el PDF con Textract… esto puede tomar un minuto.</p>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={!file || busy}>
            {busy ? "Analizando…" : "Analizar estado"}
          </button>
        </form>
      ) : (
        <div className="import-preview">
          <p>
            {readyPreview.product} · {readyPreview.accountLastFour} · {readyPreview.period?.from} a{" "}
            {readyPreview.period?.to}
          </p>
          <div className="import-summary">
            <div>
              <strong>{readyPreview.summary?.new ?? 0}</strong>
              <span>Nuevos</span>
            </div>
            <div>
              <strong>{readyPreview.summary?.matched ?? 0}</strong>
              <span>Conciliados</span>
            </div>
            <div>
              <strong>{readyPreview.summary?.unplanned ?? 0}</strong>
              <span>MSI sin plan</span>
            </div>
            <div className={readyPreview.summary?.ambiguous ? "attention" : ""}>
              <strong>{readyPreview.summary?.ambiguous ?? 0}</strong>
              <span>Por decidir</span>
            </div>
          </div>
          {(readyPreview.summary?.excluded ?? 0) > 0 && (
            <p className="import-note">
              {readyPreview.summary?.excluded} pago o abono queda fuera del gasto.
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
                    {(row.candidates ?? []).map((candidate) => (
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
          <div className="payment-list">
            {(readyPreview.rows ?? []).slice(0, 40).map((row) => (
              <div key={row.identity} className="payment-row" style={{ cursor: "default" }}>
                <span className="date-block">
                  <small>{row.kind === "msi" ? "MSI" : "CMP"}</small>
                  <strong>
                    {row.kind === "msi" && row.installmentIndex
                      ? String(row.installmentIndex).padStart(2, "0")
                      : row.occurredOn.slice(8, 10)}
                  </strong>
                </span>
                <span className="payment-name">
                  <strong>{row.merchantRaw}</strong>
                  <small>
                    {row.status === "new"
                      ? "Nuevo"
                      : row.status === "matched"
                        ? row.kind === "msi"
                          ? "Cuota a confirmar"
                          : "Coincide"
                        : row.status === "unplanned"
                          ? "MSI sin plan"
                          : row.status === "ambiguous"
                            ? "Por decidir"
                            : row.status === "duplicate"
                              ? "Ya cargado"
                              : row.status === "excluded"
                                ? "Fuera de gasto"
                                : "Sin acción"}
                  </small>
                </span>
                <strong className="payment-amount">{money(row.amountMinor)}</strong>
              </div>
            ))}
          </div>
          {error && <p className="form-error">{error}</p>}
          <button
            className="primary-button"
            type="button"
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
      )}
    </Sheet>
  );
}
