import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { ledgerApi, type LedgerSession, type SignInResult } from "./api/client";
import { mockEventFeed } from "./api/mock-data";
import {
  demoPlans,
  planFor,
  type MonthlyPlan,
  type MonthlyPlans,
  type PlannedPayment,
} from "./monthly-plan";
import type { PurchaseEvent, ReviewStatus } from "./types";

const timeZone = "America/Chihuahua";
const dateFormatter = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone });
const longDateFormatter = new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeStyle: "short", timeZone });
const monthFormatter = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });
const moneyFormatter = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const institutionLabel = (value: PurchaseEvent["institution"]) => value === "american_express_mx" ? "American Express" : value === "santander_mx" ? "Santander" : "Nu";
const statusLabel: Record<ReviewStatus, string> = { accepted: "Confirmado", needs_review: "Por confirmar", rejected: "Rechazado" };
const money = (amountMinor: number) => moneyFormatter.format(amountMinor / 100);
const eventMoney = (event: PurchaseEvent) => new Intl.NumberFormat("es-MX", { style: "currency", currency: event.amount.currency }).format(event.amount.amountMinor / 100);
const eventDate = (event: PurchaseEvent) => new Date(event.occurredAt ?? event.receivedAt);
const monthDate = (month: string) => new Date(`${month}-01T12:00:00Z`);
const monthKey = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
};
const dayInZone = (date: Date) => Number(new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone }).format(date));

type Tab = "summary" | "movements";

export function App() {
  const demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "1";
  const [idToken, setIdToken] = useState<string | null | undefined>(demoMode ? "demo" : undefined);

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    void ledgerApi.restoreSession().then((token) => { if (active) setIdToken(token ?? null); });
    return () => { active = false; };
  }, [demoMode]);

  useEffect(() => {
    if (!idToken || demoMode) return undefined;
    const interval = window.setInterval(() => {
      void ledgerApi.restoreSession().then((token) => setIdToken(token ?? null));
    }, 45 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [demoMode, idToken]);

  const onSignedIn = (session: LedgerSession) => {
    ledgerApi.saveSession(session);
    setIdToken(session.idToken);
  };

  if (idToken === undefined) return <LoadingScreen />;
  if (!idToken) return <SignIn onSignedIn={onSignedIn} />;
  return <Dashboard idToken={idToken} demoMode={demoMode} onSignOut={() => { ledgerApi.clearSession(); setIdToken(null); }} />;
}

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><span /><i /></span>;
}

function Brand() {
  return <div className="brand"><Mark /><span>Olbia</span></div>;
}

function LoadingScreen() {
  return <main className="auth-shell"><section className="auth-card"><Brand /><p className="loading-copy">Restaurando tu sesión…</p></section></main>;
}

function SignIn({ onSignedIn }: { onSignedIn(session: LedgerSession): void }) {
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

  return <main className="auth-shell">
    <section className="auth-card">
      <Brand />
      <p className="eyebrow">TU DINERO, EN EQUILIBRIO</p>
      <h1>{challenge ? "Elige tu contraseña" : "Mira el mes con claridad."}</h1>
      <p>{challenge ? "Es tu primer acceso. Elige la contraseña que usarás para entrar." : "Accede a tu tablero personal de gasto."}</p>
      <form onSubmit={challenge ? complete : submit}>
        {!challenge && <>
          <Field label="Correo"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></Field>
          <Field label="Contraseña"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></Field>
        </>}
        {challenge && <Field label="Nueva contraseña"><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={14} required autoComplete="new-password" /></Field>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "Un momento…" : challenge ? "Guardar y entrar" : "Entrar"}</button>
      </form>
    </section>
  </main>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Dashboard({ idToken, demoMode, onSignOut }: { idToken: string; demoMode: boolean; onSignOut(): void }) {
  const now = useMemo(() => demoMode ? new Date("2026-07-12T18:00:00-06:00") : new Date(), [demoMode]);
  const [events, setEvents] = useState<readonly PurchaseEvent[]>([]);
  const [tab, setTab] = useState<Tab>("summary");
  const [selectedMonth, setSelectedMonth] = useState(monthKey(now));
  const [plans, setPlans] = useState<MonthlyPlans>(() => demoMode ? demoPlans : {});
  const [planLoading, setPlanLoading] = useState(!demoMode);
  const [planLoadError, setPlanLoadError] = useState<string>();
  const [planRefresh, setPlanRefresh] = useState(0);
  const [editingIncome, setEditingIncome] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PlannedPayment | null | undefined>();
  const [activeEvent, setActiveEvent] = useState<PurchaseEvent>();
  const [movementSort, setMovementSort] = useState<"recent" | "largest">("recent");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const request = demoMode ? Promise.resolve(mockEventFeed) : ledgerApi.listEvents(idToken);
    void request.then(({ events: result }) => setEvents(result))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "No se pudieron cargar los movimientos."))
      .finally(() => setLoading(false));
  }, [demoMode, idToken]);

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    setPlanLoading(true);
    setPlanLoadError(undefined);
    void ledgerApi.monthlyPlan(selectedMonth, idToken)
      .then((monthlyPlan) => {
        if (active) setPlans((current) => ({ ...current, [selectedMonth]: monthlyPlan }));
      })
      .catch((reason) => {
        if (active) setPlanLoadError(reason instanceof Error ? reason.message : "No se pudo cargar la configuración del mes.");
      })
      .finally(() => { if (active) setPlanLoading(false); });
    return () => { active = false; };
  }, [demoMode, idToken, planRefresh, selectedMonth]);

  const plan = planFor(plans, selectedMonth);
  const monthEvents = useMemo(() => events.filter((event) => monthKey(eventDate(event)) === selectedMonth), [events, selectedMonth]);
  const spendEvents = useMemo(() => monthEvents.filter((event) => event.status !== "rejected"), [monthEvents]);
  const spentMinor = spendEvents.reduce((sum, event) => sum + event.amount.amountMinor, 0);
  const uncertainMinor = spendEvents.filter((event) => event.status === "needs_review").reduce((sum, event) => sum + event.amount.amountMinor, 0);
  const upcomingMinor = plan.upcomingPayments.reduce((sum, payment) => sum + payment.amountMinor, 0);
  const remainingMinor = plan.incomeMinor - spentMinor - upcomingMinor;
  const isCurrentMonth = selectedMonth === monthKey(now);
  const daysInMonth = new Date(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 0).getDate();
  const elapsedDays = isCurrentMonth ? dayInZone(now) : daysInMonth;
  const projectedMinor = Math.round((spentMinor / Math.max(elapsedDays, 1)) * daysInMonth) + upcomingMinor;
  const projectedRemainingMinor = plan.incomeMinor - projectedMinor;
  const spendPercent = plan.incomeMinor > 0 ? Math.round((spentMinor / plan.incomeMinor) * 100) : 0;
  const risk = plan.incomeMinor > 0 && projectedRemainingMinor < 0 ? "danger" : spendPercent >= 70 ? "watch" : "steady";

  const savePlan = async (nextPlan: MonthlyPlan) => {
    const saved = demoMode ? nextPlan : await ledgerApi.saveMonthlyPlan(selectedMonth, nextPlan, idToken);
    setPlans((current) => ({ ...current, [selectedMonth]: saved }));
  };

  const reviewLargest = () => {
    setMovementSort("largest");
    setTab("movements");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return <main className="app-shell">
    <header className="topbar">
      <Brand />
      <div className="top-actions">
        <span className="sync-state"><i />{loading ? "Sincronizando" : "Al día"}</span>
        {!demoMode && <button className="text-button" onClick={onSignOut}>Salir</button>}
      </div>
    </header>

    <div className="app-content">
    {error && <p className="banner-error">{error}</p>}

    <div className="desktop-tabs" role="tablist" aria-label="Secciones">
      <TabButton active={tab === "summary"} onClick={() => setTab("summary")} icon="summary">Resumen</TabButton>
      <TabButton active={tab === "movements"} onClick={() => setTab("movements")} icon="movements">Movimientos</TabButton>
    </div>

    {tab === "summary" ? <Summary
      month={selectedMonth}
      onMonthChange={setSelectedMonth}
      plan={plan}
      loading={planLoading}
      loadError={planLoadError}
      onRetry={() => setPlanRefresh((current) => current + 1)}
      spentMinor={spentMinor}
      uncertainMinor={uncertainMinor}
      upcomingMinor={upcomingMinor}
      remainingMinor={remainingMinor}
      projectedRemainingMinor={projectedRemainingMinor}
      spendPercent={spendPercent}
      isCurrentMonth={isCurrentMonth}
      risk={risk}
      onEditIncome={() => setEditingIncome(true)}
      onAddPayment={() => setEditingPayment(null)}
      onEditPayment={(payment) => setEditingPayment(payment)}
      onReviewLargest={reviewLargest}
    /> : <Movements
      month={selectedMonth}
      onMonthChange={setSelectedMonth}
      events={monthEvents}
      loading={loading}
      sort={movementSort}
      onSortChange={setMovementSort}
      onOpen={setActiveEvent}
    />}

    <nav className="mobile-tabs" aria-label="Navegación principal">
      <TabButton active={tab === "summary"} onClick={() => setTab("summary")} icon="summary">Resumen</TabButton>
      <TabButton active={tab === "movements"} onClick={() => setTab("movements")} icon="movements">Movimientos</TabButton>
    </nav>
    </div>

    {editingIncome && <IncomeSheet month={selectedMonth} incomeMinor={plan.incomeMinor} onClose={() => setEditingIncome(false)} onSave={async (incomeMinor) => {
      await savePlan({ ...plan, month: selectedMonth, configured: true, incomeMinor });
      setEditingIncome(false);
    }} />}
    {editingPayment !== undefined && <PaymentSheet payment={editingPayment ?? undefined} onClose={() => setEditingPayment(undefined)} onSave={async (payment) => {
      const existing = plan.upcomingPayments.filter((item) => item.id !== payment.id);
      await savePlan({ ...plan, upcomingPayments: [...existing, payment].sort((a, b) => a.dueDay - b.dueDay) });
      setEditingPayment(undefined);
    }} onDelete={editingPayment ? async () => {
      await savePlan({ ...plan, upcomingPayments: plan.upcomingPayments.filter((item) => item.id !== editingPayment.id) });
      setEditingPayment(undefined);
    } : undefined} />}
    {activeEvent && <EventSheet event={activeEvent} idToken={idToken} demoMode={demoMode} onClose={() => setActiveEvent(undefined)} onVerified={(updated) => {
      setEvents((current) => current.map((event) => event.id === updated.id ? updated : event));
      setActiveEvent(updated);
    }} />}
  </main>;
}

function MonthSelector({ value, onChange }: { value: string; onChange(value: string): void }) {
  const shift = (delta: number) => {
    const date = monthDate(value);
    date.setUTCMonth(date.getUTCMonth() + delta);
    onChange(date.toISOString().slice(0, 7));
  };
  return <div className="month-selector">
    <button aria-label="Mes anterior" onClick={() => shift(-1)}>‹</button>
    <label>
      <span>Periodo</span>
      <strong>{monthFormatter.format(monthDate(value))}</strong>
      <input type="month" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Elegir mes" />
    </label>
    <button aria-label="Mes siguiente" onClick={() => shift(1)}>›</button>
  </div>;
}

interface SummaryProps {
  readonly month: string;
  readonly onMonthChange: (value: string) => void;
  readonly plan: MonthlyPlan;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly spentMinor: number;
  readonly uncertainMinor: number;
  readonly upcomingMinor: number;
  readonly remainingMinor: number;
  readonly projectedRemainingMinor: number;
  readonly spendPercent: number;
  readonly isCurrentMonth: boolean;
  readonly risk: "danger" | "watch" | "steady";
  readonly onEditIncome: () => void;
  readonly onAddPayment: () => void;
  readonly onEditPayment: (payment: PlannedPayment) => void;
  readonly onReviewLargest: () => void;
}

function Summary(props: SummaryProps) {
  const hasIncome = props.plan.configured && props.plan.incomeMinor > 0;
  const paymentMonth = new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" }).format(monthDate(props.month)).replace(".", "").toUpperCase();
  return <section className={`summary-view risk-${props.risk}`}>
    <MonthSelector value={props.month} onChange={props.onMonthChange} />
    {props.loading ? <section className="setup-card plan-loading">
      <p className="eyebrow">CONFIGURACIÓN MENSUAL</p>
      <h1>Cargando este mes…</h1>
      <p>Estamos consultando tu ingreso y pagos próximos.</p>
    </section> : props.loadError ? <section className="setup-card plan-error">
      <span className="setup-alert">!</span>
      <p className="eyebrow">NO PUDIMOS LEER ESTE MES</p>
      <h1>Tu configuración no está disponible.</h1>
      <p>{props.loadError} Intenta cargarla de nuevo antes de hacer cambios.</p>
      <button className="primary-button" onClick={props.onRetry}>Reintentar</button>
    </section> : !hasIncome ? <section className="setup-card missing-income">
      <span className="setup-alert">!</span>
      <p className="eyebrow">EMPIEZA POR TU LÍMITE</p>
      <h1>Falta configurar tu ingreso.</h1>
      <p>Este mes todavía no tiene un ingreso. Registra el total de tus dos depósitos de nómina para calcular cuánto puedes gastar.</p>
      <button className="primary-button" onClick={props.onEditIncome}>Definir ingreso mensual</button>
    </section> : <>
      <section className="spend-hero">
        <div className="spend-heading">
          <div>
            <p className="eyebrow">GASTO ACUMULADO</p>
            <h1>Has gastado</h1>
          </div>
          <button className="income-button" onClick={props.onEditIncome}><span>Ingreso</span><strong>{money(props.plan.incomeMinor)}</strong></button>
        </div>
        <strong className="hero-amount">{money(props.spentMinor)}</strong>
        <div className="spend-meta">
          <strong>{props.spendPercent}%</strong>
          <span>de tu ingreso mensual</span>
        </div>
        {props.uncertainMinor > 0 && <p className="uncertain-note"><span>!</span> Incluye {money(props.uncertainMinor)} por confirmar</p>}
      </section>

      <div className="number-grid">
        <section className="number-card">
          <p>Te quedan</p>
          <strong>{money(Math.max(props.remainingMinor, 0))}</strong>
          <span>después de pagos próximos</span>
        </section>
        <section className={`projection-card ${props.risk}`}>
          <p>{props.isCurrentMonth ? "A este ritmo" : "Cierre del mes"}</p>
          {props.projectedRemainingMinor < 0 ? <>
            <strong>Te faltarán {money(Math.abs(props.projectedRemainingMinor))}</strong>
            <span>si mantienes este paso</span>
            <button onClick={props.onReviewLargest}>Revisar gastos grandes <span>→</span></button>
          </> : <>
            <strong>Cerrarás con {money(props.projectedRemainingMinor)}</strong>
            <span>{props.isCurrentMonth ? "si mantienes este paso" : "según tus registros"}</span>
          </>}
        </section>
      </div>
    </>}

    {!props.loading && !props.loadError && hasIncome && <section className="payments-section">
      <div className="section-heading">
        <div><p className="eyebrow">DINERO COMPROMETIDO</p><h2>Próximos pagos</h2></div>
        <button className="icon-button" aria-label="Agregar pago próximo" onClick={props.onAddPayment}>+</button>
      </div>
      {props.plan.upcomingPayments.length > 0 ? <div className="payment-list">
        {props.plan.upcomingPayments.map((payment) => <button key={payment.id} className="payment-row" onClick={() => props.onEditPayment(payment)}>
          <span className="date-block"><small>{paymentMonth}</small><strong>{String(payment.dueDay).padStart(2, "0")}</strong></span>
          <span className="payment-name"><strong>{payment.name}</strong><small>Pago programado</small></span>
          <strong className="payment-amount">{money(payment.amountMinor)}</strong>
          <span className="chevron">›</span>
        </button>)}
        <div className="payment-total"><span>Total próximo</span><strong>{money(props.upcomingMinor)}</strong></div>
      </div> : <button className="empty-action" onClick={props.onAddPayment}><span>+</span><div><strong>Agrega tus pagos próximos</strong><small>Renta, servicios, seguros y otras obligaciones.</small></div></button>}
    </section>}
  </section>;
}

function Movements({ month, onMonthChange, events, loading, sort, onSortChange, onOpen }: {
  month: string;
  onMonthChange(value: string): void;
  events: readonly PurchaseEvent[];
  loading: boolean;
  sort: "recent" | "largest";
  onSortChange(value: "recent" | "largest"): void;
  onOpen(event: PurchaseEvent): void;
}) {
  const sorted = [...events].sort((a, b) => sort === "largest" ? b.amount.amountMinor - a.amount.amountMinor : eventDate(b).getTime() - eventDate(a).getTime());
  const total = events.filter((event) => event.status !== "rejected").reduce((sum, event) => sum + event.amount.amountMinor, 0);
  return <section className="movements-view">
    <MonthSelector value={month} onChange={onMonthChange} />
    <header className="movements-heading">
      <div><p className="eyebrow">TRAZABILIDAD</p><h1>Movimientos</h1><p>{events.length} registros · {money(total)}</p></div>
      <label className="sort-control"><span>Ordenar</span><select value={sort} onChange={(event) => onSortChange(event.target.value as "recent" | "largest")}><option value="recent">Más recientes</option><option value="largest">Mayor gasto</option></select></label>
    </header>
    <div className="movement-list">
      {sorted.map((event) => <button className="movement-row" key={event.id} onClick={() => onOpen(event)}>
        <span className={`movement-icon ${event.status}`} aria-hidden="true">{event.status === "needs_review" ? "!" : event.merchantRaw.slice(0, 1)}</span>
        <span className="movement-main"><strong>{event.merchantRaw}</strong><small>{institutionLabel(event.institution)} · {dateFormatter.format(eventDate(event))}</small></span>
        <span className="movement-value"><strong>{eventMoney(event)}</strong><small className={event.status}>{statusLabel[event.status]}</small></span>
        <span className="chevron">›</span>
      </button>)}
      {!loading && sorted.length === 0 && <div className="empty-state"><span>—</span><h2>No hay movimientos</h2><p>Cuando llegue una alerta bancaria, aparecerá aquí.</p></div>}
      {loading && <div className="empty-state"><p>Cargando movimientos…</p></div>}
    </div>
  </section>;
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick(): void; icon: Tab; children: ReactNode }) {
  return <button className={active ? "active" : ""} onClick={onClick} role="tab" aria-selected={active}>
    {icon === "summary" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m8 10V5m8 14v-7" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" /></svg>}
    <span>{children}</span>
  </button>;
}

function Sheet({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose(): void; children: ReactNode }) {
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-handle" />
      <header><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="close-button" onClick={onClose} aria-label="Cerrar">×</button></header>
      {children}
    </section>
  </div>;
}

function IncomeSheet({ month, incomeMinor, onClose, onSave }: { month: string; incomeMinor: number; onClose(): void; onSave(value: number): Promise<void> }) {
  const [value, setValue] = useState(incomeMinor ? String(incomeMinor / 100) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setSaving(true);
    setError(undefined);
    try { await onSave(Math.round(parsed * 100)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo guardar el ingreso."); }
    finally { setSaving(false); }
  };
  return <Sheet eyebrow={monthFormatter.format(monthDate(month)).toUpperCase()} title="Ingreso mensual" onClose={onClose}>
    <form className="sheet-form" onSubmit={submit}>
      <p>Registra el total de tus dos depósitos de nómina. Podrás corregirlo cuando quieras.</p>
      <Field label="Total recibido"><div className="money-input"><span>$</span><input autoFocus inputMode="decimal" type="number" min="1" step="0.01" value={value} onChange={(event) => setValue(event.target.value)} placeholder="0.00" /></div></Field>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button" type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar ingreso"}</button>
    </form>
  </Sheet>;
}

function PaymentSheet({ payment, onClose, onSave, onDelete }: { payment?: PlannedPayment; onClose(): void; onSave(value: PlannedPayment): Promise<void>; onDelete?: () => Promise<void> }) {
  const [name, setName] = useState(payment?.name ?? "");
  const [amount, setAmount] = useState(payment ? String(payment.amountMinor / 100) : "");
  const [dueDay, setDueDay] = useState(payment?.dueDay ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(amount);
    if (!name.trim() || !Number.isFinite(parsed) || parsed <= 0) return;
    setSaving(true);
    setError(undefined);
    try { await onSave({ id: payment?.id ?? `payment-${crypto.randomUUID()}`, name: name.trim(), amountMinor: Math.round(parsed * 100), dueDay }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo guardar el pago."); }
    finally { setSaving(false); }
  };
  return <Sheet eyebrow="DINERO COMPROMETIDO" title={payment ? "Editar pago" : "Nuevo pago próximo"} onClose={onClose}>
    <form className="sheet-form" onSubmit={submit}>
      <Field label="Nombre"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Renta" required /></Field>
      <Field label="Cantidad"><div className="money-input"><span>$</span><input inputMode="decimal" type="number" min="1" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></div></Field>
      <Field label="Día de pago"><input type="number" min="1" max="31" value={dueDay} onChange={(event) => setDueDay(Number(event.target.value))} required /></Field>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button" type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar pago"}</button>
      {onDelete && <button className="delete-button" type="button" disabled={saving} onClick={() => { setSaving(true); setError(undefined); void onDelete().catch((reason) => setError(reason instanceof Error ? reason.message : "No se pudo eliminar el pago.")).finally(() => setSaving(false)); }}>Eliminar pago</button>}
    </form>
  </Sheet>;
}

function EventSheet({ event, idToken, demoMode, onClose, onVerified }: { event: PurchaseEvent; idToken: string; demoMode: boolean; onClose(): void; onVerified(event: PurchaseEvent): void }) {
  const [rawEmail, setRawEmail] = useState<string>();
  const [error, setError] = useState<string>();
  const toggleRaw = async () => {
    if (rawEmail) { setRawEmail(undefined); return; }
    try {
      setRawEmail(demoMode ? event.rawEmail : await ledgerApi.rawEmail(event.id, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo leer la fuente.");
    }
  };
  const verify = async () => {
    try {
      const updated = demoMode ? { ...event, status: "accepted" as const, parseWarnings: [] } : await ledgerApi.markVerified(event.id, idToken);
      onVerified(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo actualizar el movimiento.");
    }
  };
  return <Sheet eyebrow="MOVIMIENTO OBSERVADO" title={event.merchantRaw} onClose={onClose}>
    <div className="event-detail">
      <div className="detail-amount"><strong>{eventMoney(event)}</strong><span className={`status ${event.status}`}>{statusLabel[event.status]}</span></div>
      <p className="detail-subtitle">{institutionLabel(event.institution)} · {event.accountName}</p>
      {event.parseWarnings.length > 0 && <div className="warning"><span>!</span><div><strong>Necesita confirmación</strong><p>{event.parseWarnings[0]}</p></div><button onClick={verify}>Confirmar</button></div>}
      {error && <p className="form-error">{error}</p>}
      <dl className="facts"><div><dt>Fecha de compra</dt><dd>{longDateFormatter.format(eventDate(event))}</dd></div><div><dt>Procesado</dt><dd>{longDateFormatter.format(new Date(event.ingestedAt))}</dd></div><div><dt>Parser</dt><dd>{event.parserVersion}</dd></div><div><dt>Estado</dt><dd>{statusLabel[event.status]}</dd></div></dl>
      <div className="detail-section-heading"><div><p className="eyebrow">EVIDENCIA</p><h3>Correo original</h3></div><button className="secondary-button" onClick={toggleRaw}>{rawEmail ? "Ocultar" : "Ver fuente"}</button></div>
      {rawEmail ? <pre className="raw-source">{rawEmail}</pre> : <div className="source-summary"><Mark /><div><strong>Mensaje original conservado</strong><p>{event.source.key}</p></div></div>}
    </div>
  </Sheet>;
}
