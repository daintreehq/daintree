import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type {
  PluginContributionGridProps,
  PluginGaugeProps,
  PluginHeatmapProps,
  PluginHistogramProps,
  PluginScatterChartProps,
  PluginStackedAreaChartProps,
} from "@shared/types/plugin-sdk-react";
import { cn } from "@/lib/utils";
import {
  AXIS_FONT_PX,
  AxisChartFrame,
  ChartEmpty,
  ChartLoading,
  limitNote,
  COLORS,
  COMPACT,
  DATE_POINT_FORMAT,
  DAY,
  FULL,
  GAP_PX,
  Legend,
  MAX_TABLE_ROWS,
  NO_VALUE,
  TIME_AXIS_FORMATS,
  TIME_POINT_FORMAT,
  TOP_PAD,
  ValueGrid,
  X_AXIS_PX,
  X_TICK_SPACING,
  Y_TICK_SPACING,
  axisTicks,
  axisWidth,
  barPath,
  cellTexts,
  chartColor,
  chartProps,
  chartSeries,
  clip,
  columnsOf,
  edgeAnchor,
  withoutOverlaps,
  finite,
  fixed,
  linear,
  linearPath,
  markerPath,
  nearest,
  readoutRows,
  rowsOf,
  summarise,
  niceTicks,
  timeTicks,
  toX,
  useCursor,
  useWidth,
  userFormat,
  valueFormats,
  type Cursor,
  type MarkerShape,
  type NamedSeries,
  type Readout,
  type ReadoutRow,
  type TableModel,
} from "./PluginKitCharts";
import { field, hasContent, node, oneOf, pickRootProps, positive, str } from "./kitProps";
import { severityGlyph } from "./PluginKitPatterns";

// The chart family's further forms. Every axis chart here sits in the same
// frame as BarChart and LineChart (legend, one keyboard stop, the point
// tooltip, the live readout and the hidden data table), so they read as one
// set. Magnitude forms (Heatmap, ContributionGrid) shade one hue from faint to
// full, never a rainbow; the ramp is a mix toward transparent so its light end
// meets whatever surface the chart sits on, in light and dark themes alike.

function hueOf(color: unknown): string {
  return chartColor(oneOf(color, COLORS) ?? "blue");
}

// The ramp's faintest shade. Below about this, the smallest populated value
// sinks into the surface and reads as no data at all.
const RAMP_FLOOR = 0.38;

/** A step along a one-hue ramp: `t` 0 is the faintest shade, 1 the full hue. Exported for tests. */
export function rampColor(hue: string, t: number): string {
  const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const share = RAMP_FLOOR + clamped * (1 - RAMP_FLOOR);
  return `color-mix(in oklab, ${hue} ${Math.round(share * 100)}%, transparent)`;
}

/**
 * The active cell of a grid chart, from the pointer or the arrow keys, laid
 * out column by column (`index = col * rows + row`). The same contract as the
 * axis charts' cursor, so the frame drives either. Exported for tests.
 */
export function useGridCursor(
  cols: number,
  rows: number,
  isValid: (index: number) => boolean = () => true
): Cursor {
  const [state, setState] = useState<{ index: number; keyboard: boolean } | null>(null);
  const count = cols * rows;
  const index = state !== null && state.index < count ? state.index : null;
  const keyboard = index !== null && state?.keyboard === true;
  const firstValid = (from: number, step: number): number | null => {
    for (let at = from; at >= 0 && at < count; at += step) if (isValid(at)) return at;
    return null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (count === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      if (index === null) return;
      event.preventDefault();
      setState(null);
      return;
    }
    let next: number | null = null;
    if (event.key === "Home") next = firstValid(0, 1);
    else if (event.key === "End") next = firstValid(count - 1, -1);
    else if (index === null) {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = firstValid(0, 1);
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        next = firstValid(count - 1, -1);
    } else {
      const col = Math.floor(index / rows);
      const row = index % rows;
      let target: number | null = null;
      if (event.key === "ArrowRight" && col < cols - 1) target = index + rows;
      else if (event.key === "ArrowLeft" && col > 0) target = index - rows;
      else if (event.key === "ArrowDown" && row < rows - 1) target = index + 1;
      else if (event.key === "ArrowUp" && row > 0) target = index - 1;
      else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        return;
      }
      next = target !== null && isValid(target) ? target : null;
      if (next === null && target !== null) {
        event.preventDefault();
        return;
      }
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

/** A faint-to-full key for a one-hue chart: "Less ▢▢▢▢ More", or the value range. */
function RampLegend({
  hue,
  low,
  high,
  steps,
}: {
  hue: string;
  low: string;
  high: string;
  steps?: number;
}) {
  return (
    <div
      aria-hidden="true"
      data-chart-ramp=""
      className="flex items-center gap-1.5 text-xs tabular-nums text-text-secondary"
    >
      <span>{low}</span>
      {steps ? (
        <span className="flex gap-0.5">
          {Array.from({ length: steps }, (_, step) => (
            <span
              key={step}
              className={cn(
                "h-2.5 w-2.5 rounded-[var(--radius-xs)]",
                step === 0 && "bg-overlay-emphasis"
              )}
              style={
                step === 0
                  ? undefined
                  : {
                      backgroundColor: rampColor(hue, step / (steps - 1)),
                      boxShadow: `inset 0 0 0 1px ${hue}`,
                    }
              }
            />
          ))}
        </span>
      ) : (
        <span
          className="h-2 w-20 rounded-[var(--radius-xs)]"
          style={{
            backgroundImage: `linear-gradient(to right, ${rampColor(hue, 0)}, ${rampColor(hue, 1)})`,
          }}
        />
      )}
      <span>{high}</span>
    </div>
  );
}

function categoryKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

interface Categories {
  keys: string[];
  raws: unknown[];
  /** Every distinct category, the ones past the cap included. */
  total: number;
}

function categoriesOf(
  given: unknown,
  rows: readonly object[],
  key: string,
  cap: number
): Categories {
  const keys: string[] = [];
  const raws: unknown[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const k = categoryKey(raw);
    if (k === null || seen.has(k)) return;
    seen.add(k);
    if (keys.length >= cap) return;
    keys.push(k);
    raws.push(raw);
  };
  if (Array.isArray(given)) for (const raw of given) add(raw);
  else for (const row of rows) add(field(row, key));
  return { keys, raws, total: seen.size };
}

export const MAX_HEATMAP_COLUMNS = 200;
export const MAX_HEATMAP_ROWS = 100;

const stringFormat = (raw: unknown) => (raw === undefined || raw === null ? "" : String(raw));

/** Cell values by row category then column; rows naming the same pair add up. Exported for tests. */
export function heatmapGrid(
  data: unknown,
  xKey: string,
  yKey: string,
  valueKey: string,
  xCategories?: unknown,
  yCategories?: unknown
): { xs: Categories; ys: Categories; grid: (number | null)[][]; low: number; high: number } {
  const rows = rowsOf(data);
  // Columns and rows past these are not drawn: a cell narrower than a pixel
  // says nothing, and every pair of categories is a cell to allocate.
  const xs = categoriesOf(xCategories, rows, xKey, MAX_HEATMAP_COLUMNS);
  const ys = categoriesOf(yCategories, rows, yKey, MAX_HEATMAP_ROWS);
  const xIndex = new Map(xs.keys.map((k, i) => [k, i]));
  const yIndex = new Map(ys.keys.map((k, i) => [k, i]));
  const grid: (number | null)[][] = ys.keys.map(() => xs.keys.map(() => null));
  for (const row of rows) {
    const xk = categoryKey(field(row, xKey));
    const yk = categoryKey(field(row, yKey));
    if (xk === null || yk === null) continue;
    const xi = xIndex.get(xk);
    const yi = yIndex.get(yk);
    const value = finite(field(row, valueKey));
    if (xi === undefined || yi === undefined || value === null) continue;
    grid[yi]![xi] = (grid[yi]![xi] ?? 0) + value;
  }
  let low = Infinity;
  let high = -Infinity;
  for (const line of grid) {
    for (const value of line) {
      if (value === null) continue;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  return { xs, ys, grid, low, high };
}

function KitHeatmap({
  data,
  x,
  y,
  value,
  xCategories,
  yCategories,
  color,
  formatX,
  formatY,
  yLabel,
  "aria-label": ariaLabel,
  height,
  formatValue,
  loading,
  empty,
  className,
  ...rest
}: PluginHeatmapProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const [measure, width] = useWidth();
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const hue = hueOf(color);
  const model = useMemo(
    () => heatmapGrid(data, str(x) ?? "", str(y) ?? "", str(value) ?? "", xCategories, yCategories),
    [data, x, y, value, xCategories, yCategories]
  );
  const xNames = useMemo(() => {
    const format = userFormat<unknown>(formatX, stringFormat);
    return model.xs.raws.map((raw) => format(raw));
  }, [model, formatX]);
  const yNames = useMemo(() => {
    const format = userFormat<unknown>(formatY, stringFormat);
    return model.ys.raws.map((raw) => format(raw));
  }, [model, formatY]);
  const cols = xNames.length;
  const rowCount = yNames.length;
  const cursor = useGridCursor(cols, rowCount);
  const shade = (cell: number) =>
    rampColor(hue, model.high === model.low ? 1 : (cell - model.low) / (model.high - model.low));

  const geometry = useMemo(() => {
    if (width <= 0 || cols === 0 || rowCount === 0) return null;
    const left = axisWidth(yNames, Math.min(140, width * 0.3));
    const top = TOP_PAD;
    const plotW = Math.max(1, width - left - 4);
    const plotH = Math.max(1, px - top - X_AXIS_PX);
    const cellW = plotW / cols;
    const cellH = plotH / rowCount;
    const gap = Math.min(cellW, cellH) >= 8 ? GAP_PX : Math.min(cellW, cellH) >= 4 ? 1 : 0;
    const longest = Math.min(
      12,
      xNames.reduce((most, name) => Math.max(most, name.length), 0)
    );
    const xEvery = Math.max(1, Math.ceil((longest * 6.2 + 8) / cellW));
    const yEvery = Math.max(1, Math.ceil((AXIS_FONT_PX + 2) / cellH));
    return { left, top, plotW, plotH, cellW, cellH, gap, xEvery, yEvery };
  }, [width, cols, rowCount, px, xNames, yNames]);

  const table = useMemo<TableModel>(() => {
    const series: NamedSeries[] = xNames.map((name, i) => ({
      key: model.xs.keys[i]!,
      label: name,
    }));
    const columns = model.xs.keys.map((_, xi) => model.grid.map((line) => line[xi] ?? null));
    const tooBig = rowCount > MAX_TABLE_ROWS || cols > 60;
    return {
      xLabel: str(yLabel) ?? "Row",
      series: tooBig ? [] : series,
      omitted: [],
      rows: tooBig
        ? null
        : yNames.map((name, yi) => ({
            key: model.ys.keys[yi]!,
            x: name,
            values: cellTexts(columns, yi, formats.full),
          })),
      summary: tooBig
        ? `${rowCount} rows by ${cols} columns, values from ${formats.full(model.low)} to ${formats.full(model.high)}.`
        : "",
      limit:
        [limitNote(cols, model.xs.total, "columns"), limitNote(rowCount, model.ys.total, "rows")]
          .filter((part) => part !== undefined)
          .join(". ") || undefined,
    };
  }, [xNames, yNames, model, rowCount, cols, yLabel, formats]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (cols === 0 || rowCount === 0 || model.low === Infinity) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  let readout: Readout | null = null;
  if (geometry && active !== null) {
    const xi = Math.floor(active / rowCount);
    const yi = active % rowCount;
    const cell = model.grid[yi]?.[xi] ?? null;
    readout = {
      title: `${yNames[yi]} · ${xNames[xi]}`,
      rows: [
        {
          key: "value",
          label: "",
          color: cell === null ? "transparent" : shade(cell),
          value: cell === null ? NO_VALUE : formats.full(cell),
        },
      ],
      x: geometry.left + (xi + 0.5) * geometry.cellW,
      y: geometry.top + yi * geometry.cellH,
      clear: geometry.cellW / 2,
      swatch: "bar",
    };
  }

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={
        <RampLegend hue={hue} low={formats.full(model.low)} high={formats.full(model.high)} />
      }
      table={table}
      cursor={cursor}
      readout={readout}
      measure={measure}
      width={width}
      onPointerMove={(px0, py0) => {
        if (!geometry) return;
        const xi = Math.floor((px0 - geometry.left) / geometry.cellW);
        const yi = Math.floor((py0 - geometry.top) / geometry.cellH);
        cursor.point(xi >= 0 && xi < cols && yi >= 0 && yi < rowCount ? xi * rowCount + yi : null);
      }}
    >
      {geometry ? (
        <svg width={width} height={px} className="block overflow-visible" aria-hidden="true">
          <g>
            {model.grid.map((line, yi) =>
              line.map((cell, xi) => (
                <rect
                  key={`${xi}:${yi}`}
                  data-chart-cell=""
                  // Inset half a pixel so the 1px contour sits inside the cell.
                  x={geometry.left + xi * geometry.cellW + geometry.gap / 2 + 0.5}
                  y={geometry.top + yi * geometry.cellH + geometry.gap / 2 + 0.5}
                  width={Math.max(0.5, geometry.cellW - geometry.gap - 1)}
                  height={Math.max(0.5, geometry.cellH - geometry.gap - 1)}
                  rx={Math.min(2, geometry.cellW / 4, geometry.cellH / 4)}
                  strokeWidth={1}
                  // A pair with no value is an empty outline, never a shade a
                  // reader could take for a small one. A value carries a
                  // contour in the full hue, so even the faintest shade stands
                  // off the surface as a mark.
                  className={cell === null ? "fill-transparent stroke-border-default" : undefined}
                  style={cell === null ? undefined : { fill: shade(cell), stroke: hue }}
                />
              ))
            )}
          </g>
          {active !== null ? (
            <rect
              data-chart-active=""
              x={
                geometry.left +
                Math.floor(active / rowCount) * geometry.cellW +
                geometry.gap / 2 -
                1
              }
              y={geometry.top + (active % rowCount) * geometry.cellH + geometry.gap / 2 - 1}
              width={Math.max(0.5, geometry.cellW - geometry.gap) + 2}
              height={Math.max(0.5, geometry.cellH - geometry.gap) + 2}
              rx={3}
              fill="none"
              strokeWidth={2}
              className="stroke-text-primary"
            />
          ) : null}
          <g>
            {yNames.map((name, yi) =>
              yi % geometry.yEvery === 0 ? (
                <text
                  key={yi}
                  x={geometry.left - 6}
                  y={geometry.top + (yi + 0.5) * geometry.cellH}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={AXIS_FONT_PX}
                  className="fill-text-secondary"
                >
                  {clip(name, geometry.left - 8)}
                </text>
              ) : null
            )}
            {xNames.map((name, xi) =>
              xi % geometry.xEvery === 0 ? (
                <text
                  key={xi}
                  x={geometry.left + (xi + 0.5) * geometry.cellW}
                  y={geometry.top + geometry.plotH + 14}
                  textAnchor="middle"
                  fontSize={AXIS_FONT_PX}
                  className="fill-text-secondary tabular-nums"
                >
                  {clip(name, geometry.cellW * geometry.xEvery - 4)}
                </text>
              ) : null
            )}
          </g>
        </svg>
      ) : null}
    </AxisChartFrame>
  );
}

// ContributionGrid works in whole local days, numbered as UTC days so a
// daylight-saving change never makes a day 23 or 25 hours long.

function dayNumber(ms: number): number {
  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY);
}

function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });

const GRID_LEVELS = 5;
const DEFAULT_WEEKS = 53;
const MAX_WEEKS = 260;
const DEFAULT_PITCH = 14;
const MIN_PITCH = 10;
const MONTH_ROW_PX = 16;
const WEEKDAY_GUTTER_PX = 30;

// The days either side of the epoch a Date can hold.
const MAX_DAY = 8.64e15 / DAY;

/** Whether a calendar ending on `day` fits, at its widest, inside what a Date can hold. */
function drawableEnd(day: number): boolean {
  return day <= MAX_DAY && day - (MAX_WEEKS + 1) * 7 >= -MAX_DAY;
}

/** Each day's total, keyed by day number. Exported for tests. */
export function dayTotals(data: unknown, xKey: string, valueKey: string): Map<number, number> {
  const totals = new Map<number, number>();
  for (const row of rowsOf(data)) {
    const at = toX(field(row, xKey), true);
    const value = finite(field(row, valueKey));
    if (at === null || value === null) continue;
    const day = dayNumber(at);
    totals.set(day, (totals.get(day) ?? 0) + value);
  }
  return totals;
}

/** A count's shade step: 0 for none, else 1–4 by its share of the busiest day. Exported for tests. */
export function contributionLevel(value: number, high: number): number {
  if (!(value > 0) || !(high > 0)) return 0;
  return Math.max(1, Math.min(GRID_LEVELS - 1, Math.ceil((value / high) * (GRID_LEVELS - 1))));
}

function KitContributionGrid({
  data,
  x,
  value,
  end,
  weeks,
  weekStart,
  color,
  unit,
  "aria-label": ariaLabel,
  height,
  formatValue,
  loading,
  empty,
  className,
  ...rest
}: PluginContributionGridProps) {
  const root = pickRootProps(rest);
  const { label, classes } = chartProps(height, ariaLabel, className);
  const given = positive(height, 600);
  const [measure, width] = useWidth();
  const span = Math.floor(positive(weeks, MAX_WEEKS) ?? DEFAULT_WEEKS) || DEFAULT_WEEKS;
  const preferred = given
    ? Math.max(MIN_PITCH, Math.min(28, Math.floor((given - MONTH_ROW_PX) / 7)))
    : DEFAULT_PITCH;
  // Cells shrink to fit every requested week before any week is dropped; only
  // below the smallest legible cell do the oldest weeks give way.
  const pitch =
    width > 0
      ? Math.max(MIN_PITCH, Math.min(preferred, Math.floor((width - WEEKDAY_GUTTER_PX + 3) / span)))
      : preferred;
  const cell = pitch - 3;
  const px = MONTH_ROW_PX + pitch * 7;
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const hue = hueOf(color);
  const noun = str(unit) ?? "";
  const startDay = weekStart === 1 ? 1 : 0;
  const totals = useMemo(() => dayTotals(data, str(x) ?? "", str(value) ?? ""), [data, x, value]);
  const endAt = toX(end, true);
  const lastDay = useMemo(() => {
    let latest = endAt === null ? -Infinity : dayNumber(endAt);
    if (endAt === null) for (const day of totals.keys()) latest = Math.max(latest, day);
    // The whole calendar, back to its first week, must be dates a Date can hold.
    return latest !== -Infinity && drawableEnd(latest) ? latest : dayNumber(Date.now());
  }, [endAt, totals]);
  const lastColumn = lastDay - ((weekdayOf(lastDay) - startDay + 7) % 7);
  const fitting = width > 0 ? Math.floor((width - WEEKDAY_GUTTER_PX + 3) / pitch) : span;
  const shown = Math.max(1, Math.min(span, fitting));
  const firstDay = lastColumn - (shown - 1) * 7;
  const dayAt = (index: number) => firstDay + index;
  const cursor = useGridCursor(shown, 7, (index) => dayAt(index) <= lastDay);

  const stats = useMemo(() => {
    let high = 0;
    let total = 0;
    let best: number | null = null;
    for (let day = lastColumn - (span - 1) * 7; day <= lastDay; day++) {
      const count = totals.get(day) ?? 0;
      total += count;
      if (count > high) {
        high = count;
        best = day;
      }
    }
    return { high, total, best };
  }, [totals, lastColumn, lastDay, span]);

  // The calendar as a table: a row per week, a column per weekday, the way it
  // is drawn. A year is 53 rows, well inside what a reader can walk.
  const table = useMemo<TableModel>(() => {
    const firstWeek = lastColumn - (span - 1) * 7;
    const first = DAY_DATE_FORMAT.format(firstWeek * DAY);
    const busiest =
      stats.best === null
        ? ""
        : ` The most was ${formats.full(stats.high)} on ${DAY_FORMAT.format(stats.best * DAY)}.`;
    const summary = `${span} weeks from ${first} to ${DAY_DATE_FORMAT.format(lastDay * DAY)}: ${formats.full(stats.total)}${noun ? ` ${noun}` : ""} in all.${busiest}`;
    const weekdays = Array.from({ length: 7 }, (_, row) => {
      const weekday = (startDay + row) % 7;
      return { key: `d${weekday}`, label: WEEKDAY_FORMAT.format(((weekday + 3) % 7) * DAY) };
    });
    return {
      xLabel: "Week of",
      series: weekdays,
      omitted: [],
      rows:
        span > MAX_TABLE_ROWS
          ? null
          : Array.from({ length: span }, (_, week) => {
              const start = firstWeek + week * 7;
              return {
                key: String(start),
                x: DAY_DATE_FORMAT.format(start * DAY),
                values: weekdays.map((_, row) =>
                  start + row > lastDay ? NO_VALUE : formats.full(totals.get(start + row) ?? 0)
                ),
              };
            }),
      summary,
    };
  }, [lastColumn, lastDay, span, stats, formats, noun, startDay, totals]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  // An empty calendar is still a calendar; only an author's own empty state replaces it.
  if (totals.size === 0 && hasContent(empty)) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const shadeOf = (count: number) => {
    const level = contributionLevel(count, stats.high);
    return level === 0 ? null : rampColor(hue, level / (GRID_LEVELS - 1));
  };
  const active = cursor.index;
  let readout: Readout | null = null;
  if (active !== null && dayAt(active) <= lastDay) {
    const day = dayAt(active);
    const count = totals.get(day) ?? 0;
    readout = {
      title: DAY_FORMAT.format(day * DAY),
      rows: [
        {
          key: "count",
          label: noun,
          color: shadeOf(count) ?? "var(--theme-overlay-emphasis, transparent)",
          value: formats.full(count),
        },
      ],
      x: WEEKDAY_GUTTER_PX + Math.floor(active / 7) * pitch + cell / 2,
      y: MONTH_ROW_PX + (active % 7) * pitch + pitch,
      clear: cell / 2,
      swatch: "bar",
    };
  }

  const months: { col: number; text: string }[] = [];
  for (let col = 0; col < shown; col++) {
    const start = firstDay + col * 7;
    const month = new Date(start * DAY).getUTCMonth();
    const previous = col === 0 ? null : new Date((start - 7) * DAY).getUTCMonth();
    if (previous !== month) {
      // A label too close to the next one is dropped rather than overlapped.
      const last = months[months.length - 1];
      if (last && col - last.col < 3) months.pop();
      months.push({ col, text: MONTH_FORMAT.format(start * DAY) });
    }
  }

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={<RampLegend hue={hue} low="Less" high="More" steps={GRID_LEVELS} />}
      table={table}
      cursor={cursor}
      readout={readout}
      measure={measure}
      width={width}
      onPointerMove={(px0, py0) => {
        const col = Math.floor((px0 - WEEKDAY_GUTTER_PX) / pitch);
        const row = Math.floor((py0 - MONTH_ROW_PX) / pitch);
        const index = col * 7 + row;
        cursor.point(
          col >= 0 && col < shown && row >= 0 && row < 7 && dayAt(index) <= lastDay ? index : null
        );
      }}
    >
      <svg
        width={WEEKDAY_GUTTER_PX + shown * pitch}
        height={px}
        className="block overflow-visible"
        aria-hidden="true"
      >
        <g>
          {months.map((month) => (
            <text
              key={month.col}
              x={WEEKDAY_GUTTER_PX + month.col * pitch}
              y={11}
              fontSize={AXIS_FONT_PX}
              className="fill-text-secondary"
            >
              {month.text}
            </text>
          ))}
          {Array.from({ length: 7 }, (_, row) => {
            const weekday = (startDay + row) % 7;
            if (weekday !== 1 && weekday !== 3 && weekday !== 5) return null;
            return (
              <text
                key={row}
                x={0}
                y={MONTH_ROW_PX + row * pitch + cell / 2}
                dy="0.32em"
                fontSize={AXIS_FONT_PX}
                className="fill-text-secondary"
              >
                {WEEKDAY_FORMAT.format(((weekday + 3) % 7) * DAY)}
              </text>
            );
          })}
        </g>
        <g>
          {Array.from({ length: shown * 7 }, (_, index) => {
            const day = dayAt(index);
            if (day > lastDay) return null;
            const fill = shadeOf(totals.get(day) ?? 0);
            return (
              <rect
                key={day}
                data-chart-day={day}
                x={WEEKDAY_GUTTER_PX + Math.floor(index / 7) * pitch + 0.5}
                y={MONTH_ROW_PX + (index % 7) * pitch + 0.5}
                width={cell - 1}
                height={cell - 1}
                rx={2}
                strokeWidth={fill === null ? undefined : 1}
                // A day with activity carries a contour in the full hue, so the
                // faintest level still reads as a mark against an empty day.
                className={fill === null ? "fill-overlay-emphasis" : undefined}
                style={fill === null ? undefined : { fill, stroke: hue }}
              />
            );
          })}
        </g>
        {active !== null && dayAt(active) <= lastDay ? (
          <rect
            data-chart-active=""
            x={WEEKDAY_GUTTER_PX + Math.floor(active / 7) * pitch - 1}
            y={MONTH_ROW_PX + (active % 7) * pitch - 1}
            width={cell + 2}
            height={cell + 2}
            rx={3}
            fill="none"
            strokeWidth={2}
            className="stroke-text-primary"
          />
        ) : null}
      </svg>
    </AxisChartFrame>
  );
}

// A scatter's series must be told apart at any pair, not just neighbours, and
// the categorical palette holds that only for its first three slots.
export const MAX_SCATTER_SERIES = 3;
const MARKERS: readonly MarkerShape[] = ["circle", "square", "triangle"];
const MARKER_R = 4;
// The pointer finds the nearest point within this reach: an 8px marker is a
// poor target on its own.
const POINT_REACH_PX = 24;

interface ScatterPoint {
  row: number;
  series: number;
  x: number;
  y: number;
}

function KitScatterChart({
  data,
  x,
  series,
  pointLabel,
  xType,
  formatX,
  xLabel,
  "aria-label": ariaLabel,
  height,
  formatValue,
  loading,
  empty,
  className,
  ...rest
}: PluginScatterChartProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const [measure, width] = useWidth();
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const { drawn, omitted } = useMemo(() => {
    const all = chartSeries(series);
    const kept = all.drawn.slice(0, MAX_SCATTER_SERIES).map((entry, index) => ({
      ...entry,
      marker: MARKERS[index]!,
    }));
    const dropped = all.drawn
      .slice(MAX_SCATTER_SERIES)
      .map(({ key, label: name }) => ({ key, label: name }));
    return { drawn: kept, omitted: [...dropped, ...all.omitted] };
  }, [series]);

  const model = useMemo(() => {
    const xKey = str(x) ?? "";
    const rows = rowsOf(data);
    const first = rows[0] ? field(rows[0], xKey) : undefined;
    const time =
      oneOf(xType, ["number", "time"] as const) === "time" ||
      (xType === undefined && (first instanceof Date || typeof first === "string"));
    const named = str(pointLabel);
    const kept = rows
      .map((row) => ({ row, at: toX(field(row, xKey), time) }))
      .filter((entry): entry is { row: object; at: number } => entry.at !== null)
      .sort((a, b) => a.at - b.at);
    const xs = kept.map((entry) => entry.at);
    const ordered = kept.map((entry) => entry.row);
    const values = columnsOf(ordered, drawn);
    const points: ScatterPoint[] = [];
    values.forEach((column, s) =>
      column.forEach((y, row) => {
        if (y !== null) points.push({ row, series: s, x: xs[row]!, y });
      })
    );
    points.sort((a, b) => a.x - b.x || a.y - b.y);
    const names = ordered.map((row) => {
      const name = named ? field(row, named) : undefined;
      return typeof name === "string" || typeof name === "number" ? String(name) : null;
    });
    return { time, xs, values, hidden: columnsOf(ordered, omitted), points, names };
  }, [data, x, xType, pointLabel, drawn, omitted]);

  const { time, xs, values, hidden, points, names } = model;
  const cursor = useCursor(points.length);
  const formatPoint = useMemo(
    () =>
      userFormat<number>(formatX, (at) =>
        time
          ? (xs.length > 1 && xs[xs.length - 1]! - xs[0]! < 2 * DAY
              ? TIME_POINT_FORMAT
              : DATE_POINT_FORMAT
            ).format(at)
          : FULL.format(at)
      ),
    [formatX, time, xs]
  );

  const geometry = useMemo(() => {
    if (width <= 0 || points.length === 0) return null;
    let low = Infinity;
    let high = -Infinity;
    for (const point of points) {
      low = Math.min(low, point.y);
      high = Math.max(high, point.y);
    }
    const top = TOP_PAD + MARKER_R;
    const plotH = Math.max(1, px - top - X_AXIS_PX);
    const ticks = axisTicks(low, high, plotH, Y_TICK_SPACING);
    const left = axisWidth(ticks.map(formats.axis), 72);
    const right = 12;
    const plotW = Math.max(1, width - left - right);
    const x0 = xs[0]!;
    const x1 = xs[xs.length - 1]!;
    let xTicks: { at: number; text: string }[];
    let d0 = x0;
    let d1 = x1;
    if (time) {
      const { ticks: stamps, unit } = timeTicks(
        x0,
        x1,
        Math.max(2, Math.floor(plotW / X_TICK_SPACING))
      );
      const axisFormat = userFormat<number>(formatX, (at) => TIME_AXIS_FORMATS[unit].format(at));
      xTicks = stamps.map((stamp) => ({ at: stamp, text: axisFormat(stamp) }));
    } else {
      const nice = axisTicks(x0, x1, plotW, X_TICK_SPACING);
      d0 = nice[0]!;
      d1 = nice[nice.length - 1]!;
      const axisFormat = userFormat<number>(formatX, (at) => COMPACT.format(at));
      xTicks = nice.map((tick) => ({ at: tick, text: axisFormat(tick) }));
    }
    // Inset by a marker so a point on the scale's end is drawn whole.
    const sx = linear(d0, d1, left + MARKER_R, left + plotW - MARKER_R);
    const sy = linear(ticks[0]!, ticks[ticks.length - 1]!, top + plotH, top);
    return {
      ticks,
      sy,
      left,
      top,
      plotW,
      plotH,
      // Formatted with units, ticks can outgrow their spacing; none may collide.
      xTicks: withoutOverlaps(
        xTicks.map((tick) => ({ at: sx(tick.at), text: tick.text })),
        left,
        left + plotW
      ),
      placed: points.map((point) => ({ ...point, px: sx(point.x), py: sy(point.y) })),
    };
  }, [points, xs, time, width, px, formats, formatX]);

  const table = useMemo<TableModel>(() => {
    const all = [...values, ...hidden];
    const named = [...drawn, ...omitted];
    const big = xs.length > MAX_TABLE_ROWS;
    return {
      xLabel: str(xLabel) ?? (time ? "Time" : "X"),
      series: named,
      omitted,
      cap: MAX_SCATTER_SERIES,
      rows: big
        ? null
        : xs.map((at, index) => ({
            key: String(index),
            x: names[index] ? `${names[index]} (${formatPoint(at)})` : formatPoint(at),
            values: cellTexts(all, index, formats.full),
          })),
      summary: big
        ? summarise(
            xs.length,
            formatPoint(xs[0] ?? 0),
            formatPoint(xs[xs.length - 1] ?? 0),
            named,
            all,
            formats.full
          )
        : "",
    };
  }, [values, hidden, drawn, omitted, xs, names, xLabel, time, formatPoint, formats]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (points.length === 0) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  const focus = geometry && active !== null ? geometry.placed[active] : undefined;
  let readout: Readout | null = null;
  if (geometry && focus) {
    const entry = drawn[focus.series]!;
    const name = names[focus.row];
    const xText = `${str(xLabel) ?? (time ? "Time" : "x")} ${formatPoint(focus.x)}`;
    readout = {
      title: name ? `${name} · ${xText}` : xText,
      rows: [
        {
          key: entry.key,
          label: entry.label,
          color: entry.color,
          marker: entry.marker,
          value: formats.full(focus.y),
        },
      ],
      x: focus.px,
      y: Math.max(0, focus.py - 12),
      clear: MARKER_R + 2,
      swatch: "point",
    };
  }

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={<Legend series={drawn} omitted={omitted.length} shape="point" />}
      table={table}
      cursor={cursor}
      readout={readout}
      measure={measure}
      width={width}
      onPointerMove={(px0, py0) => {
        if (!geometry) return;
        let best = -1;
        let bestDistance = POINT_REACH_PX * POINT_REACH_PX;
        geometry.placed.forEach((point, index) => {
          const distance = (point.px - px0) ** 2 + (point.py - py0) ** 2;
          if (distance <= bestDistance) {
            bestDistance = distance;
            best = index;
          }
        });
        cursor.point(best === -1 ? null : best);
      }}
    >
      {geometry ? (
        <svg width={width} height={px} className="block overflow-visible" aria-hidden="true">
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
          {drawn.map((entry, s) => (
            <g key={entry.key} style={{ color: entry.color }} data-chart-series={entry.key}>
              {geometry.placed.map((point, index) =>
                point.series === s ? (
                  <path
                    key={index}
                    data-chart-point=""
                    d={markerPath(entry.marker, point.px, point.py, MARKER_R)}
                    fill="currentColor"
                    fillOpacity={0.8}
                    // The surface ring keeps overlapping markers apart.
                    strokeWidth={1}
                    style={{ stroke: "var(--theme-surface-panel)" }}
                  />
                ) : null
              )}
            </g>
          ))}
          {focus ? (
            <path
              data-chart-active=""
              d={markerPath(drawn[focus.series]!.marker, focus.px, focus.py, MARKER_R + 2)}
              strokeWidth={2}
              style={{ fill: drawn[focus.series]!.color, stroke: "var(--theme-surface-panel)" }}
            />
          ) : null}
        </svg>
      ) : null}
    </AxisChartFrame>
  );
}

/**
 * Round bin edges covering `values`, about `target` bins, and each bin's
 * count. The last bin holds its upper edge. Exported for tests.
 */
export function histogramBins(
  values: readonly number[],
  target: number
): { edges: number[]; counts: number[] } {
  if (values.length === 0) return { edges: [], counts: [] };
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  let edges: number[];
  if (low === high) {
    // One value: a bin around it wide enough to tell its edges apart.
    const half = Math.max(0.5, Math.abs(low) * 1e-6);
    edges = [low - half, low + half];
  } else {
    // Round edges about `target` of them; coarser while rounding overshoots the cap.
    const cap = Math.max(1, Math.min(MAX_BINS, Math.round(target * 1.25)));
    let asked = target;
    edges = axisTicksFor(low, high, asked);
    while (edges.length - 1 > cap && asked > 1) {
      asked = Math.max(1, Math.floor(asked * 0.75));
      edges = axisTicksFor(low, high, asked);
    }
  }
  if (edges.length < 2 || !(edges[edges.length - 1]! > edges[0]!)) edges = [low, high];
  const counts = new Array<number>(edges.length - 1).fill(0);
  for (const value of values) {
    let bin = counts.length - 1;
    for (let i = 1; i < edges.length; i++) {
      if (value < edges[i]!) {
        bin = i - 1;
        break;
      }
    }
    counts[Math.max(0, bin)]! += 1;
  }
  return { edges, counts };
}

function axisTicksFor(low: number, high: number, target: number): number[] {
  // niceTicks asks for about `target` steps; axisTicks would hold out for three.
  return niceTicks(low, high, Math.max(1, target));
}

const MAX_BINS = 40;
const BIN_PX = 24;

function KitHistogram({
  data,
  value,
  bins,
  color,
  countLabel,
  "aria-label": ariaLabel,
  height,
  formatValue,
  loading,
  empty,
  className,
  ...rest
}: PluginHistogramProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const [measure, width] = useWidth();
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const fill = hueOf(color);
  const counted = str(countLabel) ?? "Count";
  const values = useMemo(() => {
    const key = str(value) ?? "";
    return rowsOf(data)
      .map((row) => finite(field(row, key)))
      .filter((entry): entry is number => entry !== null);
  }, [data, value]);
  const asked = positive(bins, MAX_BINS);
  const target = asked
    ? Math.round(asked)
    : Math.max(5, Math.min(MAX_BINS, Math.floor((width || 480) / BIN_PX)));
  const { edges, counts } = useMemo(() => histogramBins(values, target), [values, target]);
  const cursor = useCursor(counts.length);

  const geometry = useMemo(() => {
    if (width <= 0 || counts.length === 0) return null;
    const high = counts.reduce((most, count) => Math.max(most, count), 0);
    const top = TOP_PAD;
    const plotH = Math.max(1, px - top - X_AXIS_PX);
    const ticks = axisTicks(0, Math.max(1, high), plotH, Y_TICK_SPACING);
    const left = axisWidth(
      ticks.map((tick) => COMPACT.format(tick)),
      72
    );
    const right = 8;
    const plotW = Math.max(1, width - left - right);
    const band = plotW / counts.length;
    const gap = band >= 8 ? GAP_PX : band >= 3 ? 1 : 0;
    const sy = linear(ticks[0]!, ticks[ticks.length - 1]!, top + plotH, top);
    const zero = sy(0);
    const bars = counts.map((count, index) => {
      const y = sy(count);
      return count > 0
        ? barPath(left + index * band + gap / 2, y, Math.max(0.5, band - gap), zero - y, "top")
        : "";
    });
    const longest = edges.reduce((most, edge) => Math.max(most, formats.axis(edge).length), 0);
    const every = Math.max(1, Math.ceil((longest * 6.2 + 12) / band));
    const xTicks = withoutOverlaps(
      edges
        .map((edge, index) => ({ index, at: left + index * band, text: formats.axis(edge) }))
        // Every `every`th edge, and always the last, so the range's end is named.
        .filter((tick) => tick.index % every === 0 || tick.index === edges.length - 1),
      left,
      left + plotW
    );
    return { ticks, sy, left, top, plotW, plotH, band, bars, xTicks };
  }, [width, counts, edges, px, formats]);

  const range = (index: number) =>
    `${formats.full(edges[index] ?? 0)} – ${formats.full(edges[index + 1] ?? 0)}`;

  const table = useMemo<TableModel>(
    () => ({
      xLabel: "Range",
      series: [{ key: "count", label: counted }],
      omitted: [],
      rows:
        counts.length > MAX_TABLE_ROWS
          ? null
          : counts.map((count, index) => ({
              key: String(index),
              x: `${formats.full(edges[index] ?? 0)} – ${formats.full(edges[index + 1] ?? 0)}`,
              values: [count.toLocaleString()],
            })),
      summary: `${values.length} values in ${counts.length} bins.`,
    }),
    [counts, edges, formats, counted, values.length]
  );

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (values.length === 0) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  const readout: Readout | null =
    geometry && active !== null
      ? {
          title: range(active),
          rows: [
            {
              key: "count",
              label: counted,
              color: fill,
              value: (counts[active] ?? 0).toLocaleString(),
            },
          ],
          x: geometry.left + (active + 0.5) * geometry.band,
          y: geometry.top,
          clear: geometry.band / 2,
          swatch: "bar",
        }
      : null;

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={null}
      table={table}
      cursor={cursor}
      readout={readout}
      measure={measure}
      width={width}
      onPointerMove={(px0) => {
        if (!geometry) return;
        const index = Math.floor((px0 - geometry.left) / geometry.band);
        cursor.point(index >= 0 && index < counts.length ? index : null);
      }}
    >
      {geometry ? (
        <svg width={width} height={px} className="block overflow-visible" aria-hidden="true">
          {active !== null ? (
            <rect
              data-chart-band=""
              className="fill-overlay-subtle"
              x={geometry.left + active * geometry.band}
              y={geometry.top}
              width={geometry.band}
              height={geometry.plotH}
            />
          ) : null}
          <ValueGrid
            ticks={geometry.ticks}
            scale={geometry.sy}
            orientation="vertical"
            from={geometry.left}
            to={geometry.left + geometry.plotW}
            format={(tick) => COMPACT.format(tick)}
          />
          <g>
            {geometry.bars.map((d, index) =>
              d ? <path key={index} d={d} data-chart-bar="" style={{ fill }} /> : null
            )}
          </g>
          <g>
            {geometry.xTicks.map((tick) => (
              <text
                key={tick.index}
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
        </svg>
      ) : null}
    </AxisChartFrame>
  );
}

/**
 * Each series' lower and upper edge at every x, piled in series order. A gap
 * or a negative counts as zero; `normalize` scales each x's pile to 100.
 * Exported for tests.
 */
export function stackLayers(
  values: readonly (readonly (number | null)[])[],
  normalize: boolean
): { lower: number[][]; upper: number[][]; totals: number[] } {
  const count = values[0]?.length ?? 0;
  const totals = Array.from({ length: count }, (_, index) =>
    values.reduce((sum, column) => sum + Math.max(0, column[index] ?? 0), 0)
  );
  const lower: number[][] = [];
  const upper: number[][] = [];
  const base = new Array<number>(count).fill(0);
  for (const column of values) {
    const from = [...base];
    for (let index = 0; index < count; index++) {
      const amount = Math.max(0, column[index] ?? 0);
      const total = totals[index]!;
      base[index]! += normalize ? (total > 0 ? (amount / total) * 100 : 0) : amount;
    }
    lower.push(from);
    upper.push([...base]);
  }
  return { lower, upper, totals };
}

const SINGLE_SAMPLE_PX = 16;

function KitStackedAreaChart({
  data,
  x,
  series,
  xType,
  normalize,
  formatX,
  xLabel,
  "aria-label": ariaLabel,
  height,
  formatValue,
  loading,
  empty,
  className,
  ...rest
}: PluginStackedAreaChartProps) {
  const root = pickRootProps(rest);
  const { px, label, classes } = chartProps(height, ariaLabel, className);
  const [measure, width] = useWidth();
  const { drawn: resolved, omitted } = useMemo(() => chartSeries(series), [series]);
  const formats = useMemo(() => valueFormats(formatValue), [formatValue]);
  const shares = normalize === true;

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
    if (points.some((point, index) => index > 0 && point.x < points[index - 1]!.x)) {
      points.sort((a, b) => a.x - b.x);
    }
    const ordered = points.map((point) => point.row);
    const values = columnsOf(ordered, resolved);
    return {
      time,
      xs: points.map((point) => point.x),
      values,
      hidden: columnsOf(ordered, omitted),
      stack: stackLayers(values, shares),
    };
  }, [data, x, xType, resolved, omitted, shares]);

  const { time, xs, values, hidden, stack } = model;
  const cursor = useCursor(xs.length);
  const formatPoint = useMemo(
    () =>
      userFormat<number>(formatX, (at) =>
        time
          ? (xs.length > 1 && xs[xs.length - 1]! - xs[0]! < 2 * DAY
              ? TIME_POINT_FORMAT
              : DATE_POINT_FORMAT
            ).format(at)
          : FULL.format(at)
      ),
    [formatX, time, xs]
  );
  const axisValue = useMemo(
    () => (shares ? (tick: number) => `${Math.round(tick)}%` : formats.axis),
    [shares, formats]
  );

  const geometry = useMemo(() => {
    if (width <= 0 || xs.length === 0 || resolved.length === 0) return null;
    const high = shares ? 100 : stack.totals.reduce((most, total) => Math.max(most, total), 0);
    const top = TOP_PAD;
    const plotH = Math.max(1, px - top - X_AXIS_PX);
    const ticks = shares ? [0, 25, 50, 75, 100] : axisTicks(0, high, plotH, Y_TICK_SPACING);
    const left = axisWidth(ticks.map(axisValue), 72);
    const right = 8;
    const plotW = Math.max(1, width - left - right);
    const x0 = xs[0]!;
    const x1 = xs[xs.length - 1]!;
    const sx = linear(x0, x1, left, left + plotW);
    const sy = linear(ticks[0]!, ticks[ticks.length - 1]!, top + plotH, top);
    const pixels = xs.map(sx);
    let xTicks: { at: number; text: string }[];
    if (time) {
      const { ticks: stamps, unit } = timeTicks(
        x0,
        x1,
        Math.max(2, Math.floor(plotW / X_TICK_SPACING))
      );
      const axisFormat = userFormat<number>(formatX, (at) => TIME_AXIS_FORMATS[unit].format(at));
      xTicks = stamps.map((stamp) => ({ at: sx(stamp), text: axisFormat(stamp) }));
    } else {
      const axisFormat = userFormat<number>(formatX, (at) => COMPACT.format(at));
      xTicks =
        x0 === x1
          ? [{ at: sx(x0), text: axisFormat(x0) }]
          : axisTicks(x0, x1, plotW, X_TICK_SPACING)
              .filter((tick) => tick >= x0 && tick <= x1)
              .map((tick) => ({ at: sx(tick), text: axisFormat(tick) }));
    }
    // Straight segments only: smoothing each edge on its own lets a layer's
    // lower edge cross its upper one, drawing area where the value is zero.
    const trace = (points: [number, number][]) => linearPath(points);
    const layers = resolved.map((entry, s) => {
      const upper = stack.upper[s]!.map((v, i): [number, number] => [pixels[i]!, sy(v)]);
      const lower = stack.lower[s]!.map((v, i): [number, number] => [pixels[i]!, sy(v)]);
      if (xs.length === 1) {
        // One sample has no span to fill: each layer is a short column segment.
        const [x0, top0] = upper[0]!;
        const bottom0 = lower[0]![1];
        const half = SINGLE_SAMPLE_PX / 2;
        return {
          key: entry.key,
          color: entry.color,
          area: `M${fixed(x0 - half)},${fixed(top0)}H${fixed(x0 + half)}V${fixed(bottom0)}H${fixed(x0 - half)}Z`,
          edge: `M${fixed(x0 - half)},${fixed(top0)}H${fixed(x0 + half)}`,
        };
      }
      const edge = trace(upper);
      const back = trace([...lower].reverse()).replace(/^M/, "L");
      return { key: entry.key, color: entry.color, area: `${edge}${back}Z`, edge };
    });
    return {
      ticks,
      sy,
      left,
      top,
      plotW,
      plotH,
      pixels,
      xTicks: withoutOverlaps(xTicks, left, left + plotW),
      layers,
    };
  }, [time, xs, stack, resolved, width, px, shares, axisValue, formatX]);

  const table = useMemo<TableModel>(() => {
    const all = [...values, ...hidden];
    const named = [...resolved, ...omitted];
    const big = xs.length > MAX_TABLE_ROWS;
    return {
      xLabel: str(xLabel) ?? (time ? "Time" : "X"),
      series: named,
      omitted,
      rows: big
        ? null
        : xs.map((at, index) => ({
            key: String(index),
            x: formatPoint(at),
            values: cellTexts(all, index, formats.full),
          })),
      summary: big
        ? summarise(
            xs.length,
            formatPoint(xs[0] ?? 0),
            formatPoint(xs[xs.length - 1] ?? 0),
            named,
            all,
            formats.full
          )
        : "",
    };
  }, [values, hidden, resolved, omitted, xs, xLabel, time, formatPoint, formats]);

  if (loading === true) return <ChartLoading height={px} className={classes} root={root} />;
  if (xs.length === 0 || resolved.length === 0 || values.every((c) => c.every((v) => v === null))) {
    return <ChartEmpty label={label} height={px} empty={empty} className={classes} root={root} />;
  }

  const active = cursor.index;
  let readout: Readout | null = null;
  let focus: { x: number; dots: { key: string; color: string; y: number }[] } | null = null;
  if (geometry && active !== null) {
    const at = geometry.pixels[active] ?? 0;
    const total = stack.totals[active] ?? 0;
    // Top of the pile first, as the eye meets the layers.
    const rows: ReadoutRow[] = readoutRows(resolved, values, active, formats.full)
      .map((row, s) => {
        const amount = Math.max(0, values[s]?.[active] ?? 0);
        return shares && total > 0
          ? { ...row, value: `${Math.round((amount / total) * 100)}%` }
          : row;
      })
      .reverse();
    focus = {
      x: at,
      dots: resolved.map((entry, s) => ({
        key: entry.key,
        color: entry.color,
        y: geometry.sy(stack.upper[s]![active]!),
      })),
    };
    readout = {
      title: `${formatPoint(xs[active] ?? 0)} · Total ${formats.full(total)}`,
      rows,
      x: at,
      y: geometry.top,
      swatch: "bar",
    };
  }

  return (
    <AxisChartFrame
      root={root}
      className={classes}
      label={label}
      height={px}
      legend={<Legend series={resolved} omitted={omitted.length} shape="bar" />}
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
          <ValueGrid
            ticks={geometry.ticks}
            scale={geometry.sy}
            orientation="vertical"
            from={geometry.left}
            to={geometry.left + geometry.plotW}
            format={axisValue}
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
          {geometry.layers.map((layer) => (
            <g key={layer.key} style={{ color: layer.color }} data-chart-series={layer.key}>
              <path d={layer.area} fill="currentColor" fillOpacity={0.85} />
            </g>
          ))}
          {/* The surface gap between layers, drawn over every fill so no
              layer's edge is painted over by the one above it. */}
          <g aria-hidden="true">
            {geometry.layers.map((layer) => (
              <path
                key={layer.key}
                d={layer.edge}
                fill="none"
                strokeWidth={GAP_PX}
                strokeLinejoin="round"
                style={{ stroke: "var(--theme-surface-panel)" }}
              />
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

type GaugeTone = "neutral" | "warning" | "danger";

/** The tone a gauge reading takes against its thresholds. Exported for tests. */
export function gaugeTone(reading: number, thresholds: unknown): GaugeTone {
  if (typeof thresholds !== "object" || thresholds === null) return "neutral";
  const below = field(thresholds, "direction") === "below";
  const reached = (key: string) => {
    const at = finite(field(thresholds, key));
    return at !== null && (below ? reading <= at : reading >= at);
  };
  if (reached("danger")) return "danger";
  if (reached("warning")) return "warning";
  return "neutral";
}

const TONE_COLOR: Record<Exclude<GaugeTone, "neutral">, string> = {
  warning: "var(--theme-status-warning)",
  danger: "var(--theme-status-danger)",
};

// A 240° sweep: the open quarter at the bottom holds the range's ends.
const SWEEP = (Math.PI * 4) / 3;
const DEFAULT_GAUGE_PX = 160;
// The smallest gauge whose figure, label and range ends do not collide.
const MIN_GAUGE_PX = 96;

/** The gauge's scale: the given ends when they make a drawable range, else 0–100. Exported for tests. */
export function gaugeRange(low: number, high: number): [number, number] {
  if (high > low && Number.isFinite(high - low) && high - low > 0) {
    const span = high - low;
    // Each end must still differ from the other once scaled across the arc.
    if (low + span / 1000 !== low || high - span / 1000 !== high) return [low, high];
  }
  return [0, 100];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = gaugePoint(cx, cy, r, a0);
  const [x1, y1] = gaugePoint(cx, cy, r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${fixed(x0)},${fixed(y0)}A${fixed(r)},${fixed(r)} 0 ${large} 1 ${fixed(x1)},${fixed(y1)}`;
}

function gaugePoint(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

function KitGauge({
  value,
  min,
  max,
  "aria-label": ariaLabel,
  label,
  target,
  thresholds,
  color,
  formatValue,
  size,
  loading,
  className,
  ...rest
}: PluginGaugeProps) {
  const root = pickRootProps(rest);
  const describedBy = useId();
  // A range whose ends a double cannot tell apart has no scale: fall back to 0–100.
  const [low, high] = gaugeRange(finite(min) ?? 0, finite(max) ?? 100);
  // A value that is missing says so; one outside the range keeps its number
  // and only its arc stops at the end.
  const raw = finite(value);
  const reading = Math.min(high, Math.max(low, raw ?? low));
  const percentScale = low === 0 && high === 100;
  const format = userFormat<number>(formatValue, (amount) =>
    percentScale ? `${Math.round(amount)}%` : FULL.format(amount)
  );
  const tone = raw === null ? "neutral" : gaugeTone(raw, thresholds);
  const width = Math.max(MIN_GAUGE_PX, Math.round(positive(size, 600) ?? DEFAULT_GAUGE_PX));
  const thickness = Math.max(6, Math.round(width * 0.075));
  const r = width / 2 - thickness / 2 - 1;
  const cx = width / 2;
  const cy = r + thickness / 2 + 1;
  const svgHeight = Math.ceil(cy + r * Math.cos(Math.PI - SWEEP / 2) + thickness / 2 + 2);
  const start = -SWEEP / 2;
  const angleOf = (amount: number) => start + ((amount - low) / (high - low)) * SWEEP;
  const goal = finite(target);
  const fill = tone === "neutral" ? hueOf(color) : TONE_COLOR[tone];
  const text = raw === null ? NO_VALUE : format(raw);
  const glyph = tone === "neutral" ? null : severityGlyph(tone, "h-3.5 w-3.5");

  if (loading === true) {
    return <ChartLoading height={svgHeight} className={str(className)} root={root} />;
  }

  return (
    <div
      {...root}
      role="meter"
      aria-label={str(ariaLabel) ?? ""}
      aria-valuemin={low}
      aria-valuemax={high}
      aria-valuenow={reading}
      aria-valuetext={tone === "neutral" ? text : `${text}, ${tone}`}
      data-unavailable={raw === null ? "" : undefined}
      aria-describedby={goal !== null ? describedBy : undefined}
      data-tone={tone}
      className={cn("relative inline-flex shrink-0 flex-col items-center", str(className))}
      style={{ width }}
    >
      <svg width={width} height={svgHeight} className="block" aria-hidden="true">
        <path
          d={arc(cx, cy, r, start, start + SWEEP)}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          className="stroke-overlay-emphasis"
        />
        {raw !== null && reading > low ? (
          <path
            data-chart-gauge-value=""
            d={arc(cx, cy, r, start, angleOf(reading))}
            fill="none"
            strokeWidth={thickness}
            strokeLinecap="round"
            style={{ stroke: fill }}
          />
        ) : null}
        {goal !== null && goal >= low && goal <= high ? (
          <line
            data-chart-gauge-target=""
            x1={gaugePoint(cx, cy, r - thickness / 2 - 2, angleOf(goal))[0]}
            y1={gaugePoint(cx, cy, r - thickness / 2 - 2, angleOf(goal))[1]}
            x2={gaugePoint(cx, cy, r + thickness / 2 + 2, angleOf(goal))[0]}
            y2={gaugePoint(cx, cy, r + thickness / 2 + 2, angleOf(goal))[1]}
            strokeWidth={2}
            strokeLinecap="round"
            className="stroke-text-primary"
          />
        ) : null}
      </svg>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center text-center"
        style={{ top: cy - (width >= 140 ? 18 : 12) }}
      >
        <span
          className={cn(
            "inline-flex items-center gap-1 font-semibold tabular-nums text-text-primary",
            width >= 140 ? "text-xl" : "text-base"
          )}
        >
          {glyph}
          {raw === null ? "—" : text}
        </span>
        {hasContent(label) ? (
          <span className="max-w-full truncate px-4 text-xs text-text-secondary">
            {node(label)}
          </span>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        className="flex w-full justify-between px-1 text-2xs tabular-nums text-text-secondary"
        style={{ paddingInline: thickness / 2 }}
      >
        <span>{format(low)}</span>
        <span>{format(high)}</span>
      </div>
      {goal !== null ? (
        <span id={describedBy} className="sr-only">
          Target {format(goal)}
        </span>
      ) : null}
    </div>
  );
}

export const pluginKitRichCharts = {
  Heatmap: KitHeatmap,
  ContributionGrid: KitContributionGrid,
  ScatterChart: KitScatterChart,
  Histogram: KitHistogram,
  StackedAreaChart: KitStackedAreaChart,
  Gauge: KitGauge,
};
