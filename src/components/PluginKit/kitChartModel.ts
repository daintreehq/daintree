import type { PluginChartColor } from "@shared/types/plugin-sdk-react";
import { field, fn, nonEmpty, oneOf, positive, str } from "./kitProps";
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

export type BarEnd = "top" | "bottom" | "left" | "right" | null;

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

/** A part's share of a whole as a whole percentage, "<1%" for a sliver. */
export function share(value: number, total: number): string {
  const percent = (value / total) * 100;
  if (percent > 0 && percent < 0.5) return "<1%";
  return `${Math.round(percent)}%`;
}
