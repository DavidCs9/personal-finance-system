const formatSparkDay = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date, 12)));
};

/** Minimal line sparkline: scale from series min→max (not zero), with day labels. */
export function WealthSparkline(props: {
  readonly points: readonly { readonly day: string; readonly value: number }[];
}) {
  if (props.points.length === 0) return null;

  const width = 240;
  const height = 40;
  const padX = 6;
  const padY = 6;
  const values = props.points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const last = props.points.length - 1;

  const plotted = props.points.map((point, index) => {
    const x =
      props.points.length === 1
        ? width / 2
        : padX + (index / last) * (width - padX * 2);
    const y = padY + (1 - (point.value - min) / range) * (height - padY * 2);
    return { x, y, day: point.day };
  });

  const polyline = plotted.map((point) => `${point.x},${point.y}`).join(" ");
  const end = plotted[plotted.length - 1];
  // Enough labels to orient without crowding: all if ≤5, else first / mid / last.
  const labelIndexes =
    plotted.length <= 5
      ? plotted.map((_, index) => index)
      : [0, Math.floor(last / 2), last];

  return (
    <div className="wealth-spark" aria-hidden="true">
      <svg
        className="wealth-spark-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="presentation"
      >
        <polyline
          className="wealth-spark-line"
          fill="none"
          points={polyline}
          vectorEffect="non-scaling-stroke"
        />
        {end ? (
          <circle
            className="wealth-spark-end"
            cx={end.x}
            cy={end.y}
            r={2.25}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="wealth-spark-axis">
        {plotted.map((point, index) => {
          if (!labelIndexes.includes(index)) {
            return <span key={point.day} className="wealth-spark-tick" />;
          }
          const align =
            index === 0 ? "start" : index === last ? "end" : "center";
          return (
            <span
              key={point.day}
              className={`wealth-spark-tick wealth-spark-tick-${align}`}
            >
              {formatSparkDay(point.day)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
