import {
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type {
  PluginBarChartProps,
  PluginChartColor,
  PluginDonutChartProps,
  PluginLineChartProps,
} from "@shared/types/plugin-sdk-react";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TOOLTIP_CARD_PADDING } from "@/components/ui/tooltip";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  positive,
  str,
} from "./kitProps";
import { safeFormat, warnPluginAuthor } from "./kitDiagnostics";

// The categorical order was chosen with the dataviz palette validator against
// the default dark and light `category-*` values and both colour-vision
// override sets: every adjacent pair of the first six clears the CVD target.
// The built-in category hues share one lightness, so a seventh slot cannot be
// told from its neighbours by colour alone; the cap is the palette's, not a
// performance limit.
export const SLOTS = ["blue", "amber", "indigo", "orange", "violet", "teal"] as const;
export const COLORS = [...SLOTS, "neutral"] as const satisfies readonly PluginChartColor[];
export const MAX_SERIES = SLOTS.length;

// Mid-lightness stand-ins that read on light and dark surfaces alike, for a
// theme that renames or drops an extended token.
const FALLBACK: Record<(typeof SLOTS)[number], string> = {
  blue: "oklch(0.62 0.13 248)",
  amber: "oklch(0.66 0.14 72)",
  indigo: "oklch(0.6 0.13 272)",
  orange: "oklch(0.63 0.15 42)",
  violet: "oklch(0.6 0.13 295)",
  teal: "oklch(0.62 0.11 182)",
};

/**
 * A chart colour as a CSS value. Marks paint with `currentColor` under a
 * `color` set from this, so a theme switch repaints through the variables
 * without a re-render.
 */
export function chartColor(color: PluginChartColor): string {
  if (color === "neutral") return "var(--theme-category-slate, var(--theme-text-secondary))";
  return `var(--theme-category-${color}, ${FALLBACK[color]})`;
}

/**
 * A colour pinned by name in a plugin's `{ [name]: color }` map, read from
 * untyped JS: only the map's own keys, and only a colour the charts know.
 */
export function pinnedColor(map: unknown, name: string): PluginChartColor | undefined {
  if (typeof map !== "object" || map === null || !Object.hasOwn(map, name)) return undefined;
  return oneOf(field(map, name), COLORS);
}

/**
 * Colours for parts in order: a pinned part keeps its colour, the rest take
 * the slots no part pinned, in the fixed order, so two parts share a hue only
 * when every slot is spoken for. Exported for tests.
 */
export function slotColors(pins: readonly (PluginChartColor | undefined)[]): PluginChartColor[] {
  const taken = new Set(pins.filter((color) => color !== undefined));
  const free = SLOTS.filter((slot) => !taken.has(slot));
  let next = 0;
  return pins.map((pin, index) => pin ?? free[next++] ?? SLOTS[index % SLOTS.length]!);
}

export const DEFAULT_HEIGHT = 200;
export const MAX_HEIGHT = 2000;
// jsdom and any host without ResizeObserver still get a drawable width.
const FALLBACK_WIDTH = 480;
const BAR_MAX_PX = 24;
export const BAR_RADIUS = 4;
export const GAP_PX = 2;
export const AXIS_CHAR_PX = 6.2;
export const AXIS_FONT_PX = 11;
export const X_AXIS_PX = 20;
export const TOP_PAD = 6;
// Categories a BarChart draws; past this a bar is under a pixel wide at any
// pane width, and a LineChart is the form.
export const MAX_BAR_CATEGORIES = 1000;
// Rows past this get a written summary instead of a hidden table: a screen
// reader cannot usefully walk ten thousand rows, and the DOM should not hold them.
export const MAX_TABLE_ROWS = 250;
// Parts a DonutChart draws by name; the rest fold into one "Other" part.
export const MAX_DONUT_PARTS = 6;

// Each series also keeps a stroke by its index, so lines tell apart without
// hue (colour is never the only signal): solid, dashed, dotted, long dash,
// dash-dot, dash-dot-dot. Caps are round, which grows every dash by the stroke
// width, so the drawn gaps are about 2px shorter than written here; the
// periods stay short enough to show whole in a legend swatch.
export const SERIES_DASHES: readonly (string | undefined)[] = [
  undefined,
  "4 6",
  "0 4",
  "10 6",
  "4 5 0 5",
  "4 5 0 4 0 5",
];

export interface NamedSeries {
  key: string;
  label: string;
}

export interface ResolvedSeries extends NamedSeries {
  color: string;
  /** The stroke signature a line draws with; `undefined` is solid. */
  dash: string | undefined;
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function rowsOf(value: unknown): object[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is object => typeof row === "object" && row !== null);
}

let warnedSeriesCap = false;

/**
 * Series from untyped JS, each with its colour: pinned ones keep theirs, the
 * rest take free slots in order. Past {@link MAX_SERIES} the rest are
 * `omitted`: not drawn, but still named in the legend's count and the table.
 * Exported for tests.
 */
export function chartSeries(value: unknown): { drawn: ResolvedSeries[]; omitted: NamedSeries[] } {
  if (!Array.isArray(value)) return { drawn: [], omitted: [] };
  const seen = new Set<string>();
  const valid: { key: string; label: string; pinned: PluginChartColor | undefined }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = nonEmpty(field(entry, "key"));
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    valid.push({
      key,
      label: str(field(entry, "label")) ?? key,
      pinned: oneOf(field(entry, "color"), COLORS),
    });
  }
  if (valid.length > MAX_SERIES && import.meta.env.DEV && !warnedSeriesCap) {
    warnedSeriesCap = true;
    warnPluginAuthor(
      `A chart draws at most ${MAX_SERIES} series; fold the rest into an "Other" series.`
    );
  }
  const kept = valid.slice(0, MAX_SERIES);
  const taken = new Set(kept.map((entry) => entry.pinned).filter((color) => color !== undefined));
  const free = SLOTS.filter((slot) => !taken.has(slot));
  let next = 0;
  const drawn = kept.map((entry, index) => {
    const color = entry.pinned ?? free[next++] ?? "neutral";
    return {
      key: entry.key,
      label: entry.label,
      color: chartColor(color),
      dash: SERIES_DASHES[index],
    };
  });
  const omitted = valid.slice(MAX_SERIES).map(({ key, label }) => ({ key, label }));
  return { drawn, omitted };
}

/** The series a chart draws. Exported for tests. */
export function resolveSeries(value: unknown): ResolvedSeries[] {
  return chartSeries(value).drawn;
}

// Pixels a tick aims to have to itself along an axis: an x label is a word
// wide, a y label one line tall.
export const X_TICK_SPACING = 100;
export const Y_TICK_SPACING = 50;
// niceTicks rounds its step to 1, 2 or 5, which can land up to about 1.6×
// denser than asked; a gap under this share of the spacing asks for fewer.
const MIN_TICK_GAP = 0.8;
const MIN_TICKS = 3;

/**
 * Round ticks over `[low, high]` for an axis `length` pixels long: about one
 * per `spacing` pixels, never packed tighter than {@link MIN_TICK_GAP} of it
 * unless the axis is down to its minimum. Exported for tests.
 */
export function axisTicks(low: number, high: number, length: number, spacing: number): number[] {
  let count = Math.max(MIN_TICKS, Math.floor(length / spacing));
  let ticks = niceTicks(low, high, count);
  while (count > MIN_TICKS && length / (ticks.length - 1) < spacing * MIN_TICK_GAP) {
    count -= 1;
    ticks = niceTicks(low, high, count);
  }
  return ticks;
}

function tickStep(low: number, high: number, count: number): number {
  const raw = (high - low) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  const multiple = error >= 7.07 ? 10 : error >= 3.16 ? 5 : error >= 1.41 ? 2 : 1;
  return multiple * power;
}

function clean(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * Round-number ticks that cover `[low, high]`, about `count` of them. The
 * first and last are the scale's ends. Exported for tests.
 */
export function niceTicks(low: number, high: number, count: number): number[] {
  let lo = low;
  let hi = high;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) {
    // A flat series reads against zero rather than filling the plot.
    if (lo === 0) return [0, 1];
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const step = tickStep(lo, hi, count);
  const start = Math.floor(lo / step);
  const end = Math.ceil(hi / step);
  // A span too narrow for a double to step through (it underflows to zero) or
  // too wide to measure (it overflows) has no round ticks: its ends stand in.
  if (
    !(step > 0) ||
    !Number.isFinite(step) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end - start > 1000
  ) {
    return [lo, hi];
  }
  const ticks: number[] = [];
  for (let i = start; i <= end; i++) ticks.push(clean(i * step));
  return ticks;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const CLOCK_STEPS = [
  SECOND,
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
];
const DAY_STEPS = [1, 2, 7, 14];
const MONTH_STEPS = [1, 3, 6];

export type TimeUnit = "second" | "minute" | "day" | "month" | "year";

/** Calendar-aligned ticks in local time between two epoch ms, about `count` of them. Exported for tests. */
export function timeTicks(
  low: number,
  high: number,
  count: number
): { ticks: number[]; unit: TimeUnit } {
  const span = high - low;
  const target = Math.max(1, count);
  if (!(span > 0)) return { ticks: [low], unit: "minute" };
  const inRange = (ticks: number[]) => ticks.filter((tick) => tick >= low && tick <= high);
  const clock = CLOCK_STEPS.find((step) => span / step <= target);
  if (clock !== undefined) {
    const midnight = new Date(low);
    midnight.setHours(0, 0, 0, 0);
    const origin = midnight.getTime();
    const first = origin + Math.ceil((low - origin) / clock) * clock;
    const ticks: number[] = [];
    for (let t = first; t <= high; t += clock) ticks.push(t);
    return { ticks, unit: clock < MINUTE ? "second" : "minute" };
  }
  const days = DAY_STEPS.find((step) => span / (step * DAY) <= target);
  if (days !== undefined) {
    const cursor = new Date(low);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < low) cursor.setDate(cursor.getDate() + 1);
    const ticks: number[] = [];
    while (cursor.getTime() <= high) {
      ticks.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + days);
    }
    return { ticks: inRange(ticks), unit: "day" };
  }
  const months = MONTH_STEPS.find((step) => span / (step * 30 * DAY) <= target);
  if (months !== undefined) {
    const cursor = new Date(low);
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(1);
    cursor.setMonth(Math.floor(cursor.getMonth() / months) * months);
    const ticks: number[] = [];
    while (cursor.getTime() <= high) {
      ticks.push(cursor.getTime());
      cursor.setMonth(cursor.getMonth() + months);
    }
    return { ticks: inRange(ticks), unit: "month" };
  }
  const startYear = new Date(low).getFullYear();
  const endYear = new Date(high).getFullYear();
  const yearStep = Math.max(1, tickStep(startYear, endYear, target));
  const ticks: number[] = [];
  for (let year = Math.ceil(startYear / yearStep) * yearStep; year <= endYear; year += yearStep) {
    ticks.push(new Date(year, 0, 1).getTime());
  }
  return { ticks: inRange(ticks), unit: "year" };
}

export const TIME_AXIS_FORMATS: Record<TimeUnit, Intl.DateTimeFormat> = {
  second: new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }),
  minute: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }),
  day: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }),
  month: new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }),
  year: new Intl.DateTimeFormat(undefined, { year: "numeric" }),
};
export const TIME_POINT_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export const DATE_POINT_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
export const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const FULL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export type Format<T> = (value: T) => string;

export function userFormat<T>(user: Format<T> | undefined, fallback: Format<T>): Format<T> {
  const format = fn(user);
  if (!format) return fallback;
  return (value) => safeFormat(format, value, fallback);
}

/** The axis and readout formatters, the plugin's own when given. */
export function valueFormats(formatValue: Format<number> | undefined): {
  axis: Format<number>;
  full: Format<number>;
} {
  const user = fn(formatValue);
  if (user) {
    const format = userFormat<number>(user, (value) => FULL.format(value));
    return { axis: format, full: format };
  }
  return { axis: (value) => COMPACT.format(value), full: (value) => FULL.format(value) };
}

/**
 * Thins a run of pixel points to at most the first, lowest, highest and last
 * of each pixel column, in order, so a series of a hundred thousand points
 * draws the same silhouette with a few thousand. Exported for tests.
 */
export function decimate(points: readonly [number, number][]): [number, number][] {
  if (points.length <= 4) return [...points];
  const out: [number, number][] = [];
  let column = Math.floor(points[0]![0]);
  let bucket: [number, number][] = [];
  const flush = () => {
    if (bucket.length <= 4) {
      out.push(...bucket);
      return;
    }
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    let min = first;
    let max = first;
    for (const point of bucket) {
      if (point[1] < min[1]) min = point;
      if (point[1] > max[1]) max = point;
    }
    const picked = [first, min, max, last].filter(
      (point, index, all) => all.indexOf(point) === index
    );
    picked.sort((a, b) => bucket.indexOf(a) - bucket.indexOf(b));
    out.push(...picked);
  };
  for (const point of points) {
    const next = Math.floor(point[0]);
    if (next !== column) {
      flush();
      bucket = [];
      column = next;
    }
    bucket.push(point);
  }
  flush();
  return out;
}

export function fixed(value: number): string {
  return value.toFixed(2);
}

export function linearPath(points: readonly [number, number][]): string {
  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${fixed(x)},${fixed(y)}`)
    .join("");
}

/**
 * A monotone cubic through the points (Fritsch–Carlson): smooth, and never
 * above the highest or below the lowest neighbouring value, so the curve does
 * not invent a peak the data lacks. Exported for tests.
 */
export function monotonePath(points: readonly [number, number][]): string {
  const n = points.length;
  if (n < 3) return linearPath(points);
  const slopes: number[] = [];
  const widths: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const dx = x1 - x0;
    widths.push(dx);
    slopes.push(dx === 0 ? 0 : (y1 - y0) / dx);
  }
  const tangents: number[] = [slopes[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slopes[i - 1]!;
    const b = slopes[i]!;
    if (a * b <= 0) {
      tangents.push(0);
      continue;
    }
    const h0 = widths[i - 1]!;
    const h1 = widths[i]!;
    const blend = (a * h1 + b * h0) / (h0 + h1);
    tangents.push(Math.sign(a) * Math.min(Math.abs(a), Math.abs(b), Math.abs(blend) / 2) * 2);
  }
  tangents.push(slopes[n - 2]!);
  const [startX, startY] = points[0]!;
  let d = `M${fixed(startX)},${fixed(startY)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const third = (x1 - x0) / 3;
    const t0 = tangents[i]!;
    const t1 = tangents[i + 1]!;
    d += `C${fixed(x0 + third)},${fixed(y0 + third * t0)},${fixed(x1 - third)},${fixed(y1 - third * t1)},${fixed(x1)},${fixed(y1)}`;
  }
  return d;
}

type BarEnd = "top" | "bottom" | "left" | "right" | null;

/** A bar with its data end rounded and its baseline end square. Exported for tests. */
export function barPath(x: number, y: number, w: number, h: number, end: BarEnd): string {
  const across = end === "top" || end === "bottom" ? w : h;
  const along = end === "top" || end === "bottom" ? h : w;
  const r = end ? Math.min(BAR_RADIUS, across / 2, along) : 0;
  const R = fixed(r);
  if (r < 0.5) return `M${fixed(x)},${fixed(y)}h${fixed(w)}v${fixed(h)}h${fixed(-w)}Z`;
  const x1 = x + w;
  const y1 = y + h;
  switch (end) {
    case "top":
      return `M${fixed(x)},${fixed(y1)}V${fixed(y + r)}A${R},${R} 0 0 1 ${fixed(x + r)},${fixed(y)}H${fixed(x1 - r)}A${R},${R} 0 0 1 ${fixed(x1)},${fixed(y + r)}V${fixed(y1)}Z`;
    case "bottom":
      return `M${fixed(x)},${fixed(y)}H${fixed(x1)}V${fixed(y1 - r)}A${R},${R} 0 0 1 ${fixed(x1 - r)},${fixed(y1)}H${fixed(x + r)}A${R},${R} 0 0 1 ${fixed(x)},${fixed(y1 - r)}Z`;
    case "right":
      return `M${fixed(x)},${fixed(y)}H${fixed(x1 - r)}A${R},${R} 0 0 1 ${fixed(x1)},${fixed(y + r)}V${fixed(y1 - r)}A${R},${R} 0 0 1 ${fixed(x1 - r)},${fixed(y1)}H${fixed(x)}Z`;
    default:
      return `M${fixed(x1)},${fixed(y)}H${fixed(x + r)}A${R},${R} 0 0 0 ${fixed(x)},${fixed(y + r)}V${fixed(y1 - r)}A${R},${R} 0 0 0 ${fixed(x + r)},${fixed(y1)}H${fixed(x1)}Z`;
  }
}

export function axisWidth(labels: readonly string[], max: number): number {
  const longest = labels.reduce((most, label) => Math.max(most, label.length), 0);
  return Math.min(max, Math.max(24, Math.ceil(longest * AXIS_CHAR_PX) + 8));
}

export function clip(label: string, px: number): string {
  const chars = Math.floor(px / AXIS_CHAR_PX);
  if (label.length <= chars) return label;
  return chars <= 1 ? "" : `${label.slice(0, chars - 1)}…`;
}

/** The container's content width, from ResizeObserver entries so a resize never forces a layout read. */
export function useWidth(): [(element: HTMLDivElement | null) => void, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (element === null) return;
    if (typeof ResizeObserver === "undefined") {
      setWidth(element.clientWidth || FALLBACK_WIDTH);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

export interface ReadoutRow {
  key: string;
  label: string;
  color: string;
  dash?: string | undefined;
  /** A scatter series' marker, for a `point` swatch. */
  marker?: MarkerShape | undefined;
  value: string;
}

/** What the point-anchored tooltip shows, and where, in the plot box's pixels. */
export interface Readout {
  title: string;
  rows: ReadoutRow[];
  /** The anchor column or point the tooltip sits beside. */
  x: number;
  /** The tooltip's top edge. */
  y: number;
  /** Half the width of the mark at `x`, so the tooltip sits beside it rather than over it. */
  clear?: number;
  swatch: SwatchShape;
}

export const TOOLTIP_OFFSET = 12;

/**
 * The tooltip's left edge: to the right of the anchor, clear of its mark, and
 * on the left only when the right would run past the chart, so the marks just
 * before the anchor (the ones being compared) stay in view. When neither side
 * has room it takes the roomier one and stays inside. Exported for tests.
 */
export function tooltipLeft(anchor: number, clear: number, tip: number, width: number): number {
  const gap = TOOLTIP_OFFSET + clear;
  const right = anchor + gap;
  if (right + tip <= width) return right;
  const left = anchor - gap - tip;
  if (left >= 0) return left;
  return width - right >= anchor - gap
    ? Math.max(0, Math.min(right, width - tip))
    : Math.max(0, left);
}

// One tooltip for every chart, positioned inside the plot box rather than in
// a portal: it tracks a point, not an element, and it never takes focus, so
// none of the overlay focus-restore machinery applies. Its own width decides
// the flip, measured before paint.
export function PointTooltip({ readout, width }: { readout: Readout; width: number }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [tip, setTip] = useState(0);
  useLayoutEffect(() => {
    if (element === null) return;
    const settle = (next: number) => setTip((previous) => (previous === next ? previous : next));
    settle(element.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    // Its width follows its rows; the observer reports after layout, before paint.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      if (box) settle(Math.ceil(box.inlineSize));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const style = {
    left: tooltipLeft(readout.x, readout.clear ?? 0, tip, width),
    top: Math.max(0, readout.y),
  };
  return (
    <div
      ref={setElement}
      data-chart-tooltip=""
      aria-hidden="true"
      style={style}
      className={cn(
        "pointer-events-none absolute z-10 w-max max-w-xs rounded-[var(--radius-md)] surface-overlay shadow-overlay text-xs text-text-primary",
        TOOLTIP_CARD_PADDING
      )}
    >
      {readout.title ? <div className="text-text-secondary">{readout.title}</div> : null}
      {readout.rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <Swatch color={row.color} shape={readout.swatch} dash={row.dash} marker={row.marker} />
          <span className="font-semibold tabular-nums">{row.value}</span>
          <span className="min-w-0 truncate text-text-secondary">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export function readoutText(readout: Readout): string {
  const rows = readout.rows.map((row) => `${row.label} ${row.value}`).join(", ");
  return readout.title ? `${readout.title}: ${rows}` : rows;
}

/**
 * The active point, from the pointer or the arrow keys. Keyboard moves are
 * announced; pointer moves are not, or hovering would flood the reader.
 */
export function useCursor(count: number) {
  const [state, setState] = useState<{ index: number; keyboard: boolean } | null>(null);
  const index = state !== null && state.index < count ? state.index : null;
  const keyboard = index !== null && state?.keyboard === true;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (count === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const last = count - 1;
    const page = Math.max(1, Math.round(count / 10));
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === null ? 0 : Math.min(index + 1, last);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === null ? last : Math.max(index - 1, 0);
    } else if (event.key === "PageDown") next = Math.min((index ?? -1) + page, last);
    else if (event.key === "PageUp") next = Math.max((index ?? count) - page, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape" && index !== null) {
      event.preventDefault();
      setState(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setState({ index: next, keyboard: true });
  };
  return {
    index,
    keyboard,
    onKeyDown,
    point: (next: number | null) =>
      setState((previous) =>
        next === null
          ? previous?.keyboard
            ? previous
            : null
          : previous?.index === next && !previous.keyboard
            ? previous
            : { index: next, keyboard: false }
      ),
    clear: () => setState(null),
  };
}

export type Cursor = ReturnType<typeof useCursor>;

const LINE_SWATCH_PX = 20;

export type SwatchShape = "bar" | "line" | "point";
export type MarkerShape = "circle" | "square" | "triangle";

/** A scatter marker centred on `(x, y)`, about `r` from its centre to its edge. */
export function markerPath(shape: MarkerShape, x: number, y: number, r: number): string {
  if (shape === "square") {
    const half = r * 0.88;
    return `M${fixed(x - half)},${fixed(y - half)}h${fixed(half * 2)}v${fixed(half * 2)}h${fixed(-half * 2)}Z`;
  }
  if (shape === "triangle") {
    const up = r * 1.15;
    return `M${fixed(x)},${fixed(y - up)}L${fixed(x + up * 0.95)},${fixed(y + up * 0.6)}L${fixed(x - up * 0.95)},${fixed(y + up * 0.6)}Z`;
  }
  return `M${fixed(x - r)},${fixed(y)}a${fixed(r)},${fixed(r)} 0 1 0 ${fixed(r * 2)},0a${fixed(r)},${fixed(r)} 0 1 0 ${fixed(-r * 2)},0Z`;
}

/**
 * A series key: a square for a bar, a short stroke in the line's own dash for
 * a line, the series' own marker for a scatter point.
 */
export function Swatch({
  color,
  shape,
  dash,
  marker,
}: {
  color: string;
  shape: SwatchShape;
  dash?: string | undefined;
  marker?: MarkerShape | undefined;
}) {
  if (shape === "point") {
    return (
      <svg
        aria-hidden="true"
        data-chart-swatch="point"
        width={10}
        height={10}
        className="shrink-0"
        style={{ color }}
      >
        <path d={markerPath(marker ?? "circle", 5, 5, 4)} fill="currentColor" />
      </svg>
    );
  }
  if (shape === "line") {
    return (
      <svg
        aria-hidden="true"
        data-chart-swatch="line"
        width={LINE_SWATCH_PX}
        height={4}
        className="shrink-0"
        style={{ color }}
      >
        <line
          x1={1}
          x2={LINE_SWATCH_PX - 1}
          y1={2}
          y2={2}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={dash}
        />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-chart-swatch="bar"
      className="h-2 w-2 shrink-0 rounded-[var(--radius-xs)]"
      style={{ backgroundColor: color }}
    />
  );
}

export function Legend({
  series,
  omitted,
  shape,
  always,
}: {
  series: (ResolvedSeries & { marker?: MarkerShape })[];
  omitted: number;
  shape: SwatchShape;
  /** Shows a one-entry legend, for keys the chart's label does not already name. */
  always?: boolean;
}) {
  if (series.length === 0 || (series.length < 2 && omitted === 0 && always !== true)) return null;
  return (
    <ul
      aria-label="Legend"
      className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary"
    >
      {series.map((entry) => (
        <li key={entry.key} className="flex min-w-0 items-center gap-1.5">
          <Swatch color={entry.color} shape={shape} dash={entry.dash} marker={entry.marker} />
          <span className="min-w-0 truncate">{entry.label}</span>
        </li>
      ))}
      {omitted > 0 ? (
        <li data-chart-omitted="" className="shrink-0 tabular-nums">
          +{omitted.toLocaleString()} more not shown
        </li>
      ) : null}
    </ul>
  );
}

export function ChartLoading({
  height,
  className,
  root,
}: {
  height: number;
  className: string | undefined;
  root: Record<string, string | number | boolean>;
}) {
  return (
    <Skeleton {...root} label="Loading chart" className={className}>
      <SkeletonBone heightPx={height} className="w-full rounded-[var(--radius-md)]" />
    </Skeleton>
  );
}

export function ChartEmpty({
  label,
  height,
  empty,
  className,
  root,
}: {
  label: string | undefined;
  height: number;
  empty: unknown;
  className: string | undefined;
  root: Record<string, string | number | boolean>;
}) {
  // An author's empty node sits in the same frame as the default: the chart's height,
  // centred both ways. Only the placement is the kit's; the node keeps its own type.
  const custom = hasContent(empty);
  return (
    <div
      {...root}
      role="group"
      aria-label={label}
      style={{ height }}
      className={cn(
        "flex items-center justify-center",
        !custom && "text-xs text-text-secondary",
        className
      )}
    >
      {custom ? node(empty) : "No data"}
    </div>
  );
}

export interface TableModel {
  xLabel: string;
  /** Every series, the omitted ones after the drawn ones. */
  series: NamedSeries[];
  /** Series in the table the chart does not draw, named in the caption. */
  omitted: NamedSeries[];
  /** How many series the chart draws, for that caption. Defaults to {@link MAX_SERIES}. */
  cap?: number;
  /** `null` past {@link MAX_TABLE_ROWS}: the summary stands in. */
  rows: { key: string; x: string; values: string[] }[] | null;
  summary: string;
  /** Said, and shown under the plot, when the chart drew only part of the data: {@link limitNote}. */
  limit?: string;
  /** What the plot marks besides the data (reference lines, shaded ranges), said with the caption. */
  annotations?: string;
}

/** The note for a chart that drew only the first `shown` of `total` (categories, rows). */
export function limitNote(shown: number, total: number, noun: string): string | undefined {
  return total > shown
    ? `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
    : undefined;
}

/** The chart's numbers for assistive tech: a table when it is small enough to walk, a summary otherwise. */
export function DataFallback({
  id,
  label,
  table,
}: {
  id: string;
  label: string;
  table: TableModel;
}) {
  const note = [
    omittedNote(table.omitted, table.cap ?? MAX_SERIES),
    table.limit ?? "",
    table.annotations ?? "",
  ]
    .filter((part) => part !== "")
    .join(". ");
  if (table.rows === null) {
    return (
      <p id={id} className="sr-only">
        {note ? `${table.summary} ${note}.` : table.summary}
      </p>
    );
  }
  return (
    <div id={id} className="sr-only">
      <table>
        <caption>{note ? `${label}. ${note}` : label}</caption>
        <thead>
          <tr>
            <th scope="col">{table.xLabel}</th>
            {table.series.map((entry) => (
              <th key={entry.key} scope="col">
                {entry.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.x}</th>
              {row.values.map((value, index) => (
                <td key={index}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function omittedNote(omitted: NamedSeries[], cap: number): string {
  if (omitted.length === 0) return "";
  const names = omitted.map((entry) => entry.label).join(", ");
  return `The chart draws ${cap} series; not drawn: ${names}`;
}

export function summarise(
  count: number,
  first: string,
  last: string,
  series: NamedSeries[],
  values: (number | null)[][],
  format: Format<number>
): string {
  const parts = [`${count} points from ${first} to ${last}.`];
  series.forEach((entry, index) => {
    const known = (values[index] ?? []).filter((value): value is number => value !== null);
    if (known.length === 0) return;
    let low = known[0]!;
    let high = low;
    for (const value of known) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
    parts.push(`${entry.label}: ${format(low)} to ${format(high)}.`);
  });
  return parts.join(" ");
}

export const NO_VALUE = "No value";

export function cellTexts(
  values: (number | null)[][],
  index: number,
  format: Format<number>
): string[] {
  return values.map((column) => {
    const value = column[index] ?? null;
    return value === null ? NO_VALUE : format(value);
  });
}

export function readoutRows(
  series: ResolvedSeries[],
  values: (number | null)[][],
  index: number,
  format: Format<number>
): ReadoutRow[] {
  const texts = cellTexts(values, index, format);
  return series.map((entry, s) => ({
    key: entry.key,
    label: entry.label,
    color: entry.color,
    dash: entry.dash,
    value: texts[s] ?? NO_VALUE,
  }));
}

/** Each of `series`' values per row, for the table's columns past the drawn ones. */
export function columnsOf(
  rows: readonly object[],
  series: readonly NamedSeries[]
): (number | null)[][] {
  return series.map((entry) => rows.map((row) => finite(field(row, entry.key))));
}

/**
 * The frame every axis chart shares: legend, a measured plot box that is one
 * keyboard stop, the point tooltip, the live readout and the data fallback.
 */
export function AxisChartFrame({
  root,
  className,
  label,
  height,
  legend,
  table,
  cursor,
  readout,
  onPointerMove,
  measure,
  width,
  children,
}: {
  root: Record<string, string | number | boolean>;
  className: string | undefined;
  label: string;
  height: number;
  legend: ReactNode;
  table: TableModel;
  cursor: Cursor;
  readout: Readout | null;
  onPointerMove: (x: number, y: number) => void;
  measure: (element: HTMLDivElement | null) => void;
  width: number;
  children: ReactNode;
}) {
  const describedBy = useId();
  return (
    <div {...root} className={cn("flex min-w-0 flex-col gap-2", className)}>
      {legend}
      <div ref={measure} className="relative w-full min-w-0" style={{ height }}>
        <div
          role="group"
          aria-roledescription="chart"
          aria-label={label}
          aria-describedby={describedBy}
          tabIndex={0}
          data-chart-plot=""
          onKeyDown={cursor.onKeyDown}
          onBlur={cursor.clear}
          onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
            const box = event.currentTarget.getBoundingClientRect();
            onPointerMove(event.clientX - box.left, event.clientY - box.top);
          }}
          onPointerLeave={() => cursor.point(null)}
          className="absolute inset-0 rounded-[var(--radius-sm)] focus-visible:outline-offset-2"
        >
          {width > 0 ? children : null}
        </div>
        {readout ? <PointTooltip readout={readout} width={width} /> : null}
      </div>
      {table.limit ? (
        <p data-chart-limit="" aria-hidden="true" className="text-xs text-text-secondary">
          {table.limit}
        </p>
      ) : null}
      <DataFallback id={describedBy} label={label} table={table} />
      <div className="sr-only" aria-live="polite">
        {cursor.keyboard && readout ? readoutText(readout) : ""}
      </div>
    </div>
  );
}

export function ValueGrid({
  ticks,
  scale,
  orientation,
  from,
  to,
  format,
}: {
  ticks: number[];
  scale: (value: number) => number;
  orientation: "vertical" | "horizontal";
  from: number;
  to: number;
  format: Format<number>;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((tick) => {
        const at = Math.round(scale(tick)) + 0.5;
        const zero = tick === 0;
        return orientation === "vertical" ? (
          <g key={tick}>
            <line
              x1={from}
              x2={to}
              y1={at}
              y2={at}
              data-chart-grid={tick}
              strokeWidth={1}
              className={zero ? "stroke-border-strong" : "stroke-border-subtle"}
            />
            <text
              x={from - 6}
              y={at}
              dy="0.32em"
              textAnchor="end"
              fontSize={AXIS_FONT_PX}
              className="fill-text-secondary tabular-nums"
            >
              {format(tick)}
            </text>
          </g>
        ) : (
          <g key={tick}>
            <line
              x1={at}
              x2={at}
              y1={from}
              y2={to}
              data-chart-grid={tick}
              strokeWidth={1}
              className={zero ? "stroke-border-strong" : "stroke-border-subtle"}
            />
            <text
              x={at}
              y={to + 14}
              textAnchor="middle"
              fontSize={AXIS_FONT_PX}
              className="fill-text-secondary tabular-nums"
            >
              {format(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * A tick label centred on its tick unless that would hang past the plot's
 * edge, where it would crowd the value axis's labels (the first x tick sits
 * right under "0"): there it lines up with the edge instead.
 */
export function edgeAnchor(
  tick: { at: number; text: string },
  left: number,
  right: number
): "start" | "middle" | "end" {
  const half = (tick.text.length * AXIS_CHAR_PX) / 2;
  if (tick.at - half < left) return "start";
  if (tick.at + half > right) return "end";
  return "middle";
}

/**
 * Axis labels that do not collide, as `edgeAnchor` places them: a label that
 * would overlap the one before it is dropped, except the last, which displaces
 * every neighbour it would touch so the scale's end stays named. Exported for tests.
 */
export function withoutOverlaps<T extends { at: number; text: string }>(
  ticks: readonly T[],
  left: number,
  right: number
): T[] {
  const extent = (tick: T): [number, number] => {
    const width = tick.text.length * AXIS_CHAR_PX;
    const anchor = edgeAnchor(tick, left, right);
    const start =
      anchor === "start" ? tick.at : anchor === "end" ? tick.at - width : tick.at - width / 2;
    return [start, start + width];
  };
  const kept: T[] = [];
  ticks.forEach((tick, index) => {
    const [start] = extent(tick);
    const clashes = (previous: T | undefined) =>
      previous !== undefined && extent(previous)[1] + 6 > start;
    if (index !== ticks.length - 1) {
      if (!clashes(kept[kept.length - 1])) kept.push(tick);
      return;
    }
    while (clashes(kept[kept.length - 1])) kept.pop();
    kept.push(tick);
  });
  return kept;
}

export function linear(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
  const span = d1 - d0;
  return (value) => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0));
}

export function chartProps(height: unknown, ariaLabel: unknown, className: unknown) {
  return {
    px: Math.round(positive(height, MAX_HEIGHT) ?? DEFAULT_HEIGHT),
    label: str(ariaLabel) ?? "",
    classes: str(className),
  };
}

interface BarRect {
  key: string;
  d: string;
  color: string;
}

function KitBarChart({
  data,
  x,
  series,
  mode,
  orientation,
  "aria-label": ariaLabel,
  height,
  formatValue,
  formatX,
  xLabel,
  categoryColors,
  loading,
  empty,
  className,
  ...rest
}: PluginBarChartProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const stacked = oneOf(mode, ["grouped", "stacked"] as const) === "stacked";
  const across = oneOf(orientation, ["vertical", "horizontal"] as const) === "horizontal";
  const [measure, width] = useWidth();
  const { drawn: resolved, omitted } = useMemo(() => chartSeries(series), [series]);
  const allRows = useMemo(() => rowsOf(data), [data]);
  const rows = useMemo(() => allRows.slice(0, MAX_BAR_CATEGORIES), [allRows]);
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const categories = useMemo(() => {
    const xKey = str(x) ?? "";
    const format = userFormat<unknown>(formatX, (raw) =>
      raw === undefined || raw === null ? "" : String(raw)
    );
    return rows.map((row) => format(field(row, xKey)));
  }, [rows, x, formatX]);
  const values = useMemo(
    () => resolved.map((entry) => rows.map((row) => finite(field(row, entry.key)))),
    [resolved, rows]
  );
  // With several series the hue is what tells them apart, so only a lone
  // series can trade it for the category's own colour.
  const byCategory = useMemo(() => {
    if (resolved.length !== 1 || omitted.length > 0) return null;
    const pins = categories.map((category) => pinnedColor(categoryColors, category));
    if (pins.every((pin) => pin === undefined)) return null;
    const legend: ResolvedSeries[] = [];
    const listed = new Set<string>();
    categories.forEach((category, index) => {
      const pin = pins[index];
      if (pin === undefined || listed.has(category)) return;
      listed.add(category);
      legend.push({
        key: `category:${category}`,
        label: category,
        color: chartColor(pin),
        dash: undefined,
      });
    });
    // A drawn bar left out still wears the series' colour, so the series is named beside them.
    const plain = pins.some((pin, index) => {
      const value = values[0]?.[index] ?? null;
      return pin === undefined && value !== null && value !== 0;
    });
    if (plain) legend.push(resolved[0]!);
    return {
      colors: pins.map((pin) => (pin === undefined ? resolved[0]!.color : chartColor(pin))),
      legend,
    };
  }, [resolved, omitted, categories, categoryColors, values]);
  const cursor = useCursor(rows.length);

  const geometry = useMemo(() => {
    if (width <= 0 || rows.length === 0 || resolved.length === 0) return null;
    let low = 0;
    let high = 0;
    rows.forEach((_, index) => {
      if (stacked) {
        let up = 0;
        let down = 0;
        for (const column of values) {
          const value = column[index] ?? 0;
          if (value > 0) up += value;
          else down += value;
        }
        high = Math.max(high, up);
        low = Math.min(low, down);
      } else {
        for (const column of values) {
          const value = column[index] ?? null;
          if (value === null) continue;
          high = Math.max(high, value);
          low = Math.min(low, value);
        }
      }
    });
    const right = across ? 12 : 4;
    const top = TOP_PAD;
    const bottom = X_AXIS_PX;
    const plotH = Math.max(1, px - top - bottom);
    const categoryAxis = across ? axisWidth(categories, Math.min(160, width * 0.35)) : 0;
    const ticks = across
      ? axisTicks(low, high, Math.max(1, width - categoryAxis - right), X_TICK_SPACING)
      : axisTicks(low, high, plotH, Y_TICK_SPACING);
    const d0 = ticks[0]!;
    const d1 = ticks[ticks.length - 1]!;
    const left = across ? categoryAxis : axisWidth(ticks.map(formats.axis), 72);
    const plotW = Math.max(1, width - left - right);
    const scale = across ? linear(d0, d1, left, left + plotW) : linear(d0, d1, top + plotH, top);
    const bandSpan = across ? plotH : plotW;
    const band = bandSpan / rows.length;
    const bandStart = across ? top : left;
    const gap = band < 8 ? 0 : GAP_PX;
    const k = stacked ? 1 : resolved.length;
    const thickness = Math.max(
      0.5,
      Math.min(BAR_MAX_PX, (band * (band < 8 ? 0.9 : 0.72) - (k - 1) * gap) / k)
    );
    const groupSpan = k * thickness + (k - 1) * gap;
    const zero = scale(0);
    const bars: BarRect[] = [];
    const ends: number[] = [];
    rows.forEach((_, index) => {
      const offset = bandStart + index * band + (band - groupSpan) / 2;
      let end = zero;
      const extend = (at: number) => {
        end = across ? Math.max(end, at) : Math.min(end, at);
      };
      const place = (
        position: number,
        from: number,
        to: number,
        round: boolean,
        key: string,
        color: string
      ) => {
        const lo = Math.min(from, to);
        const size = Math.abs(to - from);
        if (size <= 0) return;
        const outward = across ? to > from : to < from;
        const tip: BarEnd = round
          ? across
            ? outward
              ? "right"
              : "left"
            : outward
              ? "top"
              : "bottom"
          : null;
        const d = across
          ? barPath(lo, position, size, thickness, tip)
          : barPath(position, lo, thickness, size, tip);
        bars.push({ key, d, color });
        extend(to);
      };
      if (stacked) {
        let up = 0;
        let down = 0;
        const lastUp = values.reduce((at, column, s) => ((column[index] ?? 0) > 0 ? s : at), -1);
        const lastDown = values.reduce((at, column, s) => ((column[index] ?? 0) < 0 ? s : at), -1);
        values.forEach((column, s) => {
          const value = column[index] ?? 0;
          if (value === 0) return;
          const base = value > 0 ? up : down;
          const next = base + value;
          let from = scale(base);
          // The surface gap between stacked segments: every segment but the
          // first on its side of zero starts two pixels further out.
          if (base !== 0) from += (across ? 1 : -1) * Math.sign(value) * GAP_PX;
          const to = scale(next);
          const room = across ? (to - from) * Math.sign(value) : (from - to) * Math.sign(value);
          if (room > 0) {
            place(
              offset,
              from,
              to,
              s === (value > 0 ? lastUp : lastDown),
              `${index}:${s}`,
              byCategory?.colors[index] ?? resolved[s]!.color
            );
          }
          if (value > 0) up = next;
          else down = next;
        });
      } else {
        values.forEach((column, s) => {
          const value = column[index] ?? null;
          if (value === null || value === 0) return;
          place(
            offset + s * (thickness + gap),
            zero,
            scale(value),
            true,
            `${index}:${s}`,
            byCategory?.colors[index] ?? resolved[s]!.color
          );
        });
      }
      ends.push(end);
    });
    const labelEvery = Math.max(
      1,
      across
        ? Math.ceil((AXIS_FONT_PX + 4) / band)
        : Math.ceil(
            (Math.min(
              12,
              categories.reduce((most, c) => Math.max(most, c.length), 0)
            ) *
              AXIS_CHAR_PX +
              8) /
              band
          )
    );
    return {
      ticks,
      scale,
      left,
      top,
      plotW,
      plotH,
      band,
      bandStart,
      bars,
      ends,
      labelEvery,
      groupSpan,
    };
  }, [rows, resolved, values, categories, formats, stacked, across, width, px, byCategory]);

  // Built from the data alone, so moving the cursor never rescans it.
  const table = useMemo<TableModel>(() => {
    const all = [...values, ...columnsOf(rows, omitted)];
    const named = [...resolved, ...omitted];
    return {
      xLabel: str(xLabel) ?? "Category",
      series: named,
      omitted,
      rows:
        rows.length > MAX_TABLE_ROWS
          ? null
          : rows.map((_, index) => ({
              key: String(index),
              x: categories[index] ?? "",
              values: cellTexts(all, index, formats.full),
            })),
      summary:
        rows.length > MAX_TABLE_ROWS
          ? summarise(
              rows.length,
              categories[0] ?? "",
              categories[categories.length - 1] ?? "",
              named,
              all,
              formats.full
            )
          : "",
      limit: limitNote(rows.length, allRows.length, "categories"),
    };
  }, [xLabel, resolved, omitted, rows, allRows, categories, values, formats]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (
    rows.length === 0 ||
    resolved.length === 0 ||
    values.every((c) => c.every((v) => v === null))
  ) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  const readout: Readout | null =
    geometry && active !== null
      ? {
          title: categories[active] ?? "",
          rows: readoutRows(resolved, values, active, formats.full).map((row) =>
            byCategory ? { ...row, color: byCategory.colors[active] ?? row.color } : row
          ),
          x: across ? geometry.ends[active]! : geometry.bandStart + (active + 0.5) * geometry.band,
          // Up in the plot's top margin where bars are shortest, beside the
          // column; a horizontal bar's tooltip starts level with its band.
          y: across ? geometry.bandStart + active * geometry.band : geometry.top,
          clear: across ? 0 : geometry.groupSpan / 2,
          swatch: "bar",
        }
      : null;

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={
        <Legend
          series={byCategory?.legend ?? resolved}
          omitted={omitted.length}
          shape="bar"
          always={byCategory !== null}
        />
      }
      table={table}
      cursor={cursor}
      readout={readout}
      measure={measure}
      width={width}
      onPointerMove={(px0, py0) => {
        if (!geometry) return;
        const along = across ? py0 : px0;
        const index = Math.floor((along - geometry.bandStart) / geometry.band);
        cursor.point(index >= 0 && index < rows.length ? index : null);
      }}
    >
      {geometry ? (
        <svg width={width} height={px} className="block overflow-visible" aria-hidden="true">
          {active !== null ? (
            <rect
              data-chart-band=""
              className="fill-overlay-subtle"
              x={across ? geometry.left : geometry.bandStart + active * geometry.band}
              y={across ? geometry.bandStart + active * geometry.band : geometry.top}
              width={across ? geometry.plotW : geometry.band}
              height={across ? geometry.band : geometry.plotH}
            />
          ) : null}
          <ValueGrid
            ticks={geometry.ticks}
            scale={geometry.scale}
            orientation={across ? "horizontal" : "vertical"}
            from={across ? geometry.top : geometry.left}
            to={across ? geometry.top + geometry.plotH : geometry.left + geometry.plotW}
            format={formats.axis}
          />
          <g>
            {geometry.bars.map((bar) => (
              <path key={bar.key} d={bar.d} data-chart-bar="" style={{ fill: bar.color }} />
            ))}
          </g>
          <g>
            {categories.map((category, index) => {
              if (index % geometry.labelEvery !== 0) return null;
              const centre = geometry.bandStart + (index + 0.5) * geometry.band;
              return across ? (
                <text
                  key={index}
                  x={geometry.left - 6}
                  y={centre}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={AXIS_FONT_PX}
                  className="fill-text-secondary"
                >
                  {clip(category, geometry.left - 8)}
                </text>
              ) : (
                <text
                  key={index}
                  x={centre}
                  y={geometry.top + geometry.plotH + 14}
                  textAnchor="middle"
                  fontSize={AXIS_FONT_PX}
                  className="fill-text-secondary"
                >
                  {clip(category, geometry.band * geometry.labelEvery - 4)}
                </text>
              );
            })}
          </g>
        </svg>
      ) : null}
    </AxisChartFrame>
  );
}

// The widest instant a `Date` can hold, either side of the epoch.
const MAX_DATE_MS = 8.64e15;

export function toX(value: unknown, time: boolean): number | null {
  const at =
    value instanceof Date
      ? finite(value.getTime())
      : typeof value === "number"
        ? finite(value)
        : time && typeof value === "string"
          ? finite(Date.parse(value))
          : null;
  // A time x outside what a `Date` can hold cannot be formatted, only dropped.
  return at !== null && time && Math.abs(at) > MAX_DATE_MS ? null : at;
}

/** Index of the point nearest `target` in an ascending list. */
export function nearest(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1]! - target) <= Math.abs(sorted[lo]! - target)) {
    return lo - 1;
  }
  return lo;
}

// Fainter than the area wash, so a wash laid over a band still reads as its own.
const BAND_OPACITY = 0.08;
const REFERENCE_DASH = "4 3";
// Annotation labels sit on the plot; a surface halo keeps them legible where
// they cross a gridline, a rule or a series.
const LABEL_HALO = { stroke: "var(--theme-surface-panel)" };

export interface ChartRule {
  key: string;
  axis: "x" | "y";
  value: number;
  label: string | undefined;
  color: string;
  dashed: boolean;
}

export interface ChartBand {
  key: string;
  axis: "x" | "y";
  from: number;
  to: number;
  label: string | undefined;
  color: string;
}

function overlayAxis(value: unknown, fallback: "x" | "y"): "x" | "y" | undefined {
  return value === undefined ? fallback : oneOf(value, ["x", "y"] as const);
}

function overlayColor(entry: object): string {
  return chartColor(oneOf(field(entry, "color"), COLORS) ?? "neutral");
}

/**
 * Reference lines and bands from untyped JS: an x reads like the chart's own
 * x values, a y must be a finite number, and anything else is dropped.
 * Exported for tests.
 */
export function chartAnnotations(
  referenceLines: unknown,
  bands: unknown,
  time: boolean
): { rules: ChartRule[]; bands: ChartBand[] } {
  const rules: ChartRule[] = [];
  const shaded: ChartBand[] = [];
  const read = (axis: "x" | "y", value: unknown) =>
    axis === "y" ? finite(value) : toX(value, time);
  if (Array.isArray(referenceLines)) {
    referenceLines.forEach((entry: unknown, index) => {
      if (typeof entry !== "object" || entry === null) return;
      const axis = overlayAxis(field(entry, "axis"), "y");
      const value = axis ? read(axis, field(entry, "value")) : null;
      if (!axis || value === null) return;
      rules.push({
        key: `rule:${index}`,
        axis,
        value,
        label: nonEmpty(field(entry, "label")),
        color: overlayColor(entry),
        dashed: field(entry, "stroke") !== "solid",
      });
    });
  }
  if (Array.isArray(bands)) {
    bands.forEach((entry: unknown, index) => {
      if (typeof entry !== "object" || entry === null) return;
      const axis = overlayAxis(field(entry, "axis"), "x");
      if (!axis) return;
      const a = read(axis, field(entry, "from"));
      const b = read(axis, field(entry, "to"));
      if (a === null || b === null || a === b) return;
      shaded.push({
        key: `band:${index}`,
        axis,
        from: Math.min(a, b),
        to: Math.max(a, b),
        label: nonEmpty(field(entry, "label")),
        color: overlayColor(entry),
      });
    });
  }
  return { rules, bands: shaded };
}

/** A plugin's fixed value axis: two finite, distinct ends in either order, or none. */
export function fixedDomain(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = finite(value[0]);
  const b = finite(value[1]);
  if (a === null || b === null || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

function KitLineChart({
  data,
  x,
  series,
  xType,
  area,
  curve,
  "aria-label": ariaLabel,
  height,
  formatValue,
  formatX,
  xLabel,
  referenceLines,
  bands,
  yDomain,
  loading,
  empty,
  className,
  ...rest
}: PluginLineChartProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const [measure, width] = useWidth();
  const clipId = `chart-clip-${useId().replace(/[^\w-]/g, "")}`;
  const { drawn: resolved, omitted } = useMemo(() => chartSeries(series), [series]);
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const smooth = oneOf(curve, ["linear", "monotone"] as const) === "monotone";
  const filled = area === true;

  const model = useMemo(() => {
    const xKey = str(x) ?? "";
    const all = rowsOf(data);
    const first = all[0] ? field(all[0], xKey) : undefined;
    const time =
      oneOf(xType, ["number", "time"] as const) === "time" ||
      (xType === undefined && (first instanceof Date || typeof first === "string"));
    const points = all
      .map((row) => ({ row, x: toX(field(row, xKey), time) }))
      .filter((point): point is { row: object; x: number } => point.x !== null);
    // Plugins mostly pass rows in order; sort only when they are not.
    if (points.some((point, index) => index > 0 && point.x < points[index - 1]!.x)) {
      points.sort((a, b) => a.x - b.x);
    }
    const xs = points.map((point) => point.x);
    const ordered = points.map((point) => point.row);
    return { time, xs, values: columnsOf(ordered, resolved), hidden: columnsOf(ordered, omitted) };
  }, [data, x, xType, resolved, omitted]);

  const { time, xs, values, hidden } = model;
  const cursor = useCursor(xs.length);
  const marks = useMemo(
    () => chartAnnotations(referenceLines, bands, time),
    [referenceLines, bands, time]
  );
  const domain = useMemo(() => fixedDomain(yDomain), [yDomain]);

  const formatPoint = useMemo(
    () =>
      userFormat<number>(formatX, (value) =>
        time
          ? (xs.length > 1 && xs[xs.length - 1]! - xs[0]! < 2 * DAY
              ? TIME_POINT_FORMAT
              : DATE_POINT_FORMAT
            ).format(value)
          : FULL.format(value)
      ),
    [formatX, time, xs]
  );

  const geometry = useMemo(() => {
    if (width <= 0 || xs.length === 0 || resolved.length === 0) return null;
    let low = Infinity;
    let high = -Infinity;
    for (const column of values) {
      for (const value of column) {
        if (value === null) continue;
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    if (low === Infinity) return null;
    if (filled) {
      low = Math.min(0, low);
      high = Math.max(0, high);
    }
    // A target the data never reaches is still the point of the line.
    for (const rule of marks.rules) {
      if (rule.axis !== "y") continue;
      low = Math.min(low, rule.value);
      high = Math.max(high, rule.value);
    }
    const top = TOP_PAD;
    const plotH = Math.max(1, px - top - X_AXIS_PX);
    let ticks = axisTicks(
      domain ? domain[0] : low,
      domain ? domain[1] : high,
      plotH,
      Y_TICK_SPACING
    );
    if (domain) {
      const inside = ticks.filter((tick) => tick >= domain[0] && tick <= domain[1]);
      // A span finer than the ticks' rounding leaves none inside: its ends stand in.
      ticks = new Set(inside).size >= 2 ? inside : [domain[0], domain[1]];
    }
    const d0 = domain ? domain[0] : ticks[0]!;
    const d1 = domain ? domain[1] : ticks[ticks.length - 1]!;
    const left = axisWidth(ticks.map(formats.axis), 72);
    const right = 8;
    const plotW = Math.max(1, width - left - right);
    const x0 = xs[0]!;
    const x1 = xs[xs.length - 1]!;
    const sx = linear(x0, x1, left, left + plotW);
    const sy = linear(d0, d1, top + plotH, top);
    const pixels = xs.map(sx);
    let xTicks: { at: number; text: string }[];
    if (time) {
      const { ticks: stamps, unit } = timeTicks(
        x0,
        x1,
        Math.max(2, Math.floor(plotW / X_TICK_SPACING))
      );
      const axisFormat = userFormat<number>(formatX, (value) =>
        TIME_AXIS_FORMATS[unit].format(value)
      );
      xTicks = stamps.map((stamp) => ({ at: sx(stamp), text: axisFormat(stamp) }));
    } else {
      const axisFormat = userFormat<number>(formatX, (value) => COMPACT.format(value));
      xTicks =
        x0 === x1
          ? [{ at: sx(x0), text: axisFormat(x0) }]
          : axisTicks(x0, x1, plotW, X_TICK_SPACING)
              .filter((tick) => tick >= x0 && tick <= x1)
              .map((tick) => ({ at: sx(tick), text: axisFormat(tick) }));
    }
    const baseline = sy(Math.max(d0, Math.min(0, d1)));
    const lines = values.map((column, s) => {
      const runs: [number, number][][] = [];
      let run: [number, number][] = [];
      column.forEach((value, index) => {
        if (value === null) {
          if (run.length > 0) runs.push(run);
          run = [];
          return;
        }
        run.push([pixels[index]!, sy(value)]);
      });
      if (run.length > 0) runs.push(run);
      const drawn = runs.map((points) => (points.length > plotW * 2 ? decimate(points) : points));
      const stroke = drawn
        .filter((points) => points.length > 1)
        .map((points) => (smooth ? monotonePath(points) : linearPath(points)))
        .join("");
      // Only the first series fills: stacked translucent fills blend into
      // one slate that belongs to no line, and the first series is the one a
      // comparison chart leads with; the rest read as strokes above it.
      const fill =
        filled && s === 0
          ? drawn
              .filter((points) => points.length > 1)
              .map((points) => {
                const start = points[0]![0];
                const end = points[points.length - 1]![0];
                const outline = smooth ? monotonePath(points) : linearPath(points);
                return `${outline}L${fixed(end)},${fixed(baseline)}L${fixed(start)},${fixed(baseline)}Z`;
              })
              .join("")
          : "";
      const dots = drawn.flatMap((points) => (points.length === 1 ? points : []));
      const entry = resolved[s]!;
      return { key: entry.key, color: entry.color, dash: entry.dash, stroke, fill, dots };
    });
    const right0 = left + plotW;
    const bottom = top + plotH;
    const inX = (value: number) => value >= x0 && value <= x1;
    const inY = (value: number) => value >= d0 && value <= d1;
    const shades = marks.bands.flatMap((band) => {
      if (band.axis === "x") {
        if (band.from > x1 || band.to < x0) return [];
        const a = band.from <= x0 ? left : sx(band.from);
        const b = band.to >= x1 ? right0 : sx(band.to);
        return [{ ...band, x: a, y: top, w: b - a, h: plotH }];
      }
      if (band.from > d1 || band.to < d0) return [];
      const a = sy(Math.min(band.to, d1));
      const b = sy(Math.max(band.from, d0));
      return [{ ...band, x: left, y: a, w: plotW, h: b - a }];
    });
    const rules = marks.rules.flatMap((rule) =>
      (rule.axis === "x" ? inX(rule.value) : inY(rule.value))
        ? [
            {
              ...rule,
              at: Math.round(rule.axis === "x" ? sx(rule.value) : sy(rule.value)) + 0.5,
            },
          ]
        : []
    );
    // Along the top: x rules' and x bands' labels, thinned as the x ticks are.
    const topLabels = withoutOverlaps(
      [
        ...rules.flatMap((rule) =>
          rule.axis === "x" && rule.label
            ? [{ key: rule.key, at: rule.at, text: clip(rule.label, 160) }]
            : []
        ),
        ...shades.flatMap((band) =>
          band.axis === "x" && band.label
            ? [{ key: band.key, at: band.x + band.w / 2, text: clip(band.label, band.w - 4) }]
            : []
        ),
      ]
        .filter((entry) => entry.text !== "")
        .sort((a, b) => a.at - b.at),
      left,
      right0
    );
    // Down the right edge, clear of the value axis: y rules' labels, each
    // above its rule (below one at the plot's top), a line apart and clear of
    // any top-lane label that reaches the right edge.
    const lane = top + AXIS_FONT_PX;
    const laneRight = topLabels.reduce((most, entry) => {
      const width = entry.text.length * AXIS_CHAR_PX;
      const anchor = edgeAnchor(entry, left, right0);
      const end =
        anchor === "start" ? entry.at + width : anchor === "end" ? entry.at : entry.at + width / 2;
      return Math.max(most, end);
    }, -Infinity);
    const candidates = rules.flatMap((rule) => {
      if (rule.axis !== "y" || !rule.label) return [];
      const above = rule.at - 4;
      const y = above - AXIS_FONT_PX < top ? rule.at + AXIS_FONT_PX + 2 : above;
      return [{ key: rule.key, y, text: clip(rule.label, plotW / 2) }];
    });
    const sideLabels: { key: string; y: number; text: string }[] = [];
    let lastY = -Infinity;
    for (const entry of candidates.sort((a, b) => a.y - b.y)) {
      if (entry.y - lastY < AXIS_FONT_PX + 2) continue;
      const start = right0 - 4 - entry.text.length * AXIS_CHAR_PX;
      if (Math.abs(entry.y - lane) < AXIS_FONT_PX + 2 && laneRight + 6 > start) continue;
      lastY = entry.y;
      sideLabels.push(entry);
    }
    const labelled = new Set(topLabels.map((entry) => entry.key));
    return {
      ticks,
      sy,
      d0,
      d1,
      left,
      top,
      plotW,
      plotH,
      bottom,
      pixels,
      xTicks: withoutOverlaps(xTicks, left, left + plotW),
      lines,
      shades,
      rules: rules.map((rule) => ({
        ...rule,
        // A rule whose label caps it starts under the label.
        from: labelled.has(rule.key) ? top + AXIS_FONT_PX + 4 : top,
      })),
      topLabels,
      sideLabels,
    };
  }, [time, xs, values, resolved, formats, width, px, filled, smooth, formatX, marks, domain]);

  // Built from the data alone, so moving the cursor never rescans it.
  const table = useMemo<TableModel>(() => {
    const all = [...values, ...hidden];
    const named = [...resolved, ...omitted];
    return {
      xLabel: str(xLabel) ?? (time ? "Time" : "X"),
      series: named,
      omitted,
      rows:
        xs.length > MAX_TABLE_ROWS
          ? null
          : xs.map((value, index) => ({
              key: String(index),
              x: formatPoint(value),
              values: cellTexts(all, index, formats.full),
            })),
      summary:
        xs.length > MAX_TABLE_ROWS
          ? summarise(
              xs.length,
              formatPoint(xs[0] ?? 0),
              formatPoint(xs[xs.length - 1] ?? 0),
              named,
              all,
              formats.full
            )
          : "",
      annotations: annotationNote(marks, formats.full, formatPoint),
    };
  }, [xLabel, time, resolved, omitted, xs, values, hidden, formats, formatPoint, marks]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (xs.length === 0 || resolved.length === 0 || values.every((c) => c.every((v) => v === null))) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  let readout: Readout | null = null;
  let focus: { x: number; dots: { key: string; color: string; y: number }[] } | null = null;
  if (geometry && active !== null) {
    const at = geometry.pixels[active] ?? 0;
    const dots = resolved.flatMap((entry, s) => {
      const value = values[s]?.[active] ?? null;
      return value === null || value < geometry.d0 || value > geometry.d1
        ? []
        : [{ key: entry.key, color: entry.color, y: geometry.sy(value) }];
    });
    focus = { x: at, dots };
    readout = {
      title: formatPoint(xs[active] ?? 0),
      rows: readoutRows(resolved, values, active, formats.full),
      x: at,
      // Level with the plot's top, right of the crosshair: the stretch of
      // line up to the point stays in view.
      y: geometry.top,
      swatch: "line",
    };
  }

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={<Legend series={resolved} omitted={omitted.length} shape="line" />}
      table={table}
      cursor={cursor}
      readout={readout}
      measure={measure}
      width={width}
      onPointerMove={(px0) => {
        if (!geometry) return;
        cursor.point(nearest(geometry.pixels, px0));
      }}
    >
      {geometry ? (
        <svg width={width} height={px} className="block overflow-visible" aria-hidden="true">
          {domain ? (
            <defs>
              <clipPath id={clipId}>
                <rect
                  x={geometry.left}
                  y={geometry.top}
                  width={geometry.plotW}
                  height={geometry.plotH}
                />
              </clipPath>
            </defs>
          ) : null}
          {geometry.shades.map((band) => (
            <rect
              key={band.key}
              data-chart-reference-band={band.axis}
              x={band.x}
              y={band.y}
              width={Math.max(0, band.w)}
              height={Math.max(0, band.h)}
              fill="currentColor"
              fillOpacity={BAND_OPACITY}
              style={{ color: band.color }}
            />
          ))}
          <ValueGrid
            ticks={geometry.ticks}
            scale={geometry.sy}
            orientation="vertical"
            from={geometry.left}
            to={geometry.left + geometry.plotW}
            format={formats.axis}
          />
          <g>
            {geometry.xTicks.map((tick, index) => (
              <text
                key={index}
                data-chart-x-tick=""
                x={tick.at}
                y={geometry.top + geometry.plotH + 14}
                textAnchor={edgeAnchor(tick, geometry.left, geometry.left + geometry.plotW)}
                fontSize={AXIS_FONT_PX}
                className="fill-text-secondary tabular-nums"
              >
                {tick.text}
              </text>
            ))}
          </g>
          <g data-chart-annotations="">
            {geometry.rules.map((rule) =>
              rule.axis === "y" ? (
                <line
                  key={rule.key}
                  data-chart-reference-line="y"
                  x1={geometry.left}
                  x2={geometry.left + geometry.plotW}
                  y1={rule.at}
                  y2={rule.at}
                  stroke="currentColor"
                  strokeWidth={1}
                  strokeDasharray={rule.dashed ? REFERENCE_DASH : undefined}
                  style={{ color: rule.color }}
                />
              ) : (
                <line
                  key={rule.key}
                  data-chart-reference-line="x"
                  x1={rule.at}
                  x2={rule.at}
                  y1={rule.from}
                  y2={geometry.bottom}
                  stroke="currentColor"
                  strokeWidth={1}
                  strokeDasharray={rule.dashed ? REFERENCE_DASH : undefined}
                  style={{ color: rule.color }}
                />
              )
            )}
            {geometry.shades.map((band) =>
              band.axis === "y" && band.label && band.h >= AXIS_FONT_PX + 4 ? (
                <text
                  key={band.key}
                  data-chart-annotation-label=""
                  x={geometry.left + 4}
                  y={band.y + AXIS_FONT_PX}
                  fontSize={AXIS_FONT_PX}
                  strokeWidth={3}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  className="fill-text-secondary"
                  style={LABEL_HALO}
                >
                  {clip(band.label, geometry.plotW / 2)}
                </text>
              ) : null
            )}
            {geometry.topLabels.map((entry) => (
              <text
                key={entry.key}
                data-chart-annotation-label=""
                x={entry.at}
                y={geometry.top + AXIS_FONT_PX}
                textAnchor={edgeAnchor(entry, geometry.left, geometry.left + geometry.plotW)}
                fontSize={AXIS_FONT_PX}
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                className="fill-text-secondary"
                style={LABEL_HALO}
              >
                {entry.text}
              </text>
            ))}
            {geometry.sideLabels.map((entry) => (
              <text
                key={entry.key}
                data-chart-annotation-label=""
                x={geometry.left + geometry.plotW - 4}
                y={entry.y}
                textAnchor="end"
                fontSize={AXIS_FONT_PX}
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                className="fill-text-secondary"
                style={LABEL_HALO}
              >
                {entry.text}
              </text>
            ))}
          </g>
          <g clipPath={domain ? `url(#${clipId})` : undefined}>
            {geometry.lines.map((line) => (
              <g key={line.key} style={{ color: line.color }} data-chart-series={line.key}>
                {line.fill ? <path d={line.fill} fill="currentColor" fillOpacity={0.1} /> : null}
                <path
                  d={line.stroke}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={line.dash}
                />
                {line.dots.map(([cx, cy], index) => (
                  <circle key={index} cx={cx} cy={cy} r={2} fill="currentColor" />
                ))}
              </g>
            ))}
          </g>
          {focus ? (
            <g data-chart-crosshair="">
              <line
                x1={Math.round(focus.x) + 0.5}
                x2={Math.round(focus.x) + 0.5}
                y1={geometry.top}
                y2={geometry.top + geometry.plotH}
                strokeWidth={1}
                className="stroke-border-strong"
              />
              {focus.dots.map((dot) => (
                // The surface ring keeps the marker legible where lines cross.
                <circle
                  key={dot.key}
                  cx={focus.x}
                  cy={dot.y}
                  r={4}
                  strokeWidth={2}
                  style={{ fill: dot.color, stroke: "var(--theme-surface-panel)" }}
                />
              ))}
            </g>
          ) : null}
        </svg>
      ) : null}
    </AxisChartFrame>
  );
}

function annotationNote(
  marks: { rules: ChartRule[]; bands: ChartBand[] },
  formatValue: Format<number>,
  formatPoint: Format<number>
): string | undefined {
  const at = (axis: "x" | "y", value: number) =>
    axis === "y" ? formatValue(value) : formatPoint(value);
  const parts: string[] = [];
  if (marks.rules.length > 0) {
    const rules = marks.rules.map(
      (rule) => `${rule.label ?? "Line"} at ${at(rule.axis, rule.value)}`
    );
    parts.push(`Reference lines: ${rules.join("; ")}`);
  }
  if (marks.bands.length > 0) {
    const bands = marks.bands.map(
      (band) =>
        `${band.label ?? "Range"} from ${at(band.axis, band.from)} to ${at(band.axis, band.to)}`
    );
    parts.push(`Shaded ranges: ${bands.join("; ")}`);
  }
  return parts.length > 0 ? parts.join(". ") : undefined;
}

interface DonutPart {
  key: string;
  name: string;
  value: number;
  color: string;
}

/**
 * Up to {@link MAX_DONUT_PARTS} parts by name; past that the first five keep
 * their names and `rest` is what the others add up to, for one neutral
 * "Other" part. Shared by every part-of-whole mark so they fold alike.
 */
export function foldParts<T extends { value: number }>(
  parts: readonly T[]
): { named: T[]; rest: number | null } {
  if (parts.length <= MAX_DONUT_PARTS) return { named: [...parts], rest: null };
  const rest = parts.slice(MAX_DONUT_PARTS - 1).reduce((sum, part) => sum + part.value, 0);
  return { named: parts.slice(0, MAX_DONUT_PARTS - 1), rest };
}

/** Parts from rows: positive finite sizes only, the tail past the fifth folded into one neutral part. Exported for tests. */
export function donutParts(
  data: unknown,
  x: string,
  valueKey: string,
  otherLabel: string,
  colors?: unknown
): DonutPart[] {
  const parts = rowsOf(data)
    .map((row) => {
      const name = field(row, x);
      return {
        name: typeof name === "string" || typeof name === "number" ? String(name) : "",
        value: finite(field(row, valueKey)),
      };
    })
    .filter(
      (part): part is { name: string; value: number } => part.value !== null && part.value > 0
    );
  const { named, rest } = foldParts(parts);
  const hues = slotColors(named.map((part) => pinnedColor(colors, part.name)));
  const out: DonutPart[] = named.map((part, index) => ({
    key: String(index),
    name: part.name,
    value: part.value,
    color: chartColor(hues[index] ?? "neutral"),
  }));
  if (rest !== null) {
    out.push({ key: "other", name: otherLabel, value: rest, color: chartColor("neutral") });
  }
  return out;
}

export function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  a0: number,
  a1: number
): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // A whole ring: two half circles each way, cut out with even-odd.
    return (
      `M${fixed(cx)},${fixed(cy - outer)}A${outer},${outer} 0 1 1 ${fixed(cx)},${fixed(cy + outer)}A${outer},${outer} 0 1 1 ${fixed(cx)},${fixed(cy - outer)}Z` +
      `M${fixed(cx)},${fixed(cy - inner)}A${inner},${inner} 0 1 0 ${fixed(cx)},${fixed(cy + inner)}A${inner},${inner} 0 1 0 ${fixed(cx)},${fixed(cy - inner)}Z`
    );
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [ox0, oy0] = polar(cx, cy, outer, a0);
  const [ox1, oy1] = polar(cx, cy, outer, a1);
  const [ix1, iy1] = polar(cx, cy, inner, a1);
  const [ix0, iy0] = polar(cx, cy, inner, a0);
  return `M${fixed(ox0)},${fixed(oy0)}A${outer},${outer} 0 ${large} 1 ${fixed(ox1)},${fixed(oy1)}L${fixed(ix1)},${fixed(iy1)}A${inner},${inner} 0 ${large} 0 ${fixed(ix0)},${fixed(iy0)}Z`;
}

/** A part's share of a whole as a whole percentage, "<1%" for a sliver. */
export function share(value: number, total: number): string {
  const percent = (value / total) * 100;
  if (percent > 0 && percent < 0.5) return "<1%";
  return `${Math.round(percent)}%`;
}

function KitDonutChart({
  data,
  x,
  value,
  centerValue,
  centerLabel,
  otherLabel,
  colors,
  "aria-label": ariaLabel,
  height,
  formatValue,
  loading,
  empty,
  className,
  ...rest
}: PluginDonutChartProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const format = valueFormats(formatValue).full;
  const parts = useMemo(
    () => donutParts(data, str(x) ?? "", str(value) ?? "", nonEmpty(otherLabel) ?? "Other", colors),
    [data, x, value, otherLabel, colors]
  );
  const cursor = useCursor(parts.length);
  const describedBy = useId();

  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const size = px;
  const centre = size / 2;
  const outer = centre - 4;
  const thickness = Math.max(10, outer * 0.24);
  const inner = outer - thickness;
  const slices = useMemo(() => {
    const mid = (outer + inner) / 2;
    // Half the surface gap on each side of a slice, as an angle at mid-ring.
    const pad = parts.length > 1 ? GAP_PX / mid / 2 : 0;
    const out: (DonutPart & { a0: number; a1: number; middle: number })[] = [];
    let angle = 0;
    for (const part of parts) {
      const sweep = (part.value / total) * Math.PI * 2;
      const padded = sweep > pad * 4 ? pad : 0;
      out.push({
        ...part,
        a0: angle + padded,
        a1: angle + sweep - padded,
        middle: angle + sweep / 2,
      });
      angle += sweep;
    }
    return out;
  }, [parts, total, outer, inner]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (parts.length === 0) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  let readout: Readout | null = null;
  const part = active === null ? undefined : slices[active];
  if (part) {
    const [ax, ay] = polar(centre, centre, outer, part.middle);
    readout = {
      title: "",
      rows: [
        {
          key: part.key,
          label: `${part.name} · ${share(part.value, total)}`,
          color: part.color,
          value: format(part.value),
        },
      ],
      x: ax,
      y: ay - TOOLTIP_OFFSET,
      swatch: "bar",
    };
  }
  const figure = hasContent(centerValue) ? node(centerValue) : format(total);

  return (
    <div {...root} className={cn("flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3", classes)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <div
          role="group"
          aria-roledescription="chart"
          aria-label={label}
          aria-describedby={describedBy}
          tabIndex={0}
          data-chart-plot=""
          onKeyDown={cursor.onKeyDown}
          onBlur={cursor.clear}
          onPointerLeave={() => cursor.point(null)}
          className="absolute inset-0 rounded-full focus-visible:outline-offset-2"
        >
          <svg width={size} height={size} className="block" aria-hidden="true">
            {slices.map((slice, index) => (
              <path
                key={slice.key}
                data-chart-part=""
                d={arcPath(
                  centre,
                  centre,
                  index === active ? outer + 3 : outer,
                  inner,
                  slice.a0,
                  slice.a1
                )}
                fillRule="evenodd"
                style={{ fill: slice.color }}
                onPointerEnter={() => cursor.point(index)}
              />
            ))}
          </svg>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
        >
          <span
            className="truncate text-lg font-semibold text-text-primary"
            style={{ maxWidth: inner * 1.6 }}
          >
            {figure}
          </span>
          {hasContent(centerLabel) ? (
            <span
              className="truncate text-xs text-text-secondary"
              style={{ maxWidth: inner * 1.6 }}
            >
              {node(centerLabel)}
            </span>
          ) : null}
        </div>
        {readout ? <PointTooltip readout={readout} width={size} /> : null}
      </div>
      <ul
        id={describedBy}
        aria-label="Legend"
        className="flex min-w-40 flex-1 flex-col gap-1 text-xs"
      >
        {parts.map((part, index) => (
          <li
            key={part.key}
            data-active={index === active ? "" : undefined}
            className="flex min-w-0 items-center gap-2"
          >
            <Swatch color={part.color} shape="bar" />
            <span className="min-w-0 flex-1 truncate text-text-secondary">{part.name}</span>
            <span className="tabular-nums text-text-primary">{format(part.value)}</span>
            <span className="w-10 text-right tabular-nums text-text-secondary">
              {share(part.value, total)}
            </span>
          </li>
        ))}
      </ul>
      <div className="sr-only" aria-live="polite">
        {cursor.keyboard && readout ? readoutText(readout) : ""}
      </div>
    </div>
  );
}

export const pluginKitCharts = {
  BarChart: KitBarChart,
  LineChart: KitLineChart,
  DonutChart: KitDonutChart,
};
