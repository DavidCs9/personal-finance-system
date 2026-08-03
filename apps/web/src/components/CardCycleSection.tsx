import { clampDayInMonth, dayInZone, daysInCalendarMonth, monthKeyInZone } from "@finance/domain";
import type { CardCycle } from "../card-cycle";

const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"] as const;
const CARD_TONES = ["tone-a", "tone-b", "tone-c"] as const;

export interface CardCycleSectionProps {
  readonly month: string;
  readonly now: Date;
  readonly cards: readonly CardCycle[];
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRetry: () => void;
  readonly onAdd: () => void;
  readonly onEdit: (card: CardCycle) => void;
}

interface DayMark {
  readonly cardIndex: number;
  readonly kind: "cutoff" | "payment";
}

export function CardCycleSection(props: CardCycleSectionProps) {
  const canAdd = props.cards.length < 3;
  const cells = monthCells(props.month);
  const marksByDay = marksForMonth(props.month, props.cards);
  const todayDay =
    monthKeyInZone(props.now) === props.month ? dayInZone(props.now) : undefined;

  return (
    <section className="card-cycle-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CICLOS DE TARJETA</p>
          <h2>Fechas de corte</h2>
          <p className="section-lede">Corte y pago este mes. No afectan cuánto te queda.</p>
        </div>
        {canAdd && (
          <button className="add-button" aria-label="Agregar tarjeta" onClick={props.onAdd}>
            +
          </button>
        )}
      </div>

      {props.loading ? (
        <p className="card-cycle-status">Cargando tus tarjetas…</p>
      ) : props.loadError ? (
        <div className="card-cycle-error">
          <p>{props.loadError}</p>
          <button type="button" className="text-button" onClick={props.onRetry}>
            Reintentar
          </button>
        </div>
      ) : (
        <>
          <div className="card-calendar" role="grid" aria-label="Calendario de corte y pago">
            <div className="card-calendar-weekdays">
              {WEEKDAYS.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div className="card-calendar-days">
              {cells.map((day, index) => {
                if (day === null) {
                  return <div key={`pad-${index}`} className="card-calendar-cell is-empty" />;
                }
                const marks = marksByDay.get(day) ?? [];
                const isToday = todayDay === day;
                return (
                  <div
                    key={day}
                    className={[
                      "card-calendar-cell",
                      marks.length ? "has-marks" : "",
                      isToday ? "is-today" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-current={isToday ? "date" : undefined}
                  >
                    <strong>{day}</strong>
                    {isToday && <span className="card-calendar-today">Hoy</span>}
                    {marks.length > 0 && (
                      <span className="card-calendar-marks">
                        {marks.map((mark) => (
                          <i
                            key={`${mark.cardIndex}-${mark.kind}`}
                            className={`card-mark ${CARD_TONES[mark.cardIndex] ?? "tone-a"} ${mark.kind}`}
                            title={mark.kind === "cutoff" ? "Corte" : "Pago"}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {props.cards.length > 0 ? (
            <>
              <ul className="card-cycle-legend">
                {props.cards.map((card, index) => (
                  <li key={card.id}>
                    <i className={`card-legend-swatch ${CARD_TONES[index] ?? "tone-a"}`} />
                    <span>{card.name}</span>
                  </li>
                ))}
                <li className="card-cycle-legend-keys">
                  <span>
                    <i className="card-mark tone-a cutoff" /> Corte
                  </span>
                  <span>
                    <i className="card-mark tone-a payment" /> Pago
                  </span>
                </li>
              </ul>
              <div className="payment-list card-cycle-list">
                {props.cards.map((card, index) => (
                  <button
                    key={card.id}
                    type="button"
                    className="payment-row"
                    onClick={() => props.onEdit(card)}
                  >
                    <span className={`card-list-swatch ${CARD_TONES[index] ?? "tone-a"}`} />
                    <span className="payment-name">
                      <strong>{card.name}</strong>
                      <small>
                        Corte {String(clampDayInMonth(card.cutOffDay, props.month)).padStart(2, "0")}
                        {" · "}
                        Pago{" "}
                        {String(clampDayInMonth(card.paymentDueDay, props.month)).padStart(2, "0")}
                      </small>
                    </span>
                    <span className="chevron">›</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button className="empty-action" type="button" onClick={props.onAdd}>
              <span>+</span>
              <div>
                <strong>Agrega tus tarjetas</strong>
                <small>Hasta tres: día de corte y día de pago en el calendario.</small>
              </div>
            </button>
          )}
        </>
      )}
    </section>
  );
}

const monthCells = (month: string): readonly (number | null)[] => {
  const days = daysInCalendarMonth(month);
  const firstWeekday = weekdayMondayFirst(new Date(`${month}-01T12:00:00Z`));
  const cells: (number | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
};

const weekdayMondayFirst = (date: Date): number => {
  const utcDay = date.getUTCDay();
  return utcDay === 0 ? 6 : utcDay - 1;
};

const marksForMonth = (
  month: string,
  cards: readonly CardCycle[],
): Map<number, DayMark[]> => {
  const marks = new Map<number, DayMark[]>();
  cards.forEach((card, cardIndex) => {
    const cutoff = clampDayInMonth(card.cutOffDay, month);
    const payment = clampDayInMonth(card.paymentDueDay, month);
    const cutoffMarks = marks.get(cutoff) ?? [];
    cutoffMarks.push({ cardIndex, kind: "cutoff" });
    marks.set(cutoff, cutoffMarks);
    const paymentMarks = marks.get(payment) ?? [];
    paymentMarks.push({ cardIndex, kind: "payment" });
    marks.set(payment, paymentMarks);
  });
  return marks;
};
