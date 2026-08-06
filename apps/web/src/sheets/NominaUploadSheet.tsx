import { FormEvent, useRef, useState } from "react";
import { Sheet } from "../components/Sheet";
import { monthDate, monthFormatter } from "../lib/format";
import type { NominaUploadResponse } from "../api/client";

export function NominaUploadSheet({
  month,
  demoMode = false,
  onClose,
  onUpload,
}: {
  month: string;
  demoMode?: boolean;
  onClose(): void;
  onUpload(files: File[]): Promise<NominaUploadResponse>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<NominaUploadResponse>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (demoMode || files.length === 0) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await onUpload(files);
      setResult(response);
      if (response.failed === 0) {
        onClose();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudieron subir las nóminas.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      eyebrow={monthFormatter.format(monthDate(month)).toUpperCase()}
      title="Subir nóminas"
      onClose={onClose}
    >
      {demoMode ? (
        <div className="sheet-form">
          <p>
            En la demo ya hay una nómina de ejemplo en Resumen. Ábrela desde la lista para ver
            liquidez y retenciones. El upload de XML solo funciona en la sesión real.
          </p>
          <button className="primary-button" type="button" onClick={onClose}>
            Entendido
          </button>
        </div>
      ) : (
        <form className="sheet-form" onSubmit={submit}>
          <p>
            Elige uno o varios XML de CFDI nómina. Los válidos se guardan; los que fallen se listan
            sin abortar el resto.
          </p>
          <label className="file-picker">
            <span>{files.length > 0 ? "Cambiar archivos" : "Elegir XML"}</span>
            <input
              ref={inputRef}
              type="file"
              accept=".xml,text/xml,application/xml"
              multiple
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
          </label>
          {files.length > 0 && (
            <p className="file-count">
              {files.length} archivo{files.length === 1 ? "" : "s"} seleccionado
              {files.length === 1 ? "" : "s"}
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          {result && result.failed > 0 && (
            <div className="nomina-upload-result">
              <p>
                Guardadas {result.created}, duplicadas {result.duplicates}, fallidas {result.failed}.
              </p>
              <ul>
                {result.results
                  .filter((item) => item.status === "failed")
                  .map((item) => (
                    <li key={item.filename}>
                      <strong>{item.filename}</strong>
                      <span>{item.error}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <button className="primary-button" type="submit" disabled={saving || files.length === 0}>
            {saving ? "Subiendo…" : "Subir XML"}
          </button>
        </form>
      )}
    </Sheet>
  );
}
