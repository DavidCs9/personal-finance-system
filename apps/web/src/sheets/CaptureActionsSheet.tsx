import { Sheet } from "../components/Sheet";

export function CaptureActionsSheet({
  onClose,
  onRegisterCharge,
  onImport,
  onImportAmex,
  onImportSantanderStatement,
}: {
  onClose(): void;
  onRegisterCharge(): void;
  onImport(): void;
  onImportAmex(): void;
  onImportSantanderStatement(): void;
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
        <button
          type="button"
          className="capture-action"
          role="menuitem"
          onClick={onImportSantanderStatement}
        >
          <span>
            <strong>Estado de cuenta Santander</strong>
            <small>PDF del periodo · conciliar compras y A MESES</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
        <button type="button" className="capture-action" role="menuitem" onClick={onImportAmex}>
          <span>
            <strong>Estado de cuenta Amex</strong>
            <small>PDF del periodo · conciliar compras y MSI</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </Sheet>
  );
}
