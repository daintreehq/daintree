import {
  useId,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TOOLTIP_CARD_PADDING } from "@/components/ui/tooltip";
import { field, hasContent, node } from "./kitProps";
import {
  MAX_SERIES,
  AXIS_FONT_PX,
  type NamedSeries,
  type ResolvedSeries,
  finite,
  type Format,
  fixed,
} from "./kitChartModel";

// jsdom and any host without ResizeObserver still get a drawable width.
const FALLBACK_WIDTH = 480;

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
