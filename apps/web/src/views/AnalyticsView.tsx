import type { SpendBucket, SpendingAnalytics } from "@finance/domain";
import { Amt } from "../components/Amt";
import { money, monthDate } from "../lib/format";

const signedMoney = (amountMinor: number): string => {
  if (amountMinor === 0) return money(0);
  return `${amountMinor > 0 ? "+" : "−"}${money(Math.abs(amountMinor))}`;
};

const monthLabel = (month: string): string => new Intl.DateTimeFormat("es-MX", {
  month: "long",
  timeZone: "UTC",
}).format(monthDate(month));

const drillButton = (
  bucket: SpendBucket,
  detail: string,
  onDrillDown: (label: string, eventIds: readonly string[]) => void,
) => (
  <button
    type="button"
    className="analytics-ranked-row"
    key={bucket.key}
    onClick={() => onDrillDown(bucket.label, bucket.eventIds)}
  >
    <span>
      <strong>{bucket.label}</strong>
      <small>{detail}</small>
    </span>
    <strong><Amt>{money(bucket.amountMinor)}</Amt></strong>
    <span className="chevron" aria-hidden="true">›</span>
  </button>
);

export function AnalyticsView({
  analytics,
  loading,
  loadError,
  onRetry,
  onBack,
  onDrillDown,
}: {
  readonly analytics?: SpendingAnalytics;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly onDrillDown: (label: string, eventIds: readonly string[], month?: string) => void;
}) {
  if (loading) {
    return (
      <section className="analytics-view">
        <button className="analytics-back" type="button" onClick={onBack}>← Resumen</button>
        <div className="analytics-page-status"><p>Preparando el análisis…</p></div>
      </section>
    );
  }
  if (loadError || !analytics) {
    return (
      <section className="analytics-view">
        <button className="analytics-back" type="button" onClick={onBack}>← Resumen</button>
        <div className="analytics-page-status analytics-status-error">
          <h1>No pudimos explicar este mes.</h1>
          <p>{loadError ?? "La información no está disponible."}</p>
          <button className="primary-button" type="button" onClick={onRetry}>Reintentar</button>
        </div>
      </section>
    );
  }

  const total = analytics.comparison.amountMinor;
  const activeCategories = analytics.categories.filter((category) => category.amountMinor > 0);
  const comparisonIncomplete = analytics.comparison.excludedMonthOnlyMinor > 0;
  const changes = comparisonIncomplete ? [] : [...analytics.categories]
    .filter((category) => category.deltaMinor !== 0)
    .sort((left, right) => Math.abs(right.deltaMinor) - Math.abs(left.deltaMinor))
    .slice(0, 3);
  const comparisonPeriod = analytics.comparison.throughDay
    ? `al día ${analytics.comparison.throughDay} de ${monthLabel(analytics.comparison.againstMonth)}`
    : `en ${monthLabel(analytics.comparison.againstMonth)}`;

  return (
    <section className="analytics-view">
      <div className="analytics-scroll">
        <button className="analytics-back" type="button" onClick={onBack}>← Resumen</button>

        <header className="analytics-hero">
          <p className="eyebrow">ANÁLISIS DE {monthLabel(analytics.month).toLocaleUpperCase("es-MX")}</p>
          <h1>Has gastado</h1>
          <strong className="analytics-total"><Amt>{money(total)}</Amt></strong>
          <p className="analytics-comparison">
            {comparisonIncomplete ? (
              <>Comparación parcial frente {comparisonPeriod}.</>
            ) : (
              <><Amt>{signedMoney(analytics.comparison.deltaMinor)}</Amt> frente {comparisonPeriod}.</>
            )}
          </p>
          {comparisonIncomplete ? (
            <p className="analytics-comparison-note">
              Excluye <Amt>{money(analytics.comparison.excludedMonthOnlyMinor)}</Amt> de MSI sin día confirmado en el periodo anterior.
            </p>
          ) : null}
        </header>

        <section className="analytics-section" aria-labelledby="analytics-categories-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">DÓNDE SE CONCENTRA</p>
              <h2 id="analytics-categories-title">Por categoría</h2>
              <p className="section-lede">Las categorías sí componen el total del mes.</p>
            </div>
          </div>
          {activeCategories.length > 0 ? (
            <div className="analytics-category-list">
              {activeCategories.map((category) => {
                const percent = total > 0 ? Math.round((category.amountMinor / total) * 100) : 0;
                return (
                  <button
                    type="button"
                    className="analytics-category-row"
                    key={category.key}
                    onClick={() => onDrillDown(category.label, category.eventIds)}
                  >
                    <span className="analytics-category-copy">
                      <span><strong>{category.label}</strong><small>{percent}%</small></span>
                      <span className="analytics-meter" aria-hidden="true">
                        <span style={{ width: `${Math.max(percent, 2)}%` }} />
                      </span>
                      <small className={category.deltaMinor > 0 ? "increase" : category.deltaMinor < 0 ? "decrease" : ""}>
                        {comparisonIncomplete
                          ? "Periodo anterior incompleto"
                          : <><Amt>{signedMoney(category.deltaMinor)}</Amt> vs. periodo anterior</>}
                      </small>
                    </span>
                    <strong><Amt>{money(category.amountMinor)}</Amt></strong>
                    <span className="chevron" aria-hidden="true">›</span>
                  </button>
                );
              })}
            </div>
          ) : <p className="analytics-status">Todavía no hay gasto para analizar.</p>}
        </section>

        {changes.length > 0 ? (
          <section className="analytics-section analytics-change-section" aria-labelledby="analytics-change-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">QUÉ CAMBIÓ</p>
                <h2 id="analytics-change-title">La diferencia, explicada</h2>
              </div>
            </div>
            <div className="analytics-change-list">
              {changes.map((category) => (
                <button
                  type="button"
                  key={category.key}
                  onClick={() => {
                    const currentEvidence = category.eventIds.length > 0;
                    onDrillDown(
                      category.label,
                      currentEvidence ? category.eventIds : category.againstEventIds,
                      currentEvidence ? analytics.month : analytics.comparison.againstMonth,
                    );
                  }}
                >
                  <span>{category.label}</span>
                  <strong className={category.deltaMinor > 0 ? "increase" : "decrease"}>
                    <Amt>{signedMoney(category.deltaMinor)}</Amt>
                  </strong>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {analytics.tags.length > 0 ? (
          <section className="analytics-section" aria-labelledby="analytics-tags-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">CONTEXTOS</p>
                <h2 id="analytics-tags-title">Tus tags</h2>
                <p className="section-lede">Un movimiento puede estar en más de un contexto; estos montos no se suman.</p>
              </div>
            </div>
            <div className="analytics-ranked-list">
              {analytics.tags.map((tag) => drillButton(
                { ...tag, label: `#${tag.label}` },
                `${tag.eventCount} ${tag.eventCount === 1 ? "movimiento" : "movimientos"}`,
                onDrillDown,
              ))}
            </div>
          </section>
        ) : null}

        {analytics.merchants.length > 0 ? (
          <section className="analytics-section" aria-labelledby="analytics-merchants-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">DÓNDE PAGASTE</p>
                <h2 id="analytics-merchants-title">Comercios principales</h2>
              </div>
            </div>
            <div className="analytics-ranked-list">
              {analytics.merchants.map((merchant) => drillButton(
                merchant,
                `${merchant.eventCount} ${merchant.eventCount === 1 ? "cargo" : "cargos"}`,
                onDrillDown,
              ))}
            </div>
          </section>
        ) : null}

        {(analytics.confidence.uncategorizedMinor > 0 || analytics.confidence.uncertainMinor > 0) ? (
          <section className="analytics-section analytics-confidence" aria-labelledby="analytics-confidence-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">CONFIANZA DE LOS DATOS</p>
                <h2 id="analytics-confidence-title">Qué falta revisar</h2>
              </div>
            </div>
            <div className="analytics-ranked-list">
              {analytics.confidence.uncategorizedMinor > 0 ? drillButton(
                {
                  key: "_uncategorized",
                  label: "Sin categoría",
                  amountMinor: analytics.confidence.uncategorizedMinor,
                  eventCount: analytics.confidence.uncategorizedEventCount,
                  uncertainMinor: 0,
                  eventIds: analytics.categories.find((category) => category.key === "_uncategorized")?.eventIds ?? [],
                },
                `${analytics.confidence.uncategorizedEventCount} por clasificar`,
                onDrillDown,
              ) : null}
              {analytics.confidence.uncertainMinor > 0 ? drillButton(
                {
                  key: "_uncertain",
                  label: "Por confirmar",
                  amountMinor: analytics.confidence.uncertainMinor,
                  eventCount: 0,
                  uncertainMinor: analytics.confidence.uncertainMinor,
                  eventIds: analytics.confidence.uncertainEventIds,
                },
                "Incluido en Has gastado",
                onDrillDown,
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}
