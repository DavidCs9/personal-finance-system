import type { MonthMsiRow } from "@finance/domain";
import { Amt } from "./Amt";
import { money, monthKeyLabel } from "../lib/format";

export function MsiMonthSection({
  rows,
  msiSpentMinor,
  msiCommittedMinor,
  showTotals = false,
  embedded = false,
  onOpen,
}: {
  readonly rows: readonly MonthMsiRow[];
  readonly msiSpentMinor?: number;
  readonly msiCommittedMinor?: number;
  readonly showTotals?: boolean;
  readonly embedded?: boolean;
  readonly onOpen: (eventId: string) => void;
}) {
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);

  return (
    <section className={`payments-section msi-section${embedded ? " msi-section-embedded" : ""}`}>
      {!embedded && (
        <div className="section-heading">
          <div>
            <p className="eyebrow">MESES SIN INTERESES</p>
            <h2>Planes con fin</h2>
            <p className="section-lede">
              Compra a plazos con monto total fijo, inicio y última cuota.
            </p>
          </div>
          <strong className="section-total">
            <Amt>{money(total)}</Amt>
          </strong>
        </div>
      )}
      <div className="payment-list msi-purchase-list">
        {rows.map((row) => {
          const content = (
            <>
              <span className="msi-purchase-heading">
                <strong className="msi-purchase-merchant">{row.merchantRaw}</strong>
                {row.eventId ? <span className="chevron" aria-hidden="true">›</span> : null}
              </span>
              <span className="msi-purchase-meta">
                <span>Cuota {row.installmentIndex}/{row.months}</span>
                <span className="msi-purchase-status">
                  {row.status === "spent" ? "Registrada en gasto" : "Comprometida este mes"}
                </span>
              </span>
              <span className="msi-purchase-amounts">
                <span className="msi-purchase-amount">
                  <small>Cuota del mes</small>
                  <strong><Amt>{money(row.amountMinor)}</Amt></strong>
                </span>
                <span className="msi-purchase-principal">
                  <small>Compra total</small>
                  <strong><Amt>{money(row.principalMinor)}</Amt></strong>
                </span>
              </span>
              <span className="msi-purchase-dates">
                <span>Inicio {monthKeyLabel(row.startMonth)}</span>
                <span>Fin {monthKeyLabel(row.endMonth)}</span>
              </span>
              {row.tags?.length ? (
                <span className="msi-tags" aria-label={`Tags: ${row.tags.join(", ")}`}>
                  {row.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </span>
              ) : null}
            </>
          );
          const key = `${row.eventId ?? row.name}-${row.installmentIndex}-${row.status}`;
          const eventId = row.eventId;
          return eventId ? (
            <button key={key} className="msi-purchase-row" type="button" onClick={() => onOpen(eventId)}>
              {content}
            </button>
          ) : (
            <div key={key} className="msi-purchase-row">{content}</div>
          );
        })}
        {showTotals && msiSpentMinor !== undefined && msiCommittedMinor !== undefined && (
          <div className="payment-total msi-totals">
            <span>
              Registradas <Amt>{money(msiSpentMinor)}</Amt>
              {msiCommittedMinor > 0 ? (
                <>
                  {" "}
                  · Comprometidas <Amt>{money(msiCommittedMinor)}</Amt>
                </>
              ) : null}
            </span>
            <strong>
              <Amt>{money(msiSpentMinor + msiCommittedMinor)}</Amt>
            </strong>
          </div>
        )}
      </div>
    </section>
  );
}
