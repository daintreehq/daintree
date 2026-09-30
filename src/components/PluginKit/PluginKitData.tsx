import { ArrowDown, ArrowUp } from "lucide-react";
import type {
  PluginSeverity,
  PluginSparklineProps,
  PluginStatCardProps,
} from "@shared/types/plugin-sdk-react";
import { cn } from "@/lib/utils";
import { hasContent, node, nonEmpty, oneOf, pickDomProps, positive, str } from "./kitProps";
import { severityGlyph } from "./PluginKitPatterns";

const TONES = [
  "error",
  "danger",
  "warning",
  "success",
  "info",
  "neutral",
] as const satisfies readonly PluginSeverity[];

const TONE_WORD: Record<Exclude<PluginSeverity, "neutral">, string> = {
  error: "Error",
  danger: "Danger",
  warning: "Warning",
  success: "Success",
  info: "Info",
};

// U+2212, not a hyphen: a hyphen is shorter than the plus beside it and reads
// as a dash in a tabular column.
const MINUS = "−";

function signed(delta: number): string {
  if (delta > 0) return `+${delta.toLocaleString()}`;
  if (delta < 0) return `${MINUS}${Math.abs(delta).toLocaleString()}`;
  return "0";
}

function DeltaView({ delta }: { delta: unknown }) {
  if (typeof delta === "number") {
    if (!Number.isFinite(delta)) return null;
    const Arrow = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : null;
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-text-secondary">
        {Arrow ? <Arrow className="h-3 w-3" aria-hidden="true" /> : null}
        {signed(delta)}
      </span>
    );
  }
  if (!hasContent(delta)) return null;
  return (
    <span className="min-w-0 truncate text-xs tabular-nums text-text-secondary">{node(delta)}</span>
  );
}

// The settings card's frame (radius, hairline), not a raised tile: a
// dashboard row is several of these at once, so none may carry accent or a
// fill of its own. The label is sentence case at the field-label step, never
// the tracked uppercase eyebrow the host does not use.
function KitStatCard({
  label,
  value,
  delta,
  tone,
  hint,
  children,
  className,
  ...rest
}: PluginStatCardProps) {
  const severity = oneOf(tone, TONES) ?? "neutral";
  const glyph = severity === "neutral" ? null : severityGlyph(severity, "h-3.5 w-3.5");
  return (
    <div
      {...pickDomProps(rest)}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-[var(--radius-lg)] border border-border-default px-3 py-2.5",
        str(className)
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {glyph}
        {severity === "neutral" ? null : (
          <span className="sr-only">{`${TONE_WORD[severity]}: `}</span>
        )}
        <span className="min-w-0 truncate text-xs text-text-secondary">{node(label)}</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-xl font-semibold tabular-nums text-text-primary">
          {node(value)}
        </span>
        <DeltaView delta={delta} />
      </div>
      {hasContent(hint) ? (
        <p className="min-w-0 truncate text-xs text-text-secondary">{node(hint)}</p>
      ) : null}
      {hasContent(children) ? <div className="mt-1 min-w-0">{node(children)}</div> : null}
    </div>
  );
}

// A trend on screen is standing status, never a result that just landed, so
// `success` draws neutral (docs/themes/status-success-policy.md).
const SPARK_TONE_CLASS: Record<PluginSeverity, string> = {
  neutral: "text-text-secondary",
  success: "text-text-secondary",
  info: "text-status-info",
  warning: "text-status-warning",
  error: "text-status-error",
  danger: "text-status-error",
};

const DEFAULT_SPARK_HEIGHT = 24;
// The viewBox is stretched to the container's width, so x runs 0..VIEW_WIDTH
// in user units whatever the pixels; strokes opt out of the stretch.
const VIEW_WIDTH = 100;
const STROKE_PX = 1.5;
const DOT_PX = 4;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The line as runs of consecutive finite samples, in viewBox units. Exported for tests. */
export function sparklineRuns(
  values: readonly unknown[],
  height: number,
  min?: number,
  max?: number
): string[][] {
  const known = values.filter(finite);
  if (known.length < 2) return [];
  const low = finite(min) ? min : Math.min(...known);
  const high = finite(max) ? max : Math.max(...known);
  const span = high - low;
  // Half the dot above and below, so neither the stroke at the floor nor the
  // dot at the ceiling is clipped by the box.
  const inset = DOT_PX / 2;
  const usable = Math.max(0, height - inset * 2);
  const step = VIEW_WIDTH / Math.max(1, values.length - 1);
  const y = (value: number) => {
    const clamped = Math.min(Math.max(value, low), high);
    // A flat series sits mid-box rather than on the floor, which would read as zero.
    const fraction = span > 0 ? (clamped - low) / span : 0.5;
    return inset + (1 - fraction) * usable;
  };
  const runs: string[][] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (!finite(value)) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    current.push(`${(index * step).toFixed(2)},${y(value).toFixed(2)}`);
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

function KitSparkline({
  values,
  "aria-label": ariaLabel,
  height,
  tone,
  min,
  max,
  className,
}: PluginSparklineProps) {
  const px = Math.round(positive(height, 1000) ?? DEFAULT_SPARK_HEIGHT);
  const list: readonly unknown[] = Array.isArray(values) ? values : [];
  const runs = sparklineRuns(list, px, min, max);
  const lastRun = runs[runs.length - 1];
  const lastPoint = lastRun?.[lastRun.length - 1];
  const label = nonEmpty(ariaLabel);
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${px}`}
      preserveAspectRatio="none"
      width="100%"
      height={px}
      // The end caps and the newest-value dot straddle the box's edges, where
      // the points sit; drawn outside it rather than clipped in half.
      className={cn(
        "block overflow-visible",
        SPARK_TONE_CLASS[oneOf(tone, TONES) ?? "neutral"],
        str(className)
      )}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {runs.map((run, index) =>
        run.length === 1 ? null : (
          <polyline
            key={index}
            points={run.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_PX}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )
      )}
      {lastPoint ? (
        // A zero-length stroke with a round cap is a dot that stays round when
        // the viewBox is stretched, where a <circle> would become an ellipse.
        <path
          data-sparkline-dot=""
          d={`M${lastPoint} h0`}
          stroke="currentColor"
          strokeWidth={DOT_PX}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

export const pluginKitData = {
  StatCard: KitStatCard,
  Sparkline: KitSparkline,
};
