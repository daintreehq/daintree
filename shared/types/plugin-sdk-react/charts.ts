// Charts and figures: stat cards, sparklines, bar, line, donut, scatter,
// stacked-area and histogram charts, heatmaps, contribution grids, meters,
// segmented bars and gauges.

import type { ReactNode } from "react";
import type {
  PluginAriaRootAttributes,
  PluginDomProps,
  PluginRootAttributes,
  PluginSeverity,
} from "./common.js";

/**
 * Props of `StatCard`: one figure with its sentence-case label, for a
 * dashboard row. The figure stays neutral; a `tone` adds its severity glyph
 * beside the label. `success` is for a recorded result ("All checks passed"),
 * never for "healthy" standing status.
 */
export interface PluginStatCardProps extends PluginDomProps<HTMLDivElement> {
  label: ReactNode;
  /** The figure. Format it yourself (`formatCount`, `formatBytes`, `formatDuration`). */
  value: ReactNode;
  /**
   * The change beside the figure. A number is signed and drawn with an up or
   * down arrow; anything else is shown as given. Neutral either way: whether
   * up is good depends on the figure.
   */
  delta?: ReactNode;
  /**
   * Words a number `delta` with its unit, keeping the card's sign and arrow:
   * it is handed the magnitude (never negative) and returns the text after
   * the sign, so `(n) => n.toFixed(1) + "%"` draws "+12.5%" or "−3.0%".
   * Defaults to the grouped number.
   */
  formatDelta?(magnitude: number): string;
  tone?: PluginSeverity;
  /** One quiet line under the figure: its scope or source. */
  hint?: ReactNode;
  /** How many lines the hint may take before it is cut: a number, or `"wrap"` for all of it. Defaults to 1. */
  hintLines?: number | "wrap";
  /** A unit after the figure ("/mo", "ms"), a step down in size and weight. */
  unit?: ReactNode;
  /** The same figure another way, on its own quieter line ("≈ $13,500/mo"). */
  twin?: ReactNode;
  /** `md` (the default) draws a 20px figure; `lg` a 24px one, for the one or two figures a row leads with. */
  size?: "md" | "lg";
  /**
   * `outline` (the default) is a hairline frame on the surface beneath.
   * `filled` is a recessed tile: an inset fill and a quieter edge, for a row
   * of readings inside a card. On a filled card a `warning`, `error` or
   * `danger` tone also draws the edge in its status colour; the figure stays
   * neutral either way.
   */
  variant?: "outline" | "filled";
  /** Below the hint: a `Sparkline` or a `Meter`, say. */
  children?: ReactNode;
  className?: string;
}

/**
 * Props of `Figure`: one figure set as type rather than as a card: the
 * answer at the top of a page, or a lead figure in a card. Digits are
 * tabular and lining, so a figure that updates never jitters. The figure
 * never truncates; it wraps.
 */
export interface PluginFigureProps extends PluginDomProps<HTMLDivElement> {
  /** The figure. Format it yourself (`formatCount`, `Intl.NumberFormat`). */
  value: ReactNode;
  /** A unit after the figure ("/mo", "%"), a step down in size, regular weight and secondary colour. */
  unit?: ReactNode;
  /** The same figure another way, on its own line under it in secondary text ("≈ $13,500/mo"). */
  twin?: ReactNode;
  /** A sentence-case label above the figure. */
  label?: ReactNode;
  /** A quiet line under the figure (and its twin): its scope or basis ("today's money, after tax"). */
  caption?: ReactNode;
  /**
   * `display` steps 36/48/60px with the container's width and is for the one
   * answer a page leads with. `xl` is 30px, `lg` (the default) 24px, `md` 20px.
   */
  size?: "display" | "xl" | "lg" | "md";
  /** Sets the figure in the host's monospace face with slightly tightened tracking. */
  mono?: boolean;
  /** The change beside the figure, drawn as `StatCard`'s `delta`: a number is signed with an arrow, anything else is shown as given. */
  delta?: ReactNode;
  /** Words a number `delta`, as `StatCard`'s `formatDelta`. */
  formatDelta?(magnitude: number): string;
  /** `start` (the default) or `end`, for a figure at the trailing edge of a row. */
  align?: "start" | "end";
  className?: string;
}

/**
 * Props of `Sparkline`: a small trend line with no axes, drawn in a theme
 * colour. It fills its container's width. Fewer than two finite values draw
 * an empty box of the same size; a non-finite value is a gap.
 */
export interface PluginSparklineProps extends PluginRootAttributes {
  values: readonly number[];
  /** Required: the trend in words ("Events per second, last 60 s"). Empty hides it from assistive tech. */
  "aria-label": string;
  /** In px. Defaults to 24. */
  height?: number;
  /**
   * `neutral` (the default) draws in the secondary text colour, and so does
   * `success`: a trend is standing status, and green is kept for results that
   * just landed. Never accent.
   */
  tone?: PluginSeverity;
  /** Fixed ends of the scale. Omitted, the values' own range is used. */
  min?: number;
  max?: number;
  className?: string;
}

/**
 * A chart colour. Series take the categorical slots in this fixed order
 * (`blue`, `amber`, `indigo`, `orange`, `violet`, `teal`), read from the
 * theme's `category-*` tokens, so neighbours stay apart under colour-vision
 * deficiency and in the colour-vision themes. Pin one on a series so it keeps
 * its colour when a filter removes the series before it. `neutral` is a quiet
 * grey for a comparison series such as "previous period".
 */
export type PluginChartColor =
  "blue" | "amber" | "indigo" | "orange" | "violet" | "teal" | "neutral";

/** One series of a `BarChart` or `LineChart`: the row key its values live under. */
export interface PluginChartSeries {
  /** The key in each `data` row that holds this series' number. */
  key: string;
  /** Its name in the legend, tooltip and data table. */
  label: string;
  /** Pins the colour. Omitted, the series takes the next slot in the fixed order. */
  color?: PluginChartColor;
}

/** What every kit chart takes. */
export interface PluginChartBaseProps extends PluginRootAttributes {
  /**
   * The rows: one plain object per x position (or per part, for a
   * `DonutChart`). A value that is not a finite number is a gap, never a zero.
   */
  data: readonly Record<string, unknown>[];
  /** Required: what the chart shows ("Builds per day, last 30 days"). */
  "aria-label": string;
  /** The plot's height in px, legend excluded. Defaults to 200. The width fills the container. */
  height?: number;
  /**
   * Formats a value for the axis, tooltip, legend and data table. Omitted,
   * axes read compact (`1.2K`) and the tooltip reads in full (`1,234`).
   */
  formatValue?: (value: number) => string;
  /** Draws the kit's skeleton at the chart's height in place of the chart. */
  loading?: boolean;
  /** Shown when there is nothing to draw. Omitted, a quiet "No data" at the chart's height. */
  empty?: ReactNode;
  className?: string;
}

/**
 * Props of `BarChart`: a value per category, for one or more series, grouped
 * side by side or stacked, drawn upward or across.
 */
export interface PluginBarChartProps extends PluginChartBaseProps {
  /** The key in each row that holds the category ("day", "branch"). */
  x: string;
  /**
   * Up to six series are drawn. Any past the sixth are not: the legend ends
   * with "+N more not shown" and the accessible table still lists them.
   */
  series: readonly PluginChartSeries[];
  /** `grouped` (the default) sets a category's bars side by side; `stacked` piles them. */
  mode?: "grouped" | "stacked";
  /** `vertical` (the default) draws columns; `horizontal` draws bars, for long category names. */
  orientation?: "vertical" | "horizontal";
  /** Formats a category for its axis label, the tooltip and the table. Defaults to `String(value)`. */
  formatX?: (value: unknown) => string;
  /** The category column's header in the accessible data table. Defaults to "Category". */
  xLabel?: string;
  /**
   * Colours the bars by category rather than by series, keyed by the
   * category's formatted name (`formatX`'s output): an allocation chart keeps
   * each class in the colour it wears elsewhere in the view. A category not
   * listed takes the series colour. Applies to a chart with exactly one
   * series; with more it is ignored, since the colour has to tell the series
   * apart. The legend then lists the categories it coloured.
   */
  categoryColors?: Readonly<Record<string, PluginChartColor>>;
}

interface PluginChartOverlayStyle {
  /** A short label drawn on the plot, and read in the accessible table's caption. */
  label?: string;
  /** Defaults to `neutral`. */
  color?: PluginChartColor;
}

/**
 * A labelled rule across a chart: a target or threshold value (`axis: "y"`,
 * the default), or the x where something changed (`axis: "x"`: a number, a
 * `Date`, epoch ms or an ISO string, read like the chart's x values).
 */
export type PluginChartReferenceLine = PluginChartOverlayStyle & {
  /** `dashed` (the default) or `solid`. */
  stroke?: "dashed" | "solid";
} & ({ axis?: "y"; value: number } | { axis: "x"; value: number | string | Date });

/**
 * A labelled shaded range across a chart: a span of x (`axis: "x"`, the
 * default: a period, a phase) or a span of values (`axis: "y"`: a target zone).
 * `from` and `to` may come in either order.
 */
export type PluginChartBand = PluginChartOverlayStyle &
  (
    | { axis?: "x"; from: number | string | Date; to: number | string | Date }
    | { axis: "y"; from: number; to: number }
  );

/**
 * Props of `LineChart`: one or more series over a numeric or time x axis,
 * with an optional area wash.
 */
export interface PluginLineChartProps extends PluginChartBaseProps {
  /** The key in each row that holds x: a number, a `Date`, epoch ms, or an ISO date string. */
  x: string;
  /**
   * Up to six series are drawn. Any past the sixth are not: the legend ends
   * with "+N more not shown" and the accessible table still lists them.
   */
  series: readonly PluginChartSeries[];
  /**
   * `time` reads x as a date and ticks on calendar steps; `number` as a plain
   * number. Omitted, `time` when the first x is a `Date` or a string.
   */
  xType?: "number" | "time";
  /**
   * Fills under the first series with a faint wash of its colour, down to
   * zero. With several series only the first fills; overlapping washes would
   * blend into a colour no line has.
   */
  area?: boolean;
  /** `linear` (the default) joins points straight; `monotone` smooths without overshooting a value. */
  curve?: "linear" | "monotone";
  /** Formats x (a number; epoch ms for `time`) for the axis, tooltip and table. */
  formatX?: (value: number) => string;
  /** The x column's header in the accessible data table. Defaults to "Time" or "X". */
  xLabel?: string;
  /** Labelled rules drawn over the plot, under the lines. */
  referenceLines?: readonly PluginChartReferenceLine[];
  /** Labelled shaded ranges drawn behind the lines. */
  bands?: readonly PluginChartBand[];
  /** Fixed ends of the value axis. Omitted, the axis fits the data (and any reference lines). */
  yDomain?: readonly [number, number];
}

/**
 * Props of `DonutChart`: parts of a whole, with the total (or your own
 * figure) in the centre and a legend that lists every part's value and share.
 */
export interface PluginDonutChartProps extends PluginChartBaseProps {
  /** The key in each row that holds the part's name. */
  x: string;
  /** The key in each row that holds the part's size. Zero, negative and non-finite parts are left out. */
  value: string;
  /** The figure in the centre. Defaults to the formatted total. */
  centerValue?: ReactNode;
  /** A quiet line under the centre figure ("Total files"). */
  centerLabel?: ReactNode;
  /** The name of the part that gathers everything past the fifth. Defaults to "Other". */
  otherLabel?: string;
  /**
   * Pins parts to colours by name, so a part keeps the colour it wears
   * elsewhere in the view. Parts not listed take the remaining slots in the
   * fixed order. A donut whose largest part is over about 90% says more as a
   * `SegmentedBar`.
   */
  colors?: Readonly<Record<string, PluginChartColor>>;
}

/** Where a `Meter` changes tone, as fractions of `max` (0 to 1). */
export interface PluginMeterThresholds {
  /** At or above this fraction the fill turns to the warning colour. */
  warning?: number;
  /** At or above this fraction the fill turns to the danger colour. */
  danger?: number;
}

/**
 * Props of `Meter`: how much of a known limit is used (a quota, a disk, a
 * rate limit). Unlike `ProgressBar` it measures a level rather than a task,
 * and it can change tone: neutral below its `thresholds`, then warning or
 * danger, each with its glyph beside the value so colour is never the only
 * signal. Announced as a `meter`.
 */
export interface PluginMeterProps extends PluginAriaRootAttributes {
  /** The amount used, from 0 to `max`. Values outside that range are clamped. */
  value: number;
  /** The limit. Defaults to 1, so `value` can be a fraction. */
  max?: number;
  /** Required: the accessible name, and the visible label unless `showLabel` is false. */
  label: string;
  /** False drops the visible label and puts the value beside the bar, for a meter inside a row that already names it. Defaults to true. */
  showLabel?: boolean;
  /** The visible and spoken value ("812 of 1,000 requests"). Defaults to the percentage. */
  valueText?: string;
  /** Neutral when omitted. `{ warning: 0.8, danger: 0.95 }` warns at 80% and 95%. */
  thresholds?: PluginMeterThresholds;
  /**
   * Reference marks on the track (a target, a floor), drawn as a short haloed
   * rule that rises above and below the bar. Each mark's label is read with
   * the value.
   */
  marks?: readonly PluginMeterMark[];
  /**
   * `false` hides the value text, for a meter whose figure is drawn
   * elsewhere. The value is still spoken, and a warning or danger glyph stays
   * beside the bar. Defaults to `true`.
   */
  readout?: boolean;
  /** The readout's width (px or a CSS length), so a column of meters lines up. Defaults to its content. */
  readoutWidth?: number | string;
  className?: string;
}

/** A reference mark on a `Meter` or `SegmentedBar` track. */
export interface PluginMeterMark {
  /** Where the mark sits, on the same scale as the meter's `value` (0 to `max`). */
  value: number;
  /** What the mark is ("Essential floor"): its tooltip, and spoken with the value. */
  label: string;
  /** A small head on the mark's top, for the one mark the reading is measured against. */
  head?: boolean;
}

/** One part of a `SegmentedBar`. */
export interface PluginSegmentedBarSegment {
  /** The part's size. Zero, negative and non-finite parts are left out. */
  value: number;
  label: string;
  /** Pins the colour. Omitted, the part takes the next slot in the charts' fixed order. */
  color?: PluginChartColor;
  /** The part's value in words for the legend and assistive tech. Defaults to the formatted value and share. */
  valueText?: string;
}

/**
 * Props of `SegmentedBar`: parts of a whole on one bar, with a legend, for
 * two to six parts where a donut would be mostly one colour. Each part is
 * coloured from the charts' categorical slots and named in the legend, so
 * colour is never the only signal.
 */
export interface PluginSegmentedBarProps extends PluginAriaRootAttributes {
  /**
   * The parts, in drawing order. Up to six are drawn as given; past that the
   * first five stay and the rest gather into one "Other" part, as
   * `DonutChart`'s do.
   */
  segments: readonly PluginSegmentedBarSegment[];
  /** Required: the accessible name, and the visible label unless `showLabel` is false. */
  label: string;
  /** False drops the visible label. Defaults to true. */
  showLabel?: boolean;
  /**
   * The whole the parts are out of. Defaults to their sum; a larger total
   * leaves the rest of the track empty. A total below the parts' sum is
   * ignored, so the bar never overflows and shares never pass 100%.
   */
  total?: number;
  /** Formats a part's value for the legend. Defaults to the grouped number. */
  formatValue?: (value: number) => string;
  /**
   * `true` (the default) lists every part with its value and share under the
   * bar. Without it each part is named only in its tooltip and the accessible
   * name, so turn it off only where the parts are named beside the bar.
   */
  legend?: boolean;
  /** Reference marks on the track, on the scale of `total`. */
  marks?: readonly PluginMeterMark[];
  /** The bar's thickness: `sm` (6px, the default) or `md` (10px). */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Props of `Heatmap`: a value for each pair of two categories (hour by
 * weekday), as cells shaded in one hue from light to dark.
 */
export interface PluginHeatmapProps extends PluginChartBaseProps {
  /** The key in each row that holds the column category ("hour"). */
  x: string;
  /** The key in each row that holds the row category ("weekday"). */
  y: string;
  /** The key in each row that holds the cell's number. */
  value: string;
  /** The column order. Omitted, columns run in the order they first appear. */
  xCategories?: readonly (string | number)[];
  /** The row order, top to bottom. Omitted, rows run in the order they first appear. */
  yCategories?: readonly (string | number)[];
  /** The hue the cells shade in. Defaults to `blue`. */
  color?: PluginChartColor;
  /** Formats a column category. Defaults to `String(value)`. */
  formatX?: (value: unknown) => string;
  /** Formats a row category. Defaults to `String(value)`. */
  formatY?: (value: unknown) => string;
  /** The row header in the accessible data table. Defaults to "Row". */
  yLabel?: string;
}

/**
 * Props of `ContributionGrid`: a calendar of days, a column per week, each
 * day shaded by its count, as on a forge profile.
 */
export interface PluginContributionGridProps extends PluginChartBaseProps {
  /** The key in each row that holds the day: a `Date`, epoch ms, or an ISO date string. */
  x: string;
  /** The key in each row that holds the day's count. Rows on the same day add up. */
  value: string;
  /** The last day shown. Defaults to the latest day in `data`. */
  end?: Date | number | string;
  /** Weeks shown, ending at `end`. Defaults to 53; fewer draw when the width runs out, the newest kept. */
  weeks?: number;
  /** The first day of each week's column: 0 is Sunday (the default), 1 Monday. */
  weekStart?: 0 | 1;
  /** The hue the days shade in. Defaults to `blue`. */
  color?: PluginChartColor;
  /** The thing counted, for the tooltip and table ("commits"). Defaults to none. */
  unit?: string;
}

/**
 * Props of `ScatterChart`: points placed by two numbers, for one to three
 * series, each with its own marker shape.
 */
export interface PluginScatterChartProps extends PluginChartBaseProps {
  /** The key in each row that holds x: a number, a `Date`, epoch ms, or an ISO date string. */
  x: string;
  /**
   * The keys that hold y, one series each. Up to three are drawn: any two
   * points can sit side by side, and past three the hues cannot all be told
   * apart. Further series are listed in the legend and table.
   */
  series: readonly PluginChartSeries[];
  /** The key in each row that names its point in the tooltip ("auth.test.ts"). */
  pointLabel?: string;
  /** As `LineChart`'s. Omitted, `time` when the first x is a `Date` or a string. */
  xType?: "number" | "time";
  /** Formats x (a number; epoch ms for `time`) for the axis, tooltip and table. */
  formatX?: (value: number) => string;
  /** The x column's header in the accessible data table and the tooltip. Defaults to "X". */
  xLabel?: string;
}

/**
 * Props of `Histogram`: how many values fall in each range, as touching
 * columns over a number axis.
 */
export interface PluginHistogramProps extends PluginChartBaseProps {
  /** The key in each row that holds the measured number. */
  value: string;
  /** About how many bins. Defaults to one per 24px of width, at most 40, on round edges. */
  bins?: number;
  /** The columns' colour. Defaults to `blue`. */
  color?: PluginChartColor;
  /** The thing counted, for the tooltip and table ("tests"). Defaults to "Count". */
  countLabel?: string;
}

/**
 * Props of `StackedAreaChart`: series over a number or time axis, piled one
 * on another so the top edge is their total.
 */
export interface PluginStackedAreaChartProps extends PluginChartBaseProps {
  /** As `LineChart`'s. */
  x: string;
  /** Up to six series, stacked bottom to top in this order. */
  series: readonly PluginChartSeries[];
  /** As `LineChart`'s. */
  xType?: "number" | "time";
  /** Stacks each x to 100%, for shares rather than amounts. */
  normalize?: boolean;
  formatX?: (value: number) => string;
  /** The x column's header in the accessible data table. Defaults to "Time" or "X". */
  xLabel?: string;
}

/**
 * When a `Gauge` changes tone. `above` (the default) warns at or above each
 * threshold, for a level where more is worse (load); `below` at or under it,
 * for one where less is worse (coverage).
 */
export interface PluginGaugeThresholds {
  warning?: number;
  danger?: number;
  direction?: "above" | "below";
}

/** Props of `Gauge`: one number against its range, as an arc with the figure inside. */
export interface PluginGaugeProps extends PluginRootAttributes {
  value: number;
  /** Defaults to 0. */
  min?: number;
  /** Defaults to 100. A `max` not above `min` (or ends too close to tell apart) falls back to 0–100. */
  max?: number;
  /** Required: what is measured ("Line coverage"). */
  "aria-label": string;
  /** A quiet line under the figure. Defaults to none. */
  label?: ReactNode;
  /** A tick on the arc at a goal value. */
  target?: number;
  /** Turns the arc to the warning or danger colour, with its glyph by the figure. */
  thresholds?: PluginGaugeThresholds;
  /** The arc's colour below any threshold. Defaults to `blue`. */
  color?: PluginChartColor;
  /** Formats the figure and the spoken value. Defaults to a whole number, or a percent when the range is 0–100. */
  formatValue?: (value: number) => string;
  /** The gauge's width in px, at least 96; its height is a little over half of it. Defaults to 160. */
  size?: number;
  loading?: boolean;
  className?: string;
}
