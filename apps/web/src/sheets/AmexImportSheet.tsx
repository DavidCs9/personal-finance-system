import { FormEvent, useState } from "react";
import { ledgerApi } from "../api/client";
import { Sheet } from "../components/Sheet";
import { money } from "../lib/format";
import { readStatementText } from "../lib/pdf-text";
import type { AmexImportPreview, AmexImportResult } from "../types";

export function AmexImportSheet({
  idToken,
  onClose,
  onApplied,
}: {
  idToken: string;
  onClose(): void;
  onApplied(result: AmexImportResult): void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<AmexImportPreview>();
  const [result, setResult] = useState<AmexImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const text = await readStatementText(file);
      setPreview(await ledgerApi.previewAmexStatement(text, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo analizar el estado Amex.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await ledgerApi.applyAmexStatement(preview.importId, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo aplicar la conciliación Amex.");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Sheet eyebrow="CONCILIACIÓN TERMINADA" title="Estado Amex aplicado" onClose={() => onApplied(result)}>
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

  return (
    <Sheet eyebrow="ESTADO AMEX" title="Reconciliar MSI" onClose={onClose}>
      {!preview ? (
        <form className="sheet-form" onSubmit={(event) => void inspect(event)}>
          <p>Sube el PDF del estado de cuenta. Confirmamos cuotas MSI y marcamos las que falten por plan.</p>
          <label className="file-field">
            <span>Archivo PDF o texto</span>
            <input
              type="file"
              accept="application/pdf,text/plain,.pdf,.txt"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={!file || busy}>
            {busy ? "Analizando…" : "Analizar estado"}
          </button>
        </form>
      ) : (
        <div className="import-preview">
          <p>
            {preview.product} · {preview.accountLastFour} · {preview.period.from} a {preview.period.to}
          </p>
          <p>
            {preview.summary.matched} a confirmar · {preview.summary.unplanned} sin plan ·{" "}
            {preview.summary.skipped} omitidas
          </p>
          <div className="payment-list">
            {preview.rows.map((row) => (
              <div key={row.identity} className="payment-row" style={{ cursor: "default" }}>
                <span className="date-block">
                  <small>MSI</small>
                  <strong>
                    {row.installmentIndex ? String(row.installmentIndex).padStart(2, "0") : "--"}
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
