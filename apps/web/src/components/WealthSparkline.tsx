/** Minimal line sparkline: scale from series min→max (not zero). */
export function WealthSparkline(props: {
  readonly values: readonly number[];
}) {
  if (props.values.length === 0) return null;

  const width = 240;
  const height = 40;
  const padX = 4;
  const padY = 6;
  const min = Math.min(...props.values);
  const max = Math.max(...props.values);
  const range = max - min || 1;
  const last = props.values.length - 1;

  const points = props.values.map((value, index) => {
    const x =
      props.values.length === 1
        ? width / 2
        : padX + (index / last) * (width - padX * 2);
    const y = padY + (1 - (value - min) / range) * (height - padY * 2);
    return { x, y };
  });

  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  const end = points[points.length - 1];

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
    </div>
  );
}
