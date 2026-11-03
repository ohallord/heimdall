export function Sparkline({
  values,
  stroke = "var(--signal)",
  height = 36,
  width = 160,
}: {
  values: number[];
  stroke?: string;
  height?: number;
  width?: number;
}) {
  if (values.length === 0) {
    return (
      <svg width={width} height={height} className="text-muted">
        <text x="4" y={height / 2 + 4} fontSize="10" fill="currentColor">
          no samples
        </text>
      </svg>
    );
  }

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const points = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * (width - 2) + 1;
      const y = height - ((v - min) / span) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        points={points}
      />
    </svg>
  );
}
