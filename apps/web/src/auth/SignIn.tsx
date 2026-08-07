import { FormEvent, useState } from "react";
import { ledgerApi, type LedgerSession, type SignInResult } from "../api/client";
import { Brand } from "../components/Brand";
import { Field } from "../components/Field";

/** Single-owner account — Olbia is personal, not multi-tenant. */
const OWNER_EMAIL = "davidcastro.siq@gmail.com";

export function SignIn({ onSignedIn }: { onSignedIn(session: LedgerSession): void }) {
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<Extract<SignInResult, { kind: "new_password" }>>();
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await ledgerApi.signIn(OWNER_EMAIL, password);
      if (result.kind === "signed_in") onSignedIn(result);
      else setChallenge(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No fue posible iniciar sesión.");
    } finally {
      setBusy(false);
    }
  };

  const complete = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await ledgerApi.completeNewPassword(challenge, newPassword));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cambiar la contraseña.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand />
        <h1>{challenge ? "Elige tu contraseña" : "Tu tablero."}</h1>
        <p>
          {challenge
            ? "Es tu primer acceso. Elige la contraseña que usarás para entrar."
            : "Solo para ti. Introduce tu contraseña."}
        </p>
        <form onSubmit={challenge ? complete : submit}>
          {!challenge && (
            <>
              {/* Helps password managers associate the saved login with the fixed owner email. */}
              <input
                type="email"
                name="username"
                value={OWNER_EMAIL}
                autoComplete="username"
                readOnly
                hidden
                tabIndex={-1}
                aria-hidden="true"
              />
              <p className="auth-owner">{OWNER_EMAIL}</p>
              <Field label="Contraseña">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  autoFocus
                />
              </Field>
            </>
          )}
          {challenge && (
            <Field label="Nueva contraseña">
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={14}
                required
                autoComplete="new-password"
                autoFocus
              />
            </Field>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Un momento…" : challenge ? "Guardar y entrar" : "Entrar"}
          </button>
        </form>
        {import.meta.env.DEV && !challenge && (
          <div className="auth-mock">
            <p>Sin API: revisa Resumen, Movimientos y Patrimonio con datos locales.</p>
            <button
              className="secondary-button auth-mock-button"
              type="button"
              onClick={() => window.location.assign("/?demo=1")}
            >
              Usar datos de ejemplo
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
