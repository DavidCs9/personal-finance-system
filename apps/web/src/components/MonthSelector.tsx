import { monthDate, monthFormatter } from "../lib/format";

export function MonthSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const shift = (delta: number) => {
    if (disabled) return;
    const date = monthDate(value);
    date.setUTCMonth(date.getUTCMonth() + delta);
    onChange(date.toISOString().slice(0, 7));
  };

  return (
    <div className={`month-selector${disabled ? " is-disabled" : ""}`} aria-disabled={disabled}>
      <button
        type="button"
        aria-label="Mes anterior"
        disabled={disabled}
        onClick={() => shift(-1)}
      >
        ‹
      </button>
      <label>
        <span>Periodo</span>
        <strong>{monthFormatter.format(monthDate(value))}</strong>
        <input
          type="month"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-label={disabled ? "El periodo no aplica en Patrimonio" : "Elegir mes"}
        />
      </label>
      <button
        type="button"
        aria-label="Mes siguiente"
        disabled={disabled}
        onClick={() => shift(1)}
      >
        ›
      </button>
    </div>
  );
}
