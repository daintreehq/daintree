interface TerminalResourceSparklineProps {
  history: number[];
  className?: string;
}

export function TerminalResourceSparkline({ history, className }: TerminalResourceSparklineProps) {
  if (history.length < 2) return null;

  const width = 48;
  const height = 14;

  const points = history
    .map((value, i) => {
      const x = (i / (history.length - 1)) * width;
      const y = height - (Math.min(value, 100) / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const dotRadius = 2;
  const lastValue = history[history.length - 1]!;
  const lastX = width;
  const lastY = Math.max(
    dotRadius,
    Math.min(height - dotRadius, height - (Math.min(lastValue, 100) / 100) * height)
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      overflow="visible"
      className={className}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={dotRadius} fill="currentColor" stroke="none" />
    </svg>
  );
}
