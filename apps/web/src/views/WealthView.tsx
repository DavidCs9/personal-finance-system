import {
  CAJITA_ACCOUNT_ID,
  CAJITA_STALE_DAYS,
  isWealthSnapshotStale,
  wealthSnapshotAgeDays,
  type WealthAccountId,
} from "@finance/domain";
import { Amt } from "../components/Amt";
import { money } from "../lib/format";
import type { WealthAccountView, WealthHistoryPoint, WealthOverview } from "../wealth";

const accountRoleLabel = (role: WealthAccountView["role"]): string => {
  if (role === "emergency_fund") return "Emergencia";
  if (role === "crypto") return "Crypto";
  return "Broker";
};

const pendingCopy = (account: WealthAccountView): string => {
  if (account.id === CAJITA_ACCOUNT_ID) return "Sin saldo";
  return "Pendiente";
};

const formatDay = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date, 12)));
};

export function WealthView(props: {
  readonly overview: WealthOverview;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly selectedAccountId: WealthAccountId | "all";
  readonly onSelectAccount: (accountId: WealthAccountId | "all") => void;
  readonly onRegisterCajita: () => void;
  readonly now: Date;
}) {
  const selectedAccount =
    props.selectedAccountId === "all"
      ? undefined
      : props.overview.accounts.find((account) => account.id === props.selectedAccountId);

  const history: readonly WealthHistoryPoint[] =
    props.selectedAccountId === "all"
      ? props.overview.history.all
      : (props.overview.history.byAccount[props.selectedAccountId] ?? []);

  const historyNewestFirst = [...history].reverse();
  const maxHistory = Math.max(...history.map((point) => point.totalMxnMinor), 1);
  const cajita = props.overview.accounts.find((account) => account.id === CAJITA_ACCOUNT_ID);
  const cajitaStale =
    cajita?.latestSnapshot &&
    isWealthSnapshotStale(cajita.latestSnapshot.day, props.now, CAJITA_STALE_DAYS);
  const cajitaAge = cajita?.latestSnapshot
    ? wealthSnapshotAgeDays(cajita.latestSnapshot.day, props.now)
    : undefined;
  const showCajitaStart =
    !cajita?.latestSnapshot && (props.selectedAccountId === "all" || props.selectedAccountId === CAJITA_ACCOUNT_ID);

  return (
    <section className="wealth-view">
      <div className="wealth-scroll">
        {props.loading ? (
          <section className="setup-card plan-loading">
            <p className="eyebrow">PATRIMONIO</p>
            <h1>Cargando tus activos…</h1>
            <p>Consultamos Cajita, Bitso e IBKR.</p>
          </section>
        ) : props.loadError ? (
          <section className="setup-card plan-error">
            <span className="setup-alert">!</span>
            <p className="eyebrow">NO PUDIMOS LEER PATRIMONIO</p>
            <h1>Tu patrimonio no está disponible.</h1>
            <p>{props.loadError} Intenta de nuevo antes de registrar un saldo.</p>
            <button className="primary-button" onClick={props.onRetry}>
              Reintentar
            </button>
          </section>
        ) : (
          <>
            <section className="spend-hero wealth-hero">
              <div className="spend-heading">
                <div>
                  <p className="eyebrow">ACTIVOS</p>
                  <h1>Tienes</h1>
                </div>
                {props.selectedAccountId !== "all" ? (
                  <button className="income-button" onClick={() => props.onSelectAccount("all")}>
                    <span>Vista</span>
                    <strong>Total</strong>
                  </button>
                ) : cajita?.latestSnapshot ? (
                  <button className="income-button" onClick={props.onRegisterCajita}>
                    <span>Cajita</span>
                    <strong>Actualizar</strong>
                  </button>
                ) : null}
              </div>
              <strong className="hero-amount">
                <Amt>
                  {money(
                    selectedAccount?.latestSnapshot?.totalMxnMinor ?? props.overview.totalMxnMinor,
                  )}
                </Amt>
              </strong>
              <div className="spend-meta">
                <span>
                  {selectedAccount
                    ? selectedAccount.name
                    : "Cajita · Bitso · IBKR"}
                </span>
              </div>
              {cajitaStale &&
                cajitaAge !== undefined &&
                props.selectedAccountId !== "bitso" &&
                props.selectedAccountId !== "ibkr" && (
                <p className="uncertain-note wealth-stale-note">
                  <span>!</span> Cajita sin actualizar hace <Amt>{cajitaAge}</Amt> días
                </p>
              )}
            </section>

            <section className="wealth-accounts">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">CUENTAS</p>
                  <h2>Dónde está</h2>
                </div>
              </div>
              <div className="payment-list wealth-account-list">
                {props.overview.accounts.map((account) => {
                  const active = props.selectedAccountId === account.id;
                  const amount = account.latestSnapshot?.totalMxnMinor ?? 0;
                  const stale =
                    account.id === CAJITA_ACCOUNT_ID &&
                    account.latestSnapshot &&
                    isWealthSnapshotStale(account.latestSnapshot.day, props.now);
                  return (
                    <button
                      key={account.id}
                      type="button"
                      className={`payment-row wealth-account-row${active ? " active" : ""}`}
                      onClick={() =>
                        props.onSelectAccount(active ? "all" : account.id)
                      }
                    >
                      <span className={`payment-dot wealth-role-${account.role}`} aria-hidden="true" />
                      <span className="payment-name">
                        <strong>{account.name}</strong>
                        <small>
                          {account.latestSnapshot
                            ? `${accountRoleLabel(account.role)} · ${formatDay(account.latestSnapshot.day)}`
                            : `${accountRoleLabel(account.role)} · ${pendingCopy(account)}`}
                          {stale ? " · atrasada" : ""}
                        </small>
                      </span>
                      <strong className="payment-amount">
                        {account.latestSnapshot ? (
                          <Amt>{money(amount)}</Amt>
                        ) : (
                          <span className="wealth-pending">—</span>
                        )}
                      </strong>
                      <span aria-hidden="true">›</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {showCajitaStart && (
              <section className="wealth-detail wealth-start">
                <button className="empty-action" type="button" onClick={props.onRegisterCajita}>
                  <span>+</span>
                  <div>
                    <strong>Registrar saldo de Cajita</strong>
                    <small>Fondo de emergencia en MXN. La fecha la pone Olbia.</small>
                  </div>
                </button>
              </section>
            )}

            {selectedAccount?.id === CAJITA_ACCOUNT_ID && selectedAccount.latestSnapshot && (
              <section className="wealth-detail">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">CAJITA NU</p>
                    <h2>Emergencia</h2>
                  </div>
                  <button className="add-button" onClick={props.onRegisterCajita} aria-label="Registrar saldo">
                    +
                  </button>
                </div>
                <div className="payment-list">
                  {selectedAccount.latestSnapshot.holdings.map((holding) => (
                    <div key={holding.id} className="payment-row wealth-holding-row">
                      <span className="payment-dot wealth-role-emergency_fund" aria-hidden="true" />
                      <span className="payment-name">
                        <strong>{holding.name}</strong>
                        <small>MXN</small>
                      </span>
                      <strong className="payment-amount">
                        <Amt>{money(holding.valueMxnMinor)}</Amt>
                      </strong>
                      <span aria-hidden="true" />
                    </div>
                  ))}
                  <div className="payment-total">
                    <span>Última captura</span>
                    <strong>{formatDay(selectedAccount.latestSnapshot.day)}</strong>
                  </div>
                </div>
              </section>
            )}

            {selectedAccount && selectedAccount.id !== CAJITA_ACCOUNT_ID && (
              <section className="wealth-detail">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">{selectedAccount.institution.toUpperCase()}</p>
                    <h2>{selectedAccount.name}</h2>
                    <p className="section-lede">Sync automático en un siguiente paso.</p>
                  </div>
                </div>
                <div className="empty-action wealth-pending-card" aria-disabled="true">
                  <span>—</span>
                  <div>
                    <strong>Sin conectar</strong>
                    <small>Aún no hay snapshots.</small>
                  </div>
                </div>
              </section>
            )}

            <section className="wealth-history">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">HISTORIAL</p>
                  <h2>
                    {selectedAccount ? selectedAccount.name : "Total diario"}
                  </h2>
                </div>
              </div>
              {history.length === 0 ? (
                <p className="wealth-empty-history">Sin capturas todavía.</p>
              ) : (
                <>
                  <div className="wealth-spark" aria-hidden="true">
                    {history.map((point) => (
                      <span
                        key={point.day}
                        style={{ height: `${Math.max(10, Math.round((point.totalMxnMinor / maxHistory) * 100))}%` }}
                      />
                    ))}
                  </div>
                  <div className="payment-list wealth-history-list">
                    {historyNewestFirst.map((point) => (
                      <div key={point.day} className="payment-row wealth-history-row">
                        <span className="payment-dot" aria-hidden="true" />
                        <span className="payment-name">
                          <strong>{formatDay(point.day)}</strong>
                        </span>
                        <strong className="payment-amount">
                          <Amt>{money(point.totalMxnMinor)}</Amt>
                        </strong>
                        <span aria-hidden="true" />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
