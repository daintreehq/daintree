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

const STROKE = 1.5;
// Above one core the line rides the ceiling dashed, and a thinner dash there
// reads as a row of faint squares: the most loaded stretch would draw lightest.
// Round-capped at 2px, the pattern paints 6.5px pills with 1.5px clear between,
// about the solid line's ink per pixel, and at y = INSET it fills whole pixel
// rows at 1x and 2x alike.
const OVER_STROKE = 2;
const OVER_DASH = 4.5;
const OVER_GAP = 3.5;
/** The smallest clear break that still registers at 1x. */
const MIN_GAP = 1.5;

type Run = { over: boolean; points: string[]; start: number; end: number };
type Dash = { array?: string; offset?: string; cap: "round" | "butt" };

/**
 * The dash for one stretch above one core, `length` px along the ceiling, of
 * which the last `hidden` px sit under the end dot.
 *
 * A stretch with room for a whole period takes the full pattern, phased so a
 * dash ends where the stretch stops showing: at the dot's edge, its cap running
 * on into the dot, or where the solid line takes over. The last pill is then
 * whole rather than a stub, and the dot is never left as one more bead. A
 * short burst gets a single break centred in what shows of it, butt-ended so
 * the solid line's round caps either side cannot close it. One too short even
 * for that is drawn solid; the reading beside it says the rest.
 */
function overRangeDash(length: number, hidden: number): Dash {
  const period = OVER_DASH + OVER_GAP;
  if (length >= period) {
    const offset = (((OVER_DASH - (length - hidden)) % period) + period) % period;
    return { array: `${OVER_DASH} ${OVER_GAP}`, offset: offset.toFixed(2), cap: "round" };
  }
  const lead = (length - hidden - MIN_GAP) / 2;
  if (lead <= 0) return { cap: "butt" };
  return { array: `${lead.toFixed(2)} ${MIN_GAP} ${length.toFixed(2)}`, cap: "butt" };
}

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
      if (current && current.over === over) {
        current.points.push(at(i));
        current.end = i;
      } else runs.push({ over, points: [at(i - 1), at(i)], start: i - 1, end: i });
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
      {runs.map((run, i) => {
        const dash = run.over
          ? overRangeDash(x(run.end) - x(run.start), run.end === last ? DOT_RADIUS : 0)
          : undefined;
        return (
          <polyline
            key={i}
            data-over-range={run.over ? "" : undefined}
            points={run.points.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={run.over ? OVER_STROKE : STROKE}
            strokeLinecap={dash?.cap ?? "round"}
            strokeLinejoin="round"
            strokeDasharray={dash?.array}
            strokeDashoffset={dash?.offset}
          />
        );
      })}
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
