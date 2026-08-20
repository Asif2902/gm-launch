/**
 * Tiny inline price trace for the discover feed.
 *
 * A single series, so no legend and no axes — the card's price and market-cap figures carry the
 * values, and this only carries shape. Colour follows first-vs-last direction and is reinforced
 * by the percentage label beside it, never used alone.
 */
export function Sparkline({
  points,
  width = 92,
  height = 30,
  className = "",
}: {
  points: string[] | null | undefined;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (!points || points.length < 2) {
    return <div style={{ width, height }} className={className} aria-hidden />;
  }

  const values = points.map((point) => Number(point));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? "#20D9A0" : "#FF8341";

  const step = width / (values.length - 1);
  const y = (value: number) => height - 2 - ((value - min) / span) * (height - 4);

  const line = values.map((value, index) => `${index * step},${y(value)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const gradientId = `spark-${rising ? "up" : "down"}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.30" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width} cy={y(values[values.length - 1])} r="2.2" fill={stroke} />
    </svg>
  );
}
