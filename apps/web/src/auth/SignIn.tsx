import { FormEvent, useState } from "react";
import { ledgerApi, type LedgerSession, type SignInResult } from "../api/client";
import { Brand } from "../components/Brand";
import { Field } from "../components/Field";

export function SignIn({ onSignedIn }: { onSignedIn(session: LedgerSession): void }) {
  const [email, setEmail] = useState("");
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
      const result = await ledgerApi.signIn(email, password);
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
        <p className="eyebrow">TU DINERO, EN EQUILIBRIO</p>
        <h1>{challenge ? "Elige tu contraseña" : "Mira el mes con claridad."}</h1>
        <p>
          {challenge
            ? "Es tu primer acceso. Elige la contraseña que usarás para entrar."
            : "Accede a tu tablero personal de gasto."}
        </p>
        <form onSubmit={challenge ? complete : submit}>
          {!challenge && (
            <>
              <Field label="Correo">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>
              <Field label="Contraseña">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
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
