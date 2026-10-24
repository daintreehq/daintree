import { useId, useMemo } from "react";
import type { PluginDonutChartProps } from "@shared/types/plugin-sdk-react";
import { cn } from "@/lib/utils";
import { field, hasContent, node, nonEmpty, pickRootProps, str } from "./kitProps";
import {
  chartColor,
  pinnedColor,
  slotColors,
  GAP_PX,
  finite,
  rowsOf,
  valueFormats,
  fixed,
  chartProps,
  foldParts,
  share,
} from "./kitChartModel";
import {
  type Readout,
  TOOLTIP_OFFSET,
  PointTooltip,
  readoutText,
  useCursor,
  Swatch,
  ChartLoading,
  ChartEmpty,
} from "./kitChartFrame";

interface DonutPart {
  key: string;
  name: string;
  value: number;
  color: string;
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

export function KitDonutChart({
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
