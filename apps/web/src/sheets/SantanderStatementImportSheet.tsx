import { FormEvent, useEffect, useRef, useState } from "react";
import { ledgerApi } from "../api/client";
import { Sheet } from "../components/Sheet";
import { money } from "../lib/format";
import type {
  SantanderStatementImportPreview,
  SantanderStatementImportResult,
} from "../types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function SantanderStatementImportSheet({
  idToken,
  onClose,
  onApplied,
}: {
  idToken: string;
  onClose(): void;
  onApplied(result: SantanderStatementImportResult): void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<SantanderStatementImportPreview>();
  const [result, setResult] = useState<SantanderStatementImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const waitUntilReady = async (
    importId: string,
  ): Promise<SantanderStatementImportPreview> => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      if (cancelledRef.current) throw new Error("Importación cancelada.");
      const status = await ledgerApi.getSantanderStatementImport(importId, idToken);
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
      const started = await ledgerApi.previewSantanderStatement(file, idToken);
      if (started.status === "ready" && started.rows) {
        setPreview(started);
        return;
      }
      setPreview(started);
      const ready = await waitUntilReady(started.importId);
      if (!cancelledRef.current) setPreview(ready);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "No se pudo analizar el estado Santander.",
      );
      setPreview(undefined);
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || preview.status !== "ready") return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await ledgerApi.applySantanderStatement(preview.importId, idToken));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "No se pudo aplicar la conciliación Santander.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Sheet
        eyebrow="CONCILIACIÓN TERMINADA"
        title="Estado Santander aplicado"
        onClose={() => onApplied(result)}
      >
        <div className="import-result">
          <span className="result-mark">✓</span>
          <p>
            <strong>{result.summary.confirmed}</strong> cuotas MSI confirmadas
          </p>
          <p>
            <strong>{result.summary.createdUnplanned}</strong> MSI sin plan por completar
          </p>
          <p>
            <strong>{result.summary.skipped}</strong> omitidas
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
    <Sheet eyebrow="ESTADO SANTANDER" title="Reconciliar MSI" onClose={onClose}>
      {!readyPreview ? (
        <form className="sheet-form" onSubmit={(event) => void inspect(event)}>
          <p>
            Sube el PDF del estado de cuenta. Lo leemos con Textract y confirmamos las
            cuotas A MESES del periodo.
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
          <p>
            {readyPreview.summary?.matched} a confirmar · {readyPreview.summary?.unplanned} sin plan ·{" "}
            {readyPreview.summary?.skipped} omitidas
          </p>
          <div className="payment-list">
            {(readyPreview.rows ?? []).map((row) => (
              <div key={row.identity} className="payment-row" style={{ cursor: "default" }}>
                <span className="date-block">
                  <small>MSI</small>
                  <strong>
                    {row.installmentIndex
                      ? String(row.installmentIndex).padStart(2, "0")
                      : "--"}
                  </strong>
                </span>
                <span className="payment-name">
                  <strong>{row.merchantRaw}</strong>
                  <small>
                    {row.status === "matched"
                      ? "Coincide con plan"
                      : row.status === "unplanned"
                        ? "MSI sin plan"
                        : "Sin acción"}
                  </small>
                </span>
                <strong className="payment-amount">{money(row.amountMinor)}</strong>
              </div>
            ))}
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="button" disabled={busy} onClick={() => void apply()}>
            {busy ? "Aplicando…" : "Confirmar cuotas"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
