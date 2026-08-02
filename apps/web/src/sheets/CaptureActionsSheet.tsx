import { Sheet } from "../components/Sheet";

export function CaptureActionsSheet({
  onClose,
  onRegisterCharge,
  onImport,
}: {
  onClose(): void;
  onRegisterCharge(): void;
  onImport(): void;
}) {
  return (
    <Sheet eyebrow="CAPTURAR" title="Sumar un movimiento" onClose={onClose}>
      <p className="capture-actions-lead">
        Elige cómo entra el cobro al mes. El total se actualiza al confirmarlo.
      </p>
      <div className="capture-actions-list" role="menu">
        <button
          type="button"
          className="capture-action"
          role="menuitem"
          onClick={onRegisterCharge}
        >
          <span>
            <strong>Registrar cobro</strong>
            <small>Cuando no llegó por correo ni por CSV</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
        <button type="button" className="capture-action" role="menuitem" onClick={onImport}>
          <span>
            <strong>Conciliar CSV</strong>
            <small>Respaldo de movimientos Santander</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </Sheet>
  );
}
