import { CPU_HISTORY_SIZE } from "@/store/resourceMonitoringStore";

interface TerminalResourceSparklineProps {
  history: number[];
  /** Samples the full width holds. Fixed, so one poll is always the same distance. */
  capacity?: number;
  className?: string;
}

const WIDTH = 48;
const HEIGHT = 14;
const DOT_RADIUS = 2;
// Line and dot share one inset, so the dot sits exactly on the last vertex and
// neither the stroke at 0% nor the dot at the ceiling leaves the box.
const INSET = DOT_RADIUS;
const ONE_CORE = 100;

/**
 * CPU history for one pane, on a fixed scale so panes compare at a glance.
 *
 * The scale is one core (100%) until the window holds a sample above it — ps
 * sums per-core usage, so a build can read 380% — and then grows in whole cores
 * with a dotted rule at one core. Clamping at 100% instead draws a flat ceiling
 * that was never measured and hides whether a heavy load is getting worse.
 *
 * Samples are right-aligned at a fixed spacing: a pane that has only been
 * sampled twice draws a short line, not two points stretched over the window.
 */
export function TerminalResourceSparkline({
  history,
  capacity = CPU_HISTORY_SIZE,
  className,
}: TerminalResourceSparklineProps) {
  const samples = history.slice(-capacity);
  if (samples.length < 2) return null;

  const peak = Math.max(...samples);
  const ceiling = peak > ONE_CORE ? Math.ceil(peak / ONE_CORE) * ONE_CORE : ONE_CORE;
  const right = WIDTH - INSET;
  const step = right / Math.max(1, capacity - 1);
  const x = (i: number) => right - (samples.length - 1 - i) * step;
  const y = (value: number) =>
    INSET + (1 - Math.min(Math.max(value, 0), ceiling) / ceiling) * (HEIGHT - INSET * 2);

  const points = samples.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = samples.length - 1;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className={className}
      data-ceiling={ceiling}
      aria-hidden="true"
    >
      {ceiling > ONE_CORE && (
        <line
          data-role="one-core"
          x1={0}
          x2={right}
          y1={y(ONE_CORE)}
          y2={y(ONE_CORE)}
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="1 2"
          strokeOpacity="0.6"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={x(last).toFixed(1)}
        cy={y(samples[last]!).toFixed(1)}
        r={DOT_RADIUS}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
