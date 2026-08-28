import type { SpendingAnalytics } from "@finance/domain";
import { Amt } from "./Amt";
import { money } from "../lib/format";

const comparisonCopy = (analytics: SpendingAnalytics): string => {
  if (analytics.comparison.excludedMonthOnlyMinor > 0) {
    return "Comparación parcial con el mes pasado";
  }
  const delta = analytics.comparison.deltaMinor;
  const direction = delta > 0 ? "más" : delta < 0 ? "menos" : "igual";
  const amount = delta === 0 ? "" : `${money(Math.abs(delta))} `;
  return `${amount}${direction} que ${analytics.comparison.throughDay ? "al mismo día del mes pasado" : "el mes pasado"}`;
};

export function AnalyticsPreview({
  analytics,
  loading,
  loadError,
  onRetry,
  onOpen,
  onDrillDown,
}: {
  readonly analytics?: SpendingAnalytics;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly onOpen: () => void;
  readonly onDrillDown: (label: string, eventIds: readonly string[]) => void;
}) {
  const categories = analytics?.categories.filter((bucket) => bucket.amountMinor > 0).slice(0, 3) ?? [];
  const total = analytics?.comparison.amountMinor ?? 0;

  return (
    <section className="analytics-preview" aria-labelledby="analytics-preview-title">
      <div className="section-heading analytics-preview-heading">
        <div>
          <p className="eyebrow">EN QUÉ SE FUE</p>
          <h2 id="analytics-preview-title">Tu gasto, explicado</h2>
          {analytics ? <p className="section-lede"><Amt>{comparisonCopy(analytics)}</Amt></p> : null}
        </div>
        {!loading && !loadError ? (
          <button className="text-button analytics-open-button" type="button" onClick={onOpen}>
            Ver análisis <span aria-hidden="true">→</span>
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="analytics-status">Leyendo categorías y contextos…</p>
      ) : loadError ? (
        <div className="analytics-status analytics-status-error">
          <p>No pudimos explicar este gasto. {loadError}</p>
          <button className="text-button" type="button" onClick={onRetry}>Reintentar</button>
        </div>
      ) : categories.length > 0 ? (
        <div className="analytics-preview-list">
          {categories.map((category) => {
            const percent = total > 0 ? Math.round((category.amountMinor / total) * 100) : 0;
            return (
              <button
                type="button"
                className="analytics-preview-row"
                key={category.key}
                onClick={() => onDrillDown(category.label, category.eventIds)}
              >
                <span>
                  <strong>{category.label}</strong>
                  <small>{percent}% del gasto</small>
                </span>
                <strong><Amt>{money(category.amountMinor)}</Amt></strong>
                <span className="chevron" aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="analytics-status">Todavía no hay gasto para analizar en este mes.</p>
      )}
    </section>
  );
}
