import { useMemo } from "react";
import type { PluginBarChartProps } from "@shared/types/plugin-sdk-react";
import { field, oneOf, pickRootProps, str } from "./kitProps";
import {
  chartColor,
  pinnedColor,
  GAP_PX,
  AXIS_CHAR_PX,
  AXIS_FONT_PX,
  X_AXIS_PX,
  TOP_PAD,
  MAX_BAR_CATEGORIES,
  MAX_TABLE_ROWS,
  type ResolvedSeries,
  finite,
  rowsOf,
  chartSeries,
  X_TICK_SPACING,
  Y_TICK_SPACING,
  axisTicks,
  userFormat,
  valueFormats,
  type BarEnd,
  barPath,
  axisWidth,
  clip,
  linear,
  chartProps,
} from "./kitChartModel";
import {
  useWidth,
  type Readout,
  useCursor,
  Legend,
  ChartLoading,
  ChartEmpty,
  type TableModel,
  limitNote,
  summarise,
  cellTexts,
  columnsOf,
  readoutRows,
  AxisChartFrame,
  ValueGrid,
} from "./kitChartFrame";

const BAR_MAX_PX = 24;

interface BarRect {
  key: string;
  d: string;
  color: string;
}

export function KitBarChart({
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
