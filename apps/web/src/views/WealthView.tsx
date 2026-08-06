import {
  BITSO_ACCOUNT_ID,
  CAJITA_ACCOUNT_ID,
  CAJITA_STALE_DAYS,
  isWealthSnapshotStale,
  wealthSnapshotAgeDays,
  type WealthAccountId,
} from "@finance/domain";
import { Amt } from "../components/Amt";
import { WealthSparkline } from "../components/WealthSparkline";
import { money } from "../lib/format";
import type { WealthAccountView, WealthHistoryPoint, WealthOverview } from "../wealth";

const accountRoleLabel = (role: WealthAccountView["role"]): string => {
  if (role === "emergency_fund") return "Emergencia";
  if (role === "crypto") return "Crypto";
  return "Broker";
};

const pendingCopy = (account: WealthAccountView): string => {
  if (account.id === CAJITA_ACCOUNT_ID) return "Sin saldo";
  if (account.id === BITSO_ACCOUNT_ID) return "Sin sync";
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
  readonly onSyncBitso: () => void;
  readonly syncingBitso: boolean;
  readonly bitsoSyncError?: string;
  readonly onSyncIbkr: () => void;
  readonly syncingIbkr: boolean;
  readonly ibkrSyncError?: string;
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
  const cajita = props.overview.accounts.find((account) => account.id === CAJITA_ACCOUNT_ID);
  const cajitaStale =
    cajita?.latestSnapshot &&
    isWealthSnapshotStale(cajita.latestSnapshot.day, props.now, CAJITA_STALE_DAYS);
  const cajitaAge = cajita?.latestSnapshot
    ? wealthSnapshotAgeDays(cajita.latestSnapshot.day, props.now)
    : undefined;
  const showCajitaStart =
    !cajita?.latestSnapshot && (props.selectedAccountId === "all" || props.selectedAccountId === CAJITA_ACCOUNT_ID);
  const showBitsoHoldings =
    selectedAccount?.id === BITSO_ACCOUNT_ID && Boolean(selectedAccount.latestSnapshot);
  const showBitsoEmpty =
    selectedAccount?.id === BITSO_ACCOUNT_ID && !selectedAccount.latestSnapshot;
  const showIbkrHoldings =
    selectedAccount?.id === "ibkr" && Boolean(selectedAccount.latestSnapshot);
  const showIbkrEmpty =
    selectedAccount?.id === "ibkr" && !selectedAccount.latestSnapshot;

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
                ) : (
                  <button
                    className="income-button"
                    onClick={props.onSyncBitso}
                    disabled={props.syncingBitso}
                  >
                    <span>Bitso</span>
                    <strong>{props.syncingBitso ? "Sync…" : "Actualizar"}</strong>
                  </button>
                )}
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
                  <span className="note-icon" aria-hidden="true">
                    !
                  </span>
                  <span className="note-copy">
                    Cajita sin actualizar hace <Amt>{cajitaAge}</Amt> días
                  </span>
                </p>
              )}
              {props.bitsoSyncError && (
                <p className="uncertain-note wealth-stale-note">
                  <span className="note-icon" aria-hidden="true">
                    !
                  </span>
                  <span className="note-copy">{props.bitsoSyncError}</span>
                </p>
              )}
              {props.ibkrSyncError && (
                <p className="uncertain-note wealth-stale-note">
                  <span className="note-icon" aria-hidden="true">
                    !
                  </span>
                  <span className="note-copy">{props.ibkrSyncError}</span>
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

            {showBitsoHoldings && selectedAccount?.latestSnapshot && (
              <section className="wealth-detail">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">BITSO</p>
                    <h2>Holdings</h2>
                  </div>
                  <button
                    className="add-button"
                    onClick={props.onSyncBitso}
                    disabled={props.syncingBitso}
                    aria-label="Actualizar Bitso"
                  >
                    {props.syncingBitso ? "…" : "↻"}
                  </button>
                </div>
                <div className="payment-list">
                  {selectedAccount.latestSnapshot.holdings.map((holding) => (
                    <div key={holding.id} className="payment-row wealth-holding-row">
                      <span className="payment-dot wealth-role-crypto" aria-hidden="true" />
                      <span className="payment-name">
                        <strong>{holding.name}</strong>
                        <small>
                          {holding.quantity} {holding.symbol}
                        </small>
                      </span>
                      <strong className="payment-amount">
                        <Amt>{money(holding.valueMxnMinor)}</Amt>
                      </strong>
                      <span aria-hidden="true" />
                    </div>
                  ))}
                  <div className="payment-total">
                    <span>Último sync</span>
                    <strong>{formatDay(selectedAccount.latestSnapshot.day)}</strong>
                  </div>
                </div>
              </section>
            )}

            {showBitsoEmpty && (
              <section className="wealth-detail">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">BITSO</p>
                    <h2>Crypto</h2>
                    <p className="section-lede">Sincroniza saldos con la API de Bitso.</p>
                  </div>
                </div>
                <button
                  className="empty-action"
                  type="button"
                  onClick={props.onSyncBitso}
                  disabled={props.syncingBitso}
                >
                  <span>↻</span>
                  <div>
                    <strong>{props.syncingBitso ? "Sincronizando…" : "Actualizar ahora"}</strong>
                    <small>Lee balances y tickers MXN. Se conserva el último sync bueno si falla.</small>
                  </div>
                </button>
              </section>
            )}

            {showIbkrHoldings && selectedAccount?.latestSnapshot && (
              <section className="wealth-detail">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">IBKR</p>
                    <h2>Holdings</h2>
                  </div>
                  <button
                    className="add-button"
                    onClick={props.onSyncIbkr}
                    disabled={props.syncingIbkr}
                    aria-label="Actualizar IBKR"
                  >
                    {props.syncingIbkr ? "…" : "↻"}
                  </button>
                </div>
                <div className="payment-list">
                  {selectedAccount.latestSnapshot.holdings.map((holding) => (
                    <div key={holding.id} className="payment-row wealth-holding-row">
                      <span className="payment-dot wealth-role-brokerage" aria-hidden="true" />
                      <span className="payment-name">
                        <strong>{holding.name}</strong>
                        <small>
                          {holding.quantity} {holding.symbol}
                        </small>
                      </span>
                      <strong className="payment-amount">
                        <Amt>{money(holding.valueMxnMinor)}</Amt>
                      </strong>
                      <span aria-hidden="true" />
                    </div>
                  ))}
                  <div className="payment-total">
                    <span>Último sync</span>
                    <strong>{formatDay(selectedAccount.latestSnapshot.day)}</strong>
                  </div>
                </div>
              </section>
            )}

            {showIbkrEmpty && (
              <section className="wealth-detail">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">IBKR</p>
                    <h2>Broker</h2>
                    <p className="section-lede">Sincroniza posiciones con Flex Query.</p>
                  </div>
                </div>
                <button
                  className="empty-action"
                  type="button"
                  onClick={props.onSyncIbkr}
                  disabled={props.syncingIbkr}
                >
                  <span>↻</span>
                  <div>
                    <strong>{props.syncingIbkr ? "Sincronizando…" : "Actualizar ahora"}</strong>
                    <small>Flex + Banxico FIX. Se conserva el último sync bueno si falla.</small>
                  </div>
                </button>
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
                  {history.length > 1 ? (
                    <WealthSparkline
                      points={history.map((point) => ({
                        day: point.day,
                        value: point.totalMxnMinor,
                      }))}
                    />
                  ) : null}
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
