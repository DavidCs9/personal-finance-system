import { Sheet } from "../components/Sheet";

export function CaptureActionsSheet({
  onClose,
  onRegisterCharge,
  onImport,
  onImportAmex,
}: {
  onClose(): void;
  onRegisterCharge(): void;
  onImport(): void;
  onImportAmex(): void;
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
            <strong>Conciliar CSV Santander</strong>
            <small>Respaldo y cuotas A MESES</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
        <button type="button" className="capture-action" role="menuitem" onClick={onImportAmex}>
          <span>
            <strong>Estado de cuenta Amex</strong>
            <small>Confirmar cuotas MSI del periodo</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </Sheet>
  );
}
