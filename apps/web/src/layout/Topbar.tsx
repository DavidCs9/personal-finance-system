import { Brand } from "../components/Brand";

export function Topbar({
  syncing,
  refreshing,
  onRefresh,
  showSignOut,
  onSignOut,
}: {
  syncing: boolean;
  refreshing: boolean;
  onRefresh(): void;
  showSignOut: boolean;
  onSignOut(): void;
}) {
  return (
    <header className="topbar">
      <Brand />
      <div className="top-actions">
        <span className="sync-state">
          <i />
          {syncing ? "Sincronizando" : "Al día"}
        </span>
        <button
          className={`refresh-button${refreshing ? " refreshing" : ""}`}
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Actualizar"
          title="Actualizar"
        >
          ↻
        </button>
        {showSignOut && (
          <button className="text-button" onClick={onSignOut}>
            Salir
          </button>
        )}
      </div>
    </header>
  );
}
