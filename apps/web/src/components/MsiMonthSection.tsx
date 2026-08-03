import type { MonthMsiRow } from "@finance/domain";
import { money, monthKeyLabel } from "../lib/format";

export function MsiMonthSection({
  rows,
  msiSpentMinor,
  msiCommittedMinor,
  showTotals = false,
  onOpen,
}: {
  readonly rows: readonly MonthMsiRow[];
  readonly msiSpentMinor?: number;
  readonly msiCommittedMinor?: number;
  readonly showTotals?: boolean;
  readonly onOpen: (eventId: string) => void;
}) {
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);

  return (
    <section className="payments-section msi-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MESES SIN INTERESES</p>
          <h2>Planes con fin</h2>
          <p className="section-lede">
            Compra a plazos con monto total fijo, inicio y última cuota.
          </p>
        </div>
        <strong className="section-total">{money(total)}</strong>
      </div>
      <div className="payment-list">
        {rows.map((row) => (
          <button
            key={`${row.eventId ?? row.name}-${row.installmentIndex}-${row.status}`}
            className="payment-row"
            type="button"
            onClick={() => {
              if (row.eventId) onOpen(row.eventId);
            }}
          >
            <span className="date-block">
              <small>MSI</small>
              <strong>{String(row.installmentIndex).padStart(2, "0")}</strong>
            </span>
            <span className="payment-name">
              <strong>{row.merchantRaw}</strong>
              <small>
                Cuota {row.installmentIndex}/{row.months} · Total {money(row.principalMinor)} ·{" "}
                {monthKeyLabel(row.startMonth)} – {monthKeyLabel(row.endMonth)}
                {row.status === "spent" ? " · reconciliada" : " · pendiente"}
              </small>
            </span>
            <strong className="payment-amount">{money(row.amountMinor)}</strong>
            <span className="chevron">›</span>
          </button>
        ))}
        {showTotals && msiSpentMinor !== undefined && msiCommittedMinor !== undefined && (
          <div className="payment-total msi-totals">
            <span>
              Gastadas {money(msiSpentMinor)}
              {msiCommittedMinor > 0 ? ` · Pendientes ${money(msiCommittedMinor)}` : ""}
            </span>
            <strong>{money(msiSpentMinor + msiCommittedMinor)}</strong>
          </div>
        )}
      </div>
    </section>
  );
}
