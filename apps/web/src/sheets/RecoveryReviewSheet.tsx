import { useEffect, useState } from "react";
import { Sheet } from "../components/Sheet";
import { recoveryMessage } from "../lib/recovery";
import type { IngestionException } from "../types";

export function RecoveryReviewSheet({
  exception,
  onClose,
  onRetry,
  onDiscard,
  onReadRaw,
}: {
  exception: IngestionException;
  onClose(): void;
  onRetry(): Promise<void>;
  onDiscard(): Promise<void>;
  onReadRaw(): Promise<string>;
}) {
  const [rawEmail, setRawEmail] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadRaw = () => {
    setBusy(true);
    setError(undefined);
    void onReadRaw()
      .then(setRawEmail)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "No se pudo leer la fuente."))
      .finally(() => setBusy(false));
  };

  useEffect(loadRaw, [exception.id]);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    void action()
      .then(onClose)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "No se pudo actualizar este correo."),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Sheet
      eyebrow="CORREO POR REVISAR"
      title={exception.institution ?? "Origen por identificar"}
      onClose={onClose}
    >
      <div className="recovery-review">
        <p>{recoveryMessage(exception)}</p>
        {error && (
          <div className="recovery-load-error" role="alert">
            <p>{error}</p>
            {!rawEmail && (
              <button onClick={loadRaw} disabled={busy}>
                Intentar de nuevo
              </button>
            )}
          </div>
        )}
        {!rawEmail && !error && (
          <div className="recovery-loading" aria-live="polite">
            Cargando correo original…
          </div>
        )}
        {rawEmail && (
          <>
            <div className="recovery-source">
              <p className="eyebrow">EVIDENCIA CONSERVADA</p>
              <pre className="raw-source">{rawEmail}</pre>
            </div>
            <div className="recovery-review-actions">
              {!exception.retry && (
                <button className="primary-button" disabled={busy} onClick={() => run(onRetry)}>
                  {busy ? "Procesando…" : "Reintentar análisis"}
                </button>
              )}
              <button
                className="discard-action"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("¿Descartar este correo pendiente? La fuente original se conservará.")) {
                    run(onDiscard);
                  }
                }}
              >
                Descartar correo
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
