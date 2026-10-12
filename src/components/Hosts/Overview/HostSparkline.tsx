import { HOST_METRICS_HISTORY_SIZE } from "@/store/hostMetricsStore";

interface HostSparklineProps {
  /** Oldest first, 0–100. Null is a sample the host didn't measure: drawn as a gap. */
  values: ReadonlyArray<number | null>;
  label: string;
  className?: string;
  /** Samples the width spans; defaults to the full ~15 minute history. */
  windowSize?: number;
}

const WIDTH = 120;
const HEIGHT = 24;
const INSET = 2;

type Point = { x: number; y: number };

/** Unbroken stretches of measured samples, right-aligned at a fixed spacing. */
export function sparklineRuns(
  values: ReadonlyArray<number | null>,
  windowSize: number = HOST_METRICS_HISTORY_SIZE
): Point[][] {
  const samples = values.slice(-windowSize);
  const right = WIDTH - INSET;
  const step = (WIDTH - INSET * 2) / Math.max(1, windowSize - 1);
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
 * One metric on a fixed 0–100 scale across a fixed time window, so a gap or a
 * short history is drawn as what it is; the caller names the window.
 */
export function HostSparkline({ values, label, className, windowSize }: HostSparklineProps) {
  const runs = sparklineRuns(values, windowSize);
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
