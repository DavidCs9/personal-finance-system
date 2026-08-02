import { recoveryMessage } from "../lib/recovery";
import type { IngestionException } from "../types";

export function RecoveryNotice({
  exception,
  onReview,
}: {
  exception: IngestionException;
  onReview(): void;
}) {
  return (
    <article className="recovery-item">
      <div className="recovery-row">
        <span className="recovery-dot">!</span>
        <div>
          <strong>{exception.institution ?? "Origen por identificar"}</strong>
          <small>
            {exception.retry?.status === "queued"
              ? "Estamos analizando nuevamente este correo."
              : recoveryMessage(exception)}
          </small>
        </div>
        <button className="recovery-review-button" onClick={onReview}>
          Revisar correo
        </button>
      </div>
    </article>
  );
}
