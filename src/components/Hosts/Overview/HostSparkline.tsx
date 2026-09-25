import { HOST_METRICS_HISTORY_SIZE } from "@/store/hostMetricsStore";

interface HostSparklineProps {
  /** Oldest first, 0–100. Null is a sample the host didn't measure: drawn as a gap. */
  values: ReadonlyArray<number | null>;
  label: string;
  className?: string;
}

const WIDTH = 120;
const HEIGHT = 24;
const INSET = 2;

type Point = { x: number; y: number };

/** Unbroken stretches of measured samples, right-aligned at a fixed spacing. */
export function sparklineRuns(values: ReadonlyArray<number | null>): Point[][] {
  const samples = values.slice(-HOST_METRICS_HISTORY_SIZE);
  const right = WIDTH - INSET;
  const step = (WIDTH - INSET * 2) / Math.max(1, HOST_METRICS_HISTORY_SIZE - 1);
  const runs: Point[][] = [];
  let current: Point[] | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    if (value === null || value === undefined) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      runs.push(current);
    }
    current.push({
      x: right - (samples.length - 1 - i) * step,
      y: INSET + (1 - Math.min(Math.max(value, 0), 100) / 100) * (HEIGHT - INSET * 2),
    });
  }
  return runs;
}

/**
 * The last ~15 minutes of one metric on a fixed 0–100 scale, so a host that
 * just connected draws a short line at the right edge rather than stretching
 * a few samples across the box.
 */
export function HostSparkline({ values, label, className }: HostSparklineProps) {
  const runs = sparklineRuns(values);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className={className}
      role="img"
      aria-label={label}
      data-testid="host-sparkline"
    >
      <line
        x1={INSET}
        x2={WIDTH - INSET}
        y1={HEIGHT - INSET}
        y2={HEIGHT - INSET}
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1"
      />
      {runs.map((points, i) =>
        points.length === 1 ? (
          <circle key={i} cx={points[0]!.x} cy={points[0]!.y} r="1.5" fill="currentColor" />
        ) : (
          <polyline
            key={i}
            points={points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      )}
    </svg>
  );
}
