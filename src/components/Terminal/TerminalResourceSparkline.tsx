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
const CEILING = 100;
/** Fewer samples than this draw a speck that reads as punctuation, not a line. */
export const MIN_SPARKLINE_SAMPLES = 4;

type Run = { over: boolean; points: string[] };

/**
 * CPU history for one pane, on one fixed 0–100% scale shared by every pane, so
 * the hot pane is the tall line at a glance and a line only moves when its
 * pane's load does.
 *
 * ps sums per-core usage, so a build can read 380%. Those samples ride the
 * ceiling, and every stretch between two of them is drawn dashed: the line says
 * "off the top" rather than drawing a flat plateau nobody measured. The exact
 * reading sits beside it.
 *
 * Samples are right-aligned at a fixed spacing. Until there are enough of them
 * to read as a line, the box is held empty so the readout does not shift when
 * the line arrives.
 */
export function TerminalResourceSparkline({
  history,
  capacity = CPU_HISTORY_SIZE,
  className,
}: TerminalResourceSparklineProps) {
  const samples = history.slice(-capacity);
  const right = WIDTH - INSET;
  const step = right / Math.max(1, capacity - 1);
  const x = (i: number) => right - (samples.length - 1 - i) * step;
  const y = (value: number) =>
    INSET + (1 - Math.min(Math.max(value, 0), CEILING) / CEILING) * (HEIGHT - INSET * 2);
  const at = (i: number) => `${x(i).toFixed(1)},${y(samples[i]!).toFixed(1)}`;

  const runs: Run[] = [];
  if (samples.length >= MIN_SPARKLINE_SAMPLES) {
    for (let i = 1; i < samples.length; i++) {
      const over = samples[i - 1]! > CEILING && samples[i]! > CEILING;
      const current = runs[runs.length - 1];
      if (current && current.over === over) current.points.push(at(i));
      else runs.push({ over, points: [at(i - 1), at(i)] });
    }
  }
  const last = samples.length - 1;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className={className}
      data-resource-glyph=""
      aria-hidden="true"
    >
      {runs.map((run, i) => (
        <polyline
          key={i}
          data-over-range={run.over ? "" : undefined}
          points={run.points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap={run.over ? "butt" : "round"}
          strokeLinejoin="round"
          strokeDasharray={run.over ? "2 1.5" : undefined}
        />
      ))}
      {runs.length > 0 && (
        <circle
          cx={x(last).toFixed(1)}
          cy={y(samples[last]!).toFixed(1)}
          r={DOT_RADIUS}
          fill="currentColor"
          stroke="none"
        />
      )}
    </svg>
  );
}
