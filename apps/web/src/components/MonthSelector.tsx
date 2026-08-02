import { monthDate, monthFormatter } from "../lib/format";

export function MonthSelector({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const shift = (delta: number) => {
    const date = monthDate(value);
    date.setUTCMonth(date.getUTCMonth() + delta);
    onChange(date.toISOString().slice(0, 7));
  };

  return (
    <div className="month-selector">
      <button aria-label="Mes anterior" onClick={() => shift(-1)}>
        ‹
      </button>
      <label>
        <span>Periodo</span>
        <strong>{monthFormatter.format(monthDate(value))}</strong>
        <input
          type="month"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Elegir mes"
        />
      </label>
      <button aria-label="Mes siguiente" onClick={() => shift(1)}>
        ›
      </button>
    </div>
  );
}
