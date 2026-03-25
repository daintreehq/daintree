import React from "react";

interface TerminalResourceSparklineProps {
  history: number[];
  className?: string;
}

function TerminalResourceSparklineComponent({
  history,
  className,
}: TerminalResourceSparklineProps) {
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

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
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
    </svg>
  );
}

export const TerminalResourceSparkline = React.memo(TerminalResourceSparklineComponent);
