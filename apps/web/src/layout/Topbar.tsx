import { Brand } from "../components/Brand";

export function Topbar({
  syncing,
  refreshing,
  onRefresh,
  privateMode,
  onTogglePrivateMode,
  demoMode,
  showSignOut,
  onSignOut,
}: {
  syncing: boolean;
  refreshing: boolean;
  onRefresh(): void;
  privateMode: boolean;
  onTogglePrivateMode(): void;
  demoMode: boolean;
  showSignOut: boolean;
  onSignOut(): void;
}) {
  return (
    <header className="topbar">
      <Brand />
      <div className="top-actions">
        {demoMode ? (
          <span className="mock-badge" title="Datos locales de ejemplo">
            Mock
          </span>
        ) : (
          <span className="sync-state">
            <i />
            {syncing ? "Sincronizando" : "Al día"}
          </span>
        )}
        <button
          className={`icon-button${privateMode ? " active" : ""}`}
          type="button"
          onClick={onTogglePrivateMode}
          aria-pressed={privateMode}
          aria-label={privateMode ? "Mostrar montos" : "Ocultar montos"}
          title={privateMode ? "Mostrar montos" : "Ocultar montos"}
        >
          {privateMode ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        <button
          className={`icon-button${refreshing ? " refreshing" : ""}`}
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Actualizar"
          title="Actualizar"
        >
          ↻
        </button>
        {demoMode ? (
          <button className="text-button" type="button" onClick={onSignOut}>
            Salir del mock
          </button>
        ) : (
          showSignOut && (
            <button className="text-button" type="button" onClick={onSignOut}>
              Salir
            </button>
          )
        )}
      </div>
    </header>
  );
}

function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3l18 18M10.6 10.7a3 3 0 0 0 4.2 4.2M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-4.2 4.8M6.1 6.2A17.3 17.3 0 0 0 2 12s3.5 7 10 7c1.1 0 2.1-.2 3.1-.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
