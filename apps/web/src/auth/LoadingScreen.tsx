import { Brand } from "../components/Brand";

export function LoadingScreen() {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand />
        <p className="loading-copy">Restaurando tu sesión…</p>
      </section>
    </main>
  );
}
