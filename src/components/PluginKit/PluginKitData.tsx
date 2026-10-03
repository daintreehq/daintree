import type { CSSProperties } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type {
  PluginFigureProps,
  PluginSeverity,
  PluginSparklineProps,
  PluginStatCardProps,
} from "@shared/types/plugin-sdk-react";
import { cn } from "@/lib/utils";
import {
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  positive,
  rowCount,
  str,
} from "./kitProps";
import { severityGlyph } from "./PluginKitPatterns";
import { safeFormat } from "./kitDiagnostics";

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

// The plugin's `formatDelta` words the magnitude ("12.5%", "3 min"); the sign
// and the arrow stay the card's, so they read the same on every card.
function signed(delta: number, format: ((magnitude: number) => unknown) | undefined): string {
  const magnitude = Math.abs(delta);
  const text = safeFormat(format, magnitude, (n) => n.toLocaleString());
  if (delta > 0) return `+${text}`;
  if (delta < 0) return `${MINUS}${text}`;
  return format ? text : "0";
}

function DeltaView({
  delta,
  format,
}: {
  delta: unknown;
  format: ((magnitude: number) => unknown) | undefined;
}) {
  if (typeof delta === "number") {
    if (!Number.isFinite(delta)) return null;
    const Arrow = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : null;
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-text-secondary">
        {Arrow ? <Arrow className="h-3 w-3" aria-hidden="true" /> : null}
        {signed(delta, format)}
      </span>
    );
  }
  if (!hasContent(delta)) return null;
  return (
    <span className="min-w-0 truncate text-xs tabular-nums text-text-secondary">{node(delta)}</span>
  );
}

const STAT_SIZES = ["md", "lg"] as const;
type StatSize = (typeof STAT_SIZES)[number];

const STAT_VALUE_CLASS: Record<StatSize, string> = { md: "text-xl", lg: "text-2xl" };
const STAT_UNIT_CLASS: Record<StatSize, string> = { md: "text-sm", lg: "text-base" };
const STAT_TWIN_CLASS: Record<StatSize, string> = { md: "text-xs", lg: "text-sm" };

// Only the cautions draw on the edge: an info or success edge would be one
// more coloured outline in a row of readings, saying nothing the glyph does not.
const STAT_FILLED_EDGE: Partial<Record<PluginSeverity, string>> = {
  warning: "border-status-warning",
  error: "border-status-error",
  danger: "border-status-danger",
};

// One line truncates as the hint always has. More lines clamp at the count
// asked for, which no fixed class can spell, so it is read off a variable.
const HINT_CLAMP_CLASS = "line-clamp-(--kit-hint-lines) break-words";
const MAX_HINT_LINES = 1000;

function hintClamp(lines: unknown): {
  className: string;
  style?: CSSProperties & Record<`--${string}`, string>;
} {
  if (lines === "wrap") return { className: "break-words" };
  const count = rowCount(lines, MAX_HINT_LINES) ?? 1;
  if (count === 1) return { className: "truncate" };
  return { className: HINT_CLAMP_CLASS, style: { "--kit-hint-lines": String(count) } };
}

// The settings card's frame (radius, hairline), not a raised tile: a
// dashboard row is several of these at once, so none may carry accent or a
// fill of its own. `filled` is the recessed tile for readings inside a card,
// still with no accent. The label is sentence case at the field-label step,
// never the tracked uppercase eyebrow the host does not use.
function KitStatCard({
  label,
  value,
  delta,
  formatDelta,
  tone,
  hint,
  hintLines,
  unit,
  twin,
  size,
  variant,
  children,
  className,
  ...rest
}: PluginStatCardProps) {
  const severity = oneOf(tone, TONES) ?? "neutral";
  const glyph = severity === "neutral" ? null : severityGlyph(severity, "h-3.5 w-3.5");
  const scale = oneOf(size, STAT_SIZES) ?? "md";
  const filled = oneOf(variant, ["outline", "filled"] as const) === "filled";
  const valueClass = cn(
    "min-w-0 truncate",
    STAT_VALUE_CLASS[scale],
    "font-semibold tabular-nums text-text-primary"
  );
  return (
    <div
      {...pickDomProps(rest)}
      className={cn(
        "flex min-w-0 flex-col gap-1",
        filled
          ? "rounded-[var(--radius-md)] border border-border-subtle bg-surface-inset"
          : "rounded-[var(--radius-lg)] border border-border-default",
        filled && STAT_FILLED_EDGE[severity],
        "px-3 py-2.5",
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
        {hasContent(unit) ? (
          // The figure truncates inside this pair and the unit does not, so a
          // narrow card cuts digits, never the unit that says what they are.
          <span className="flex min-w-0 items-baseline">
            <span className={valueClass}>{node(value)}</span>
            <span
              className={cn(
                "ml-0.5 shrink-0 whitespace-nowrap font-normal text-text-secondary",
                STAT_UNIT_CLASS[scale]
              )}
            >
              {node(unit)}
            </span>
          </span>
        ) : (
          <span className={valueClass}>{node(value)}</span>
        )}
        <DeltaView delta={delta} format={fn(formatDelta)} />
      </div>
      {hasContent(twin) ? (
        <p
          className={cn(
            "min-w-0 truncate tabular-nums text-text-secondary",
            STAT_TWIN_CLASS[scale]
          )}
        >
          {node(twin)}
        </p>
      ) : null}
      {hasContent(hint) ? (
        <p
          className={cn("min-w-0", hintClamp(hintLines).className, "text-xs text-text-secondary")}
          style={hintClamp(hintLines).style}
        >
          {node(hint)}
        </p>
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
  // A loop, not `Math.min(...known)`: spreading a long series overflows the
  // engine's argument limit.
  let count = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (const value of values) {
    if (!finite(value)) continue;
    count += 1;
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  if (count < 2) return [];
  const low = finite(min) ? min : lowest;
  const high = finite(max) ? max : highest;
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
  ...rest
}: PluginSparklineProps) {
  const px = Math.round(positive(height, 1000) ?? DEFAULT_SPARK_HEIGHT);
  const list: readonly unknown[] = Array.isArray(values) ? values : [];
  const runs = sparklineRuns(list, px, min, max);
  // The dot marks the newest sample, so a missing final sample draws none
  // rather than promoting an older one.
  const lastRun = finite(list[list.length - 1]) ? runs[runs.length - 1] : undefined;
  const lastPoint = lastRun?.[lastRun.length - 1];
  const label = nonEmpty(ariaLabel);
  return (
    <svg
      {...pickRootProps(rest)}
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

const FIGURE_SIZES = ["display", "xl", "lg", "md"] as const;
type FigureSize = (typeof FIGURE_SIZES)[number];

// `display` steps with the width the figure is given, read off its own root.
const FIGURE_VALUE_CLASS: Record<FigureSize, string> = {
  display: "text-4xl @lg/figure:text-5xl @2xl/figure:text-6xl",
  xl: "text-3xl",
  lg: "text-2xl",
  md: "text-xl",
};

// About 40% of the figure, never below the smallest step the host sets text in.
const FIGURE_UNIT_CLASS: Record<FigureSize, string> = {
  display: "text-sm @lg/figure:text-lg @2xl/figure:text-2xl",
  xl: "text-xs",
  lg: "text-xs",
  md: "text-xs",
};

const FIGURE_TWIN_CLASS: Record<FigureSize, string> = {
  display: "text-base @lg/figure:text-lg",
  xl: "text-sm",
  lg: "text-sm",
  md: "text-xs",
};

// A figure set as type: no frame, no accent. It wraps rather than truncates,
// since a cut-off figure reads as a different, smaller number.
function KitFigure({
  value,
  unit,
  twin,
  label,
  caption,
  size,
  mono,
  delta,
  formatDelta,
  align,
  className,
  ...rest
}: PluginFigureProps) {
  const scale = oneOf(size, FIGURE_SIZES) ?? "lg";
  const end = oneOf(align, ["start", "end"] as const) === "end";
  const display = scale === "display";
  return (
    <div
      {...pickDomProps(rest)}
      data-size={scale}
      className={cn(
        "flex min-w-0 flex-col gap-1",
        // Inline-size containment sizes the root without its content: it takes
        // the full row, and an ancestor sized by its content (a card in a row)
        // is given a stand-in width rather than none.
        display && "@container/figure w-full [contain-intrinsic-inline-size:auto_16rem]",
        end && "items-end text-end",
        str(className)
      )}
    >
      {hasContent(label) ? (
        <div className="min-w-0 break-words text-xs text-text-secondary">{node(label)}</div>
      ) : null}
      <div
        className={cn(
          "flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5",
          end && "justify-end"
        )}
      >
        <span
          className={cn(
            "min-w-0 break-words font-semibold leading-tight tabular-nums lining-nums text-text-primary",
            FIGURE_VALUE_CLASS[scale],
            mono === true && "font-mono tracking-tight"
          )}
        >
          {node(value)}
          {hasContent(unit) ? (
            <span
              className={cn(
                "ml-0.5 whitespace-nowrap font-normal tracking-normal text-text-secondary",
                FIGURE_UNIT_CLASS[scale]
              )}
            >
              {node(unit)}
            </span>
          ) : null}
        </span>
        <DeltaView delta={delta} format={fn(formatDelta)} />
      </div>
      {hasContent(twin) ? (
        <div
          className={cn(
            "min-w-0 break-words tabular-nums lining-nums text-text-secondary",
            FIGURE_TWIN_CLASS[scale]
          )}
        >
          {node(twin)}
        </div>
      ) : null}
      {hasContent(caption) ? (
        <p className="min-w-0 break-words text-xs text-text-secondary">{node(caption)}</p>
      ) : null}
    </div>
  );
}

export const pluginKitData = {
  StatCard: KitStatCard,
  Figure: KitFigure,
  Sparkline: KitSparkline,
};
