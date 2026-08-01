import { FormEvent, useEffect, useMemo, useState } from "react";
import { ledgerApi, type LedgerSession, type SignInResult } from "./api/client";
import type { PurchaseEvent, ReviewStatus } from "./types";

const dateFormatter = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chihuahua" });
const institutionLabel = (value: PurchaseEvent["institution"]) => value === "american_express_mx" ? "American Express" : "Santander";
const statusLabel: Record<ReviewStatus, string> = { accepted: "Capturado", needs_review: "Revisar", rejected: "Rechazado" };
const formatMoney = (event: PurchaseEvent) => new Intl.NumberFormat("es-MX", { style: "currency", currency: event.amount.currency }).format(event.amount.amountMinor / 100);

export function App() {
  const [idToken, setIdToken] = useState<string | null>();

  useEffect(() => {
    let active = true;
    void ledgerApi.restoreSession().then((token) => { if (active) setIdToken(token ?? null); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!idToken) return undefined;
    const interval = window.setInterval(() => {
      void ledgerApi.restoreSession().then((token) => setIdToken(token ?? null));
    }, 45 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [idToken]);
  const onSignedIn = (session: LedgerSession) => { ledgerApi.saveSession(session); setIdToken(session.idToken); };
  if (idToken === undefined) return <main className="auth-shell"><section className="auth-card"><div className="brand"><span className="brand-mark">L</span><span>Ledger</span><small>personal</small></div><p>Restaurando sesión…</p></section></main>;
  if (!idToken) return <SignIn onSignedIn={onSignedIn} />;
  return <Ledger idToken={idToken} onSignOut={() => { ledgerApi.clearSession(); setIdToken(null); }} />;
}

function SignIn({ onSignedIn }: { onSignedIn(session: LedgerSession): void }) {
  const [email, setEmail] = useState("davidcastro.siq@gmail.com");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<Extract<SignInResult, { kind: "new_password" }>>();
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      const result = await ledgerApi.signIn(email, password);
      if (result.kind === "signed_in") onSignedIn(result); else setChallenge(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible iniciar sesión."); } finally { setBusy(false); }
  };
  const complete = async (event: FormEvent) => {
    event.preventDefault(); if (!challenge) return; setBusy(true); setError(undefined);
    try { onSignedIn(await ledgerApi.completeNewPassword(challenge, newPassword)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo cambiar la contraseña."); } finally { setBusy(false); }
  };
  return <main className="auth-shell"><section className="auth-card"><div className="brand"><span className="brand-mark">L</span><span>Ledger</span><small>personal</small></div><h1>{challenge ? "Elige tu contraseña" : "Tu registro financiero"}</h1><p>{challenge ? "Es tu primer acceso. Elige una contraseña que usarás para entrar a Ledger." : "Accede con tu correo y contraseña."}</p><form onSubmit={challenge ? complete : submit}>{!challenge && <><label>Correo<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label><label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label></>}{challenge && <label>Nueva contraseña<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={14} required autoComplete="new-password" /></label>}{error && <p className="form-error">{error}</p>}<button type="submit" disabled={busy}>{busy ? "Un momento..." : challenge ? "Guardar y entrar" : "Entrar"}</button></form></section></main>;
}

function Ledger({ idToken, onSignOut }: { idToken: string; onSignOut(): void }) {
  const [events, setEvents] = useState<readonly PurchaseEvent[]>([]);
  const [activeEventId, setActiveEventId] = useState<string>();
  const [institution, setInstitution] = useState<"all" | PurchaseEvent["institution"]>("all");
  const [status, setStatus] = useState<"all" | ReviewStatus>("all");
  const [rawEmail, setRawEmail] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => { void ledgerApi.listEvents(idToken).then(({ events: result }) => { setEvents(result); setActiveEventId(result[0]?.id); }).catch((reason) => setError(reason instanceof Error ? reason.message : "No se pudieron cargar los eventos.")).finally(() => setLoading(false)); }, [idToken]);
  const visibleEvents = useMemo(() => events.filter((event) => (institution === "all" || event.institution === institution) && (status === "all" || event.status === status)), [events, institution, status]);
  const activeEvent = visibleEvents.find((event) => event.id === activeEventId) ?? visibleEvents[0];
  const reviewCount = events.filter((event) => event.status === "needs_review").length;
  const toggleRaw = async () => { if (!activeEvent) return; if (rawEmail) { setRawEmail(undefined); return; } try { setRawEmail(await ledgerApi.rawEmail(activeEvent.id, idToken)); } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo leer la fuente."); } };
  const markVerified = async () => { if (!activeEvent) return; try { const updated = await ledgerApi.markVerified(activeEvent.id, idToken); setEvents((current) => current.map((event) => event.id === updated.id ? updated : event)); } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo actualizar el evento."); } };
  return <main className="app-shell"><header className="topbar"><div className="brand"><span className="brand-mark">L</span><span>Ledger</span><small>personal</small></div><div className="sync-state"><span className="dot" />{loading ? "Cargando eventos" : "Datos conectados"} <button className="sign-out" onClick={onSignOut}>Salir</button></div></header><div className="app-content">{error && <p className="banner-error">{error}</p>}<section className="hero"><div><p className="eyebrow">BANDEJA DE REVISIÓN</p><h1>Tus compras, con contexto.</h1><p className="intro">Cada alerta se conserva tal como llegó. Revisa lo que necesita atención y confía en el rastro completo.</p></div><div className="review-card"><span>Requieren revisión</span><strong>{reviewCount}</strong><p>evento{reviewCount === 1 ? "" : "s"} con una advertencia de parseo.</p></div></section><section className="workspace" aria-label="Eventos observados"><aside className="feed-panel"><div className="feed-heading"><div><p className="eyebrow">EVENTOS</p><h2>Actividad reciente</h2></div><span className="count">{visibleEvents.length}</span></div><div className="filters"><label>Institución<select value={institution} onChange={(event) => setInstitution(event.target.value as typeof institution)}><option value="all">Todas</option><option value="american_express_mx">American Express</option><option value="santander_mx">Santander</option></select></label><label>Estado<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">Todos</option><option value="accepted">Capturado</option><option value="needs_review">Revisar</option><option value="rejected">Rechazado</option></select></label></div><div className="event-list">{visibleEvents.map((event) => <button className={`event-row ${activeEvent?.id === event.id ? "selected" : ""}`} key={event.id} onClick={() => { setActiveEventId(event.id); setRawEmail(undefined); }}><div className="event-row-head"><span className="institution">{institutionLabel(event.institution)}</span><span className={`status ${event.status}`}>{statusLabel[event.status]}</span></div><strong>{event.merchantRaw}</strong><div className="event-row-foot"><span>{dateFormatter.format(new Date(event.occurredAt ?? event.receivedAt))}</span><b>{formatMoney(event)}</b></div></button>)}{!loading && visibleEvents.length === 0 && <p className="empty">No hay eventos para estos filtros.</p>}</div></aside>{activeEvent ? <EventDetail event={activeEvent} rawEmail={rawEmail} onToggleRaw={toggleRaw} onMarkVerified={markVerified} /> : <section className="detail-panel empty-detail">{loading ? "Cargando…" : "Aún no hay eventos para mostrar."}</section>}</section></div></main>;
}

function EventDetail({ event, rawEmail, onToggleRaw, onMarkVerified }: { event: PurchaseEvent; rawEmail?: string; onToggleRaw(): void; onMarkVerified(): void }) {
  const hasWarning = event.parseWarnings.length > 0;
  return <section className="detail-panel"><div className="detail-top"><div><p className="eyebrow">COMPRA OBSERVADA</p><div className="title-line"><h2>{event.merchantRaw}</h2><span className={`status ${event.status}`}>{statusLabel[event.status]}</span></div><p className="subtle">{institutionLabel(event.institution)} · {event.accountName}</p></div><strong className="amount">{formatMoney(event)}</strong></div>{hasWarning && <div className="warning"><span>!</span><div><strong>Revisión recomendada</strong><p>{event.parseWarnings[0]}</p></div><button onClick={onMarkVerified}>Marcar como verificado</button></div>}<dl className="facts"><div><dt>Fecha de compra</dt><dd>{dateFormatter.format(new Date(event.occurredAt ?? event.receivedAt))}</dd></div><div><dt>Recibido por SES</dt><dd>{dateFormatter.format(new Date(event.receivedAt))}</dd></div><div><dt>Procesado</dt><dd>{dateFormatter.format(new Date(event.ingestedAt))}</dd></div><div><dt>Parser</dt><dd>{event.parserVersion}</dd></div></dl><div className="section-title"><div><p className="eyebrow">FUENTE</p><h3>Correo original</h3></div><button className="secondary" onClick={onToggleRaw}>{rawEmail ? "Ocultar fuente" : "Ver fuente cruda"}</button></div>{rawEmail ? <pre className="raw-source">{rawEmail}</pre> : <div className="source-summary"><span className="file-icon">↳</span><div><strong>Mensaje RFC 822 conservado</strong><p>{event.source.key} · cifrado en S3 con KMS</p></div></div>}<div className="section-title revisions-title"><div><p className="eyebrow">AUDITORÍA</p><h3>Historial de revisiones</h3></div></div>{event.revisions.length ? <ol className="revisions">{event.revisions.map((revision) => <li key={revision.id}><span className="timeline-dot" /><div><strong>Corrección registrada</strong><p>{revision.reason ?? "Sin nota."}</p><small>{dateFormatter.format(new Date(revision.createdAt))} · {revision.changedBy}</small></div></li>)}</ol> : <p className="no-revisions">Aún no hay correcciones. El parseo original permanece intacto.</p>}</section>;
}
