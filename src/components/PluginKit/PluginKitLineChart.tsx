import { useId, useMemo } from "react";
import type { PluginLineChartProps } from "@shared/types/plugin-sdk-react";
import { field, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import {
  COLORS,
  chartColor,
  AXIS_CHAR_PX,
  AXIS_FONT_PX,
  X_AXIS_PX,
  TOP_PAD,
  MAX_TABLE_ROWS,
  finite,
  rowsOf,
  chartSeries,
  X_TICK_SPACING,
  Y_TICK_SPACING,
  axisTicks,
  DAY,
  timeTicks,
  TIME_AXIS_FORMATS,
  TIME_POINT_FORMAT,
  DATE_POINT_FORMAT,
  COMPACT,
  FULL,
  type Format,
  userFormat,
  valueFormats,
  decimate,
  fixed,
  linearPath,
  monotonePath,
  axisWidth,
  clip,
  edgeAnchor,
  withoutOverlaps,
  linear,
  chartProps,
  toX,
  nearest,
} from "./kitChartModel";
import {
  useWidth,
  type Readout,
  useCursor,
  Legend,
  ChartLoading,
  ChartEmpty,
  type TableModel,
  summarise,
  cellTexts,
  readoutRows,
  columnsOf,
  AxisChartFrame,
  ValueGrid,
} from "./kitChartFrame";

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

export function KitLineChart({
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
