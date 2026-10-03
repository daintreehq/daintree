// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import {
  MAX_SERIES,
  MAX_TABLE_ROWS,
  SERIES_DASHES,
  X_TICK_SPACING,
  axisTicks,
  barPath,
  chartColor,
  decimate,
  donutParts,
  monotonePath,
  niceTicks,
  edgeAnchor,
  resolveSeries,
  timeTicks,
  tooltipLeft,
} from "@/components/PluginKit/PluginKitCharts";

// The setup file's ResizeObserver never reports; charts size from its
// entries, so this one reports a fixed width on observe and on demand.
let reportedWidth = 480;
const observers = new Set<(width: number) => void>();
type ReportCallback = (entries: { contentRect: { width: number } }[]) => void;
class ReportingResizeObserver {
  private readonly callback: ReportCallback;
  private readonly report = (width: number) => this.callback([{ contentRect: { width } }]);
  constructor(callback: ReportCallback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this.report);
    this.report(reportedWidth);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.report);
  }
}

// The first load transforms the whole kit chunk, which outlasts the default
// hook timeout on a busy machine.
beforeAll(async () => {
  await kit.whenPluginUiReady();
  vi.stubGlobal("ResizeObserver", ReportingResizeObserver);
}, 60_000);

afterEach(() => {
  cleanup();
  reportedWidth = 480;
});

function resizeTo(width: number) {
  reportedWidth = width;
  act(() => {
    for (const report of observers) report(width);
  });
}

const BUILDS = [
  { day: "Mon", passed: 12, failed: 1 },
  { day: "Tue", passed: 9, failed: 3 },
  { day: "Wed", passed: 14, failed: 0 },
];
const BUILD_SERIES = [
  { key: "passed", label: "Passed" },
  { key: "failed", label: "Failed" },
];

function plot(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-chart-plot]");
  if (!element) throw new Error("no chart plot");
  return element;
}

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-chart-tooltip]");
}

describe("chart scales and geometry", () => {
  it("ticks on round numbers that cover the data", () => {
    expect(niceTicks(0, 14, 4)).toEqual([0, 5, 10, 15]);
    expect(niceTicks(-3, 12, 5)).toEqual([-4, -2, 0, 2, 4, 6, 8, 10, 12]);
    expect(niceTicks(0.1, 0.34, 3)).toEqual([0.1, 0.2, 0.3, 0.4]);
    // A flat series reads against zero; all zeros still get a scale.
    expect(niceTicks(5, 5, 4)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 0, 4)).toEqual([0, 1]);
  });

  it("falls back to the ends for a span a double cannot step through", () => {
    // The step underflows to zero here, which used to loop forever.
    expect(niceTicks(Number.MIN_VALUE, 2 * Number.MIN_VALUE, 4)).toEqual([
      Number.MIN_VALUE,
      2 * Number.MIN_VALUE,
    ]);
    // And overflows to Infinity here.
    const wide = niceTicks(-1e308, 1e308, 4);
    expect(wide.every(Number.isFinite)).toBe(true);
    expect(wide[0]).toBeLessThanOrEqual(-1e308);
    expect(wide[wide.length - 1]).toBeGreaterThanOrEqual(1e308);
  });

  it("ticks time on calendar steps", () => {
    const start = new Date(2026, 8, 1, 0, 0).getTime();
    const hours = timeTicks(start, start + 6 * 3600_000, 4);
    expect(hours.unit).toBe("minute");
    expect(hours.ticks.map((tick) => new Date(tick).getHours())).toEqual([0, 3, 6]);
    const days = timeTicks(start, new Date(2026, 8, 29).getTime(), 5);
    expect(days.unit).toBe("day");
    for (const tick of days.ticks) expect(new Date(tick).getHours()).toBe(0);
    const months = timeTicks(start, new Date(2027, 8, 1).getTime(), 5);
    expect(months.unit).toBe("month");
    for (const tick of months.ticks) expect(new Date(tick).getDate()).toBe(1);
  });

  it("keeps each pixel column's extremes when it thins a long series", () => {
    const points: [number, number][] = [];
    for (let i = 0; i < 10_000; i++)
      points.push([i / 100, Math.sin(i) * 50 + (i === 5_000 ? 400 : 0)]);
    const thinned = decimate(points);
    expect(thinned.length).toBeLessThanOrEqual(400);
    expect(Math.max(...thinned.map(([, y]) => y))).toBe(Math.max(...points.map(([, y]) => y)));
    expect(thinned[0]).toEqual(points[0]);
    expect(thinned[thinned.length - 1]).toEqual(points[points.length - 1]);
  });

  it("smooths without overshooting a flat stretch", () => {
    const d = monotonePath([
      [0, 10],
      [10, 10],
      [20, 0],
      [30, 0],
    ]);
    expect(d.startsWith("M0.00,10.00C")).toBe(true);
    // Control points of the flat first segment stay on it.
    expect(d).toContain("C3.33,10.00,6.67,10.00,10.00,10.00");
  });

  it("rounds only a bar's data end", () => {
    const up = barPath(0, 0, 20, 50, "top");
    expect(up).toMatch(/^M0\.00,50\.00V4\.00A4\.00/);
    expect(barPath(0, 0, 20, 50, null)).toBe("M0.00,0.00h20.00v50.00h-20.00Z");
    // A bar shorter than the radius rounds only as far as it reaches.
    expect(barPath(0, 0, 20, 2, "top")).toContain("A2.00,2.00");
  });

  it("gives series the fixed slots, around pinned colours, capped", () => {
    const series = resolveSeries([
      { key: "a", label: "A" },
      { key: "b", label: "B", color: "blue" },
      { key: "c", label: "C" },
      { key: "a", label: "Duplicate" },
      { label: "No key" },
      "junk",
    ]);
    expect(series.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
    expect(series[0]?.color).toBe(chartColor("amber"));
    expect(series[1]?.color).toBe(chartColor("blue"));
    expect(series[2]?.color).toBe(chartColor("indigo"));
    expect(chartColor("blue")).toMatch(/^var\(--theme-category-blue, oklch\(/);
    const many = resolveSeries(
      Array.from({ length: MAX_SERIES + 3 }, (_, index) => ({ key: `s${index}`, label: "S" }))
    );
    expect(many).toHaveLength(MAX_SERIES);
    expect(new Set(many.map((entry) => entry.color)).size).toBe(MAX_SERIES);
  });

  it("folds a donut's tail into one neutral part and drops parts that are not sizes", () => {
    const rows = [
      { name: "a", n: 5 },
      { name: "b", n: 0 },
      { name: "c", n: -1 },
      { name: "d", n: "7" },
      ...Array.from({ length: 7 }, (_, index) => ({ name: `p${index}`, n: index + 1 })),
    ];
    const parts = donutParts(rows, "name", "n", "Other");
    expect(parts).toHaveLength(6);
    expect(parts.map((part) => part.name)).toEqual(["a", "p0", "p1", "p2", "p3", "Other"]);
    expect(parts[5]?.value).toBe(5 + 6 + 7);
    expect(parts[5]?.color).toBe(chartColor("neutral"));
  });
});

describe("chart legibility rules", () => {
  const SIX = Array.from({ length: MAX_SERIES }, (_, index) => ({
    key: `s${index}`,
    label: `S${index}`,
  }));
  const SIX_ROWS = [1, 2, 3].map((at) => ({
    at,
    ...Object.fromEntries(SIX.map((entry, index) => [entry.key, at * (index + 1)])),
  }));

  it("tells every drawn line apart by its stroke, in the line, the legend and the tooltip", () => {
    expect(new Set(SERIES_DASHES).size).toBe(MAX_SERIES);
    const { container } = render(
      createElement(kit.LineChart, { data: SIX_ROWS, x: "at", series: SIX, "aria-label": "Six" })
    );
    const strokes = [...container.querySelectorAll("[data-chart-series]")].map(
      (group) => group.querySelector("path[fill='none']")?.getAttribute("stroke-dasharray") ?? null
    );
    // The first series is solid; no two share a stroke, whatever their colour.
    expect(strokes[0]).toBeNull();
    expect(new Set(strokes).size).toBe(MAX_SERIES);
    const legend = screen.getByRole("list", { name: "Legend" });
    const legendDashes = [...legend.querySelectorAll("[data-chart-swatch='line'] line")].map(
      (line) => line.getAttribute("stroke-dasharray")
    );
    expect(legendDashes).toEqual(strokes);
    fireEvent.keyDown(plot(), { key: "Home" });
    const tipDashes = [...tooltip()!.querySelectorAll("[data-chart-swatch='line'] line")].map(
      (line) => line.getAttribute("stroke-dasharray")
    );
    expect(tipDashes).toEqual(strokes);
  });

  it("keys a bar chart's tooltip with squares, a line chart's with strokes", () => {
    render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "B",
      })
    );
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(tooltip()!.querySelectorAll("[data-chart-swatch='bar']")).toHaveLength(2);
    expect(tooltip()!.querySelector("[data-chart-swatch='line']")).toBeNull();
  });

  it("fills only the first series' area when several share the plot", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: SIX_ROWS,
        x: "at",
        series: SIX.slice(0, 3),
        "aria-label": "Area",
        area: true,
      })
    );
    const fills = container.querySelectorAll("[data-chart-series] path[fill='currentColor']");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.closest("[data-chart-series]")?.getAttribute("data-chart-series")).toBe("s0");
  });

  it("says how many series it could not draw, and keeps them in the table", () => {
    const series = Array.from({ length: MAX_SERIES + 2 }, (_, index) => ({
      key: `s${index}`,
      label: `Series ${index}`,
    }));
    const row = Object.fromEntries(series.map((entry, index) => [entry.key, index + 1]));
    const { container } = render(
      createElement(kit.BarChart, {
        data: [{ day: "Mon", ...row }],
        x: "day",
        series,
        "aria-label": "Many",
      })
    );
    expect(container.querySelectorAll("[data-chart-bar]")).toHaveLength(MAX_SERIES);
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(legend.lastElementChild?.textContent).toBe("+2 more not shown");
    const headers = [...container.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers).toContain("Series 6");
    expect(headers).toContain("Series 7");
    const caption = container.querySelector("caption")?.textContent ?? "";
    expect(caption).toContain("Series 6");
    expect(caption).toContain("Series 7");
  });

  it("puts the tooltip right of its anchor, and left only when the right would overflow", () => {
    const width = 600;
    const tip = 150;
    for (let anchor = 0; anchor <= width; anchor += 25) {
      const left = tooltipLeft(anchor, 10, tip, width);
      const fitsRight = anchor + 10 + 12 + tip <= width;
      // Inside the chart, and clear of the anchor's mark on whichever side it took.
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + tip).toBeLessThanOrEqual(width);
      if (fitsRight) expect(left).toBeGreaterThan(anchor + 10);
      else expect(left + tip).toBeLessThan(anchor - 10);
    }
  });

  it("keeps a column chart's tooltip at the plot's top, beside the column", () => {
    render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "B",
      })
    );
    fireEvent.keyDown(plot(), { key: "Home" });
    const mondayTop = tooltip()!.style.top;
    const mondayLeft = parseFloat(tooltip()!.style.left);
    // Monday's centre is a sixth of the way across; the tooltip starts past it.
    expect(mondayLeft).toBeGreaterThan(480 / 6);
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    // Tuesday's bars differ in height; the tooltip does not follow them down.
    expect(tooltip()!.style.top).toBe(mondayTop);
  });

  it("spaces value ticks by the pixels available, not a fixed step", () => {
    // A short axis still gets a scale.
    expect(axisTicks(0, 34, 90, X_TICK_SPACING).length).toBeGreaterThanOrEqual(3);
    for (const length of [400, 800, 1164, 1600, 2400]) {
      for (const high of [7, 34, 95, 1234, 0.8, 71]) {
        const ticks = axisTicks(-high / 4, high, length, X_TICK_SPACING);
        expect(ticks.length).toBeGreaterThanOrEqual(3);
        expect(length / (ticks.length - 1)).toBeGreaterThanOrEqual(X_TICK_SPACING * 0.8);
      }
    }
    reportedWidth = 1200;
    const { container } = render(
      createElement(kit.BarChart, {
        data: [34, 27, 19, 8, 5].map((n, index) => ({ reason: `r${index}`, n })),
        x: "reason",
        series: [{ key: "n", label: "Count" }],
        orientation: "horizontal",
        "aria-label": "Reasons",
      })
    );
    const xs = [...container.querySelectorAll("line[data-chart-grid]")].map((line) =>
      Number(line.getAttribute("x1"))
    );
    expect(xs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(X_TICK_SPACING * 0.8);
    }
  });
});

describe("BarChart", () => {
  it("draws bars in theme variables with a legend and an accessible table", () => {
    const { container } = render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "Builds per day",
        "data-testid": "builds",
      })
    );
    expect(screen.getByTestId("builds")).not.toBeNull();
    const chart = screen.getByRole("group", { name: "Builds per day" });
    expect(chart.getAttribute("tabindex")).toBe("0");
    const bars = container.querySelectorAll<SVGPathElement>("[data-chart-bar]");
    // Wednesday's zero draws nothing.
    expect(bars).toHaveLength(5);
    for (const bar of bars) expect(bar.style.fill).toMatch(/^var\(--theme-category-/);
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(legend.textContent).toBe("PassedFailed");
    const table = container.querySelector("table");
    expect(table?.closest(".sr-only")).not.toBeNull();
    expect(table?.querySelector("caption")?.textContent).toBe("Builds per day");
    expect([...(table?.querySelectorAll("tbody tr") ?? [])].map((row) => row.textContent)).toEqual([
      "Mon121",
      "Tue93",
      "Wed140",
    ]);
    expect(chart.getAttribute("aria-describedby")).toBe(table?.parentElement?.id);
    expect(container.innerHTML).not.toMatch(/accent/);
  });

  it("walks the categories with the arrow keys and anchors the tooltip to the bar", () => {
    render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "Builds",
        formatValue: (value: number) => `${value} builds`,
      })
    );
    expect(tooltip()).toBeNull();
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toBe("Mon12 buildsPassed1 buildsFailed");
    fireEvent.keyDown(plot(), { key: "End" });
    expect(tooltip()?.textContent).toContain("Wed");
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Wed: Passed 14 builds, Failed 0 builds"
    );
    expect(document.querySelector("[data-chart-band]")).not.toBeNull();
    fireEvent.keyDown(plot(), { key: "Escape" });
    expect(tooltip()).toBeNull();
    fireEvent.keyDown(plot(), { key: "ArrowLeft" });
    expect(tooltip()?.textContent).toContain("Wed");
    fireEvent.blur(plot());
    expect(tooltip()).toBeNull();
  });

  it("stacks with one rounded end per side of zero", () => {
    const { container } = render(
      createElement(kit.BarChart, {
        data: [{ day: "Mon", a: 5, b: 3, c: -2 }],
        x: "day",
        series: [
          { key: "a", label: "A" },
          { key: "b", label: "B" },
          { key: "c", label: "C" },
        ],
        mode: "stacked",
        orientation: "horizontal",
        "aria-label": "Stack",
      })
    );
    const paths = [...container.querySelectorAll("[data-chart-bar]")].map(
      (bar) => bar.getAttribute("d") ?? ""
    );
    expect(paths).toHaveLength(3);
    expect(paths.filter((d) => d.includes("A"))).toHaveLength(2);
    expect(paths[0]).not.toContain("A");
  });

  it("fills its container's width and redraws on resize", () => {
    const { container } = render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "Builds",
        height: 150,
      })
    );
    const svg = () => container.querySelector("svg");
    expect(svg()?.getAttribute("width")).toBe("480");
    expect(svg()?.getAttribute("height")).toBe("150");
    resizeTo(300);
    expect(svg()?.getAttribute("width")).toBe("300");
  });

  // jsdom does no layout, so the rule is structural: an author's empty node lands in
  // the very frame the default "No data" does — the chart's height, centred both ways
  // — and only the default's own type rides on that frame.
  it.each([
    [
      "BarChart",
      (extra: object) =>
        createElement(kit.BarChart, {
          x: "day",
          series: BUILD_SERIES,
          data: [],
          "aria-label": "E",
          height: 140,
          ...extra,
        }),
    ],
    [
      "LineChart",
      (extra: object) =>
        createElement(kit.LineChart, {
          x: "at",
          series: [{ key: "p50", label: "p50" }],
          data: [],
          "aria-label": "E",
          height: 140,
          ...extra,
        }),
    ],
    [
      "DonutChart",
      (extra: object) =>
        createElement(kit.DonutChart, {
          x: "name",
          value: "size",
          data: [],
          "aria-label": "E",
          height: 140,
          ...extra,
        }),
    ],
  ] as const)("centres a custom empty node in the default's frame (%s)", (_, chart) => {
    const frameOf = (extra: object) => {
      render(chart(extra));
      const frame = screen.getByRole("group", { name: "E" });
      const snapshot = {
        height: frame.style.height,
        classes: frame.className.split(/\s+/).filter(Boolean),
        firstChild: frame.firstElementChild,
      };
      cleanup();
      return snapshot;
    };
    const fallback = frameOf({});
    const custom = frameOf({ empty: createElement("p", { "data-own": "" }, "No builds yet") });
    expect(custom.height).toBe(fallback.height);
    expect(custom.height).toBe("140px");
    for (const layout of ["flex", "items-center", "justify-center"]) {
      expect(fallback.classes).toContain(layout);
      expect(custom.classes).toContain(layout);
    }
    expect(custom.firstChild?.hasAttribute("data-own")).toBe(true);
    // The frame styles the default's words, never the author's node.
    expect(custom.classes.some((c) => c.startsWith("text-"))).toBe(false);
  });

  it("shows loading and empty states and survives bad props", () => {
    const { container } = render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "Builds",
        loading: true,
        height: 120,
      })
    );
    expect(screen.getByRole("status", { name: "Loading chart" })).not.toBeNull();
    expect(container.querySelector<HTMLElement>("[data-skeleton-bone]")?.style.height).toBe(
      "120px"
    );
    cleanup();
    render(
      createElement(kit.BarChart, { data: [], x: "day", series: BUILD_SERIES, "aria-label": "B" })
    );
    expect(screen.getByRole("group", { name: "B" }).textContent).toBe("No data");
    cleanup();
    render(
      createElement(kit.BarChart, {
        data: [],
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "B",
        empty: createElement("p", null, "No builds yet"),
      })
    );
    expect(screen.getByText("No builds yet")).not.toBeNull();
    cleanup();
    const untyped = {
      data: "nope",
      x: 4,
      series: { key: "a" },
      "aria-label": 7,
      mode: "sideways",
      orientation: 1,
      height: -5,
      formatValue: "x",
      formatX: () => 5,
    };
    // @ts-expect-error the untyped shape a JavaScript view can send
    expect(() => render(createElement(kit.BarChart, untyped))).not.toThrow();
    cleanup();
    const odd = {
      data: [null, 3, { day: "Mon", passed: "12" }, { day: "Tue", passed: 4 }],
      x: "day",
      series: [{ key: "passed", label: "Passed", color: "red" }],
      "aria-label": "Odd",
      formatX: () => 5,
      formatValue: () => null,
    };
    // @ts-expect-error the untyped shape a JavaScript view can send
    const { container: oddChart } = render(createElement(kit.BarChart, odd));
    expect(oddChart.querySelectorAll("[data-chart-bar]")).toHaveLength(1);
    expect(oddChart.querySelector("tbody")?.textContent).toBe("MonNo valueTue4");
  });

  it("summarises instead of tabulating past the table cap", () => {
    const data = Array.from({ length: MAX_TABLE_ROWS + 1 }, (_, index) => ({
      name: `c${index}`,
      n: index,
    }));
    const { container } = render(
      createElement(kit.BarChart, {
        data,
        x: "name",
        series: [{ key: "n", label: "Count" }],
        "aria-label": "Many",
      })
    );
    expect(container.querySelector("table")).toBeNull();
    const summary = container.querySelector("p.sr-only");
    expect(summary?.textContent).toBe(
      `${MAX_TABLE_ROWS + 1} points from c0 to c250. Count: 0 to 250.`
    );
    // One series needs no legend: the chart's label names it.
    expect(screen.queryByRole("list", { name: "Legend" })).toBeNull();
  });

  it("colours a lone series' bars by category, in the bars, the legend and the tooltip", () => {
    const data = [
      { kind: "equity", now: 60 },
      { kind: "bonds", now: 30 },
      { kind: "cash", now: 10 },
    ];
    const { container } = render(
      createElement(kit.BarChart, {
        data,
        x: "kind",
        series: [{ key: "now", label: "Now" }],
        "aria-label": "Allocation",
        formatX: (value: unknown) => String(value).toUpperCase(),
        // Keyed by the formatted name; "cash" is left to the series colour.
        // @ts-expect-error a colour the charts do not know, as untyped JS can send
        categoryColors: { EQUITY: "teal", BONDS: "violet", equity: "orange", CASH: "pink" },
      })
    );
    const fills = [...container.querySelectorAll<SVGPathElement>("[data-chart-bar]")].map(
      (bar) => bar.style.fill
    );
    expect(fills).toEqual([chartColor("teal"), chartColor("violet"), chartColor("blue")]);
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(legend.textContent).toBe("EQUITYBONDSNow");
    expect(
      [...legend.querySelectorAll<HTMLElement>("[data-chart-swatch]")].map(
        (swatch) => swatch.style.backgroundColor
      )
    ).toEqual([chartColor("teal"), chartColor("violet"), chartColor("blue")]);
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(
      tooltip()!.querySelector<HTMLElement>("[data-chart-swatch]")?.style.backgroundColor
    ).toBe(chartColor("teal"));
  });

  it("names even one coloured category, and the series only where a bar still wears it", () => {
    render(
      createElement(kit.BarChart, {
        data: [
          { kind: "Equity", now: 60 },
          { kind: "Cash", now: 0 },
        ],
        x: "kind",
        series: [{ key: "now", label: "Now" }],
        "aria-label": "One pinned",
        categoryColors: { Equity: "teal" },
      })
    );
    // Cash draws no bar, so nothing on the plot wears the series colour.
    expect(screen.getByRole("list", { name: "Legend" }).textContent).toBe("Equity");
  });

  it("ignores category colours when several series need the hue to tell apart", () => {
    const { container } = render(
      createElement(kit.BarChart, {
        data: BUILDS,
        x: "day",
        series: BUILD_SERIES,
        "aria-label": "Builds",
        categoryColors: { Mon: "teal", Tue: "teal", Wed: "teal" },
      })
    );
    const fills = new Set(
      [...container.querySelectorAll<SVGPathElement>("[data-chart-bar]")].map(
        (bar) => bar.style.fill
      )
    );
    expect(fills).toEqual(new Set([chartColor("blue"), chartColor("amber")]));
    expect(screen.getByRole("list", { name: "Legend" }).textContent).toBe("PassedFailed");
  });
});

describe("LineChart", () => {
  const SERIES = [
    { key: "p50", label: "p50" },
    { key: "p95", label: "p95", color: "neutral" as const },
  ];

  it("draws a line per series, sorted by x, with a gap for a missing value", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: [
          { at: 3, p50: 30, p95: 90 },
          { at: 1, p50: 10, p95: 50 },
          { at: 2, p50: null, p95: 70 },
          { at: 4, p50: 40, p95: 95 },
        ],
        x: "at",
        series: SERIES,
        "aria-label": "Latency",
        area: true,
      })
    );
    const lines = container.querySelectorAll<SVGGElement>("[data-chart-series]");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.style.color).toBe("var(--theme-category-slate, var(--theme-text-secondary))");
    // p50 breaks at x=2: a lone first point is a dot, the rest a path.
    expect(lines[0]?.querySelectorAll("circle")).toHaveLength(1);
    expect(lines[0]?.querySelectorAll("path")).toHaveLength(2);
    expect([...container.querySelectorAll("tbody th")].map((cell) => cell.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(container.querySelector("tbody")?.textContent).toContain("No value");
  });

  it("moves a crosshair across points with the keyboard", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: [
          { at: 1, p50: 10, p95: 50 },
          { at: 2, p50: 20, p95: 60 },
        ],
        x: "at",
        series: SERIES,
        "aria-label": "Latency",
        curve: "monotone",
        formatX: (value: number) => `t${value}`,
      })
    );
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(
      container.querySelector("[data-chart-crosshair]")?.querySelectorAll("circle")
    ).toHaveLength(2);
    expect(tooltip()?.textContent).toBe("t110p5050p95");
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toBe("t220p5060p95");
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toBe("t220p5060p95");
  });

  it("keeps the edge tick labels inside the plot rather than under the value axis", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: Array.from({ length: 11 }, (_, index) => ({ at: index * 10, v: index })),
        x: "at",
        series: [{ key: "v", label: "Value" }],
        "aria-label": "Values",
        formatX: (value: number) => `Sep ${value}`,
      })
    );
    const ticks = [...container.querySelectorAll("[data-chart-x-tick]")];
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks[0]?.getAttribute("text-anchor")).toBe("start");
    expect(ticks[1]?.getAttribute("text-anchor")).toBe("middle");
    expect(edgeAnchor({ at: 100, text: "Sep 30" }, 0, 100)).toBe("end");
    expect(edgeAnchor({ at: 50, text: "Sep 30" }, 0, 100)).toBe("middle");
  });

  it("reads dates and ISO strings as time", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: [
          { at: "2026-09-01T00:00:00", n: 1 },
          { at: "2026-09-15T00:00:00", n: 3 },
          { at: "2026-09-29T00:00:00", n: 2 },
        ],
        x: "at",
        series: [{ key: "n", label: "Runs" }],
        "aria-label": "Runs",
      })
    );
    expect(container.querySelector("thead th")?.textContent).toBe("Time");
    expect(container.querySelector("tbody th")?.textContent).toMatch(/2026/);
  });

  it("drops a time x no Date can hold instead of throwing", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: [
          { at: Date.UTC(2026, 8, 1), n: 1 },
          { at: 1e20, n: 5 },
          { at: Date.UTC(2026, 8, 2), n: 2 },
        ],
        x: "at",
        xType: "time",
        series: [{ key: "n", label: "Runs" }],
        "aria-label": "Runs",
      })
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("uses the default label when a plugin formatter throws", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: [
          { at: 1, v: 10 },
          { at: 2, v: 20 },
        ],
        x: "at",
        series: [{ key: "v", label: "V" }],
        "aria-label": "Throws",
        formatValue: () => {
          throw new Error("plugin bug");
        },
        formatX: () => {
          throw new Error("plugin bug");
        },
      })
    );
    expect(container.querySelector("tbody")?.textContent).toBe("110220");
  });

  it("does not rebuild the summary as the cursor moves", () => {
    const data = Array.from({ length: MAX_TABLE_ROWS + 50 }, (_, index) => ({
      at: index,
      v: index,
    }));
    const formatValue = vi.fn((value: number) => `${value}`);
    render(
      createElement(kit.LineChart, {
        data,
        x: "at",
        series: [{ key: "v", label: "V" }],
        "aria-label": "Long",
        formatValue,
      })
    );
    fireEvent.keyDown(plot(), { key: "Home" });
    const before = formatValue.mock.calls.length;
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    // The summary's high (the last value, on no tick and never under the
    // cursor) is formatted once, when the data arrives.
    const high = MAX_TABLE_ROWS + 49;
    const since = formatValue.mock.calls.slice(before).map(([value]) => value);
    expect(since).toContain(2);
    expect(since).not.toContain(high);
  });

  it("thins a long series to about two points per pixel", () => {
    const data = Array.from({ length: 20_000 }, (_, index) => ({ at: index, v: index % 97 }));
    const { container } = render(
      createElement(kit.LineChart, {
        data,
        x: "at",
        series: [{ key: "v", label: "V" }],
        "aria-label": "Long",
      })
    );
    const d = container.querySelector("[data-chart-series] path")?.getAttribute("d") ?? "";
    const commands = d.split(/[ML]/).length - 1;
    expect(commands).toBeLessThan(2_000);
    expect(container.querySelector("table")).toBeNull();
  });

  it("survives bad props", () => {
    const untyped = {
      data: [{ at: "nope", v: 1 }],
      x: "at",
      series: [{ key: "v" }],
      "aria-label": "Bad",
      xType: "weekly",
      curve: "step",
      area: "yes",
    };
    // @ts-expect-error the untyped shape a JavaScript view can send
    expect(() => render(createElement(kit.LineChart, untyped))).not.toThrow();
    expect(screen.getByRole("group", { name: "Bad" }).textContent).toBe("No data");
  });

  const SAVINGS = [
    { year: 2020, saved: 10 },
    { year: 2021, saved: 30 },
    { year: 2022, saved: 45 },
    { year: 2023, saved: 60 },
  ];

  function gridTicks(container: HTMLElement): number[] {
    return [...container.querySelectorAll("[data-chart-grid]")].map((line) =>
      Number(line.getAttribute("data-chart-grid"))
    );
  }

  it("draws labelled reference lines and bands, and names them for assistive tech", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: SAVINGS,
        x: "year",
        series: [{ key: "saved", label: "Saved" }],
        "aria-label": "Savings",
        referenceLines: [
          { value: 200, label: "Goal", color: "amber" },
          { axis: "x", value: 2022, label: "Moved house", stroke: "solid" },
          { axis: "x", value: 1990, label: "Before the data" },
          // @ts-expect-error a y value that is not a number, as untyped JS can send
          { value: "high", label: "Not a number" },
          // @ts-expect-error an axis that does not exist
          { axis: "z", value: 3 },
        ],
        bands: [
          { from: 2021.5, to: 2020.5, label: "Sabbatical" },
          { axis: "y", from: 40, to: 50 },
          { from: 2021, to: 2021 },
        ],
      })
    );
    // The goal sits far above the data and still lands on the axis.
    expect(Math.max(...gridTicks(container))).toBeGreaterThanOrEqual(200);
    const lines = [...container.querySelectorAll<SVGLineElement>("[data-chart-reference-line]")];
    expect(lines.map((line) => line.getAttribute("data-chart-reference-line"))).toEqual(["y", "x"]);
    expect(lines[0]?.getAttribute("stroke-dasharray")).not.toBeNull();
    expect(lines[0]?.style.color).toBe(chartColor("amber"));
    expect(lines[1]?.getAttribute("stroke-dasharray")).toBeNull();
    expect(lines[1]?.style.color).toBe(chartColor("neutral"));
    const bands = [...container.querySelectorAll<SVGRectElement>("[data-chart-reference-band]")];
    expect(bands.map((band) => band.getAttribute("data-chart-reference-band"))).toEqual(["x", "y"]);
    for (const band of bands) {
      expect(band.getAttribute("fill")).toBe("currentColor");
      expect(Number(band.getAttribute("fill-opacity"))).toBeLessThan(0.2);
    }
    // Bands sit behind the rules, and the rules under the series.
    const order = [
      ...container.querySelectorAll(
        "[data-chart-reference-band], [data-chart-reference-line], [data-chart-series]"
      ),
    ].map((element) =>
      element.hasAttribute("data-chart-reference-band")
        ? "band"
        : element.hasAttribute("data-chart-reference-line")
          ? "line"
          : "series"
    );
    expect(order).toEqual(["band", "band", "line", "line", "series"]);
    const labels = [...container.querySelectorAll("[data-chart-annotation-label]")].map(
      (label) => label.textContent
    );
    expect(labels).toEqual(expect.arrayContaining(["Goal", "Moved house", "Sabbatical"]));
    expect(container.querySelector("caption")?.textContent).toBe(
      "Savings. Reference lines: Goal at 200; Moved house at 2,022; Before the data at 1,990. " +
        "Shaded ranges: Sabbatical from 2,020.5 to 2,021.5; Range from 40 to 50"
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  it("reads an x rule like the chart's own x values", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: [
          { at: "2026-01-01", v: 1 },
          { at: "2026-03-01", v: 2 },
        ],
        x: "at",
        series: [{ key: "v", label: "V" }],
        "aria-label": "Dated",
        referenceLines: [
          { axis: "x", value: "2026-02-01", label: "Launch" },
          { axis: "x", value: new Date(2026, 1, 15), label: "Review" },
          { axis: "x", value: "soon", label: "Unreadable" },
        ],
      })
    );
    expect(container.querySelectorAll("[data-chart-reference-line='x']")).toHaveLength(2);
  });

  it("holds a fixed value axis and clips what runs past it", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: SAVINGS,
        x: "year",
        series: [{ key: "saved", label: "Saved" }],
        "aria-label": "Fixed",
        yDomain: [50, 0],
        referenceLines: [{ value: 200, label: "Off the axis" }],
      })
    );
    const ticks = gridTicks(container);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(50);
    // A fixed axis is not widened for a rule; the rule past it is not drawn.
    expect(container.querySelector("[data-chart-reference-line]")).toBeNull();
    const clipped = container.querySelector("[data-chart-series]")?.parentElement;
    const id = clipped?.getAttribute("clip-path")?.match(/^url\(#(.+)\)$/)?.[1];
    expect(id).toBeTruthy();
    expect(container.querySelector(`clipPath[id="${id}"]`)).not.toBeNull();
    cleanup();

    const loose = render(
      createElement(kit.LineChart, {
        data: SAVINGS,
        x: "year",
        series: [{ key: "saved", label: "Saved" }],
        "aria-label": "Loose",
        // @ts-expect-error a domain with equal ends, as untyped JS can send
        yDomain: [5, 5, 5],
      })
    );
    expect(Math.max(...gridTicks(loose.container))).toBeGreaterThanOrEqual(60);
    expect(loose.container.querySelector("clipPath")).toBeNull();
    cleanup();

    // Finer than the ticks round to: the ends stand in rather than no axis at all.
    const fine = render(
      createElement(kit.LineChart, {
        data: SAVINGS,
        x: "year",
        series: [{ key: "saved", label: "Saved" }],
        "aria-label": "Fine",
        yDomain: [1.000000000001, 1.000000000002],
      })
    );
    expect(gridTicks(fine.container)).toEqual([1.000000000001, 1.000000000002]);
  });

  it("keeps y rule labels a line apart where they land, not where their rules do", () => {
    const { container } = render(
      createElement(kit.LineChart, {
        data: SAVINGS,
        x: "year",
        series: [{ key: "saved", label: "Saved" }],
        "aria-label": "Close rules",
        yDomain: [0, 200],
        referenceLines: [
          { value: 200, label: "Cap" },
          { value: 180, label: "Stretch" },
        ],
      })
    );
    const ys = [...container.querySelectorAll("[data-chart-annotation-label]")].map((label) =>
      Number(label.getAttribute("y"))
    );
    for (let i = 1; i < ys.length; i++) {
      expect(Math.abs(ys[i]! - ys[i - 1]!)).toBeGreaterThanOrEqual(12);
    }
    expect(ys.length).toBeGreaterThan(0);
  });
});

describe("DonutChart", () => {
  const LANGS = [
    { lang: "TypeScript", files: 300 },
    { lang: "CSS", files: 100 },
  ];

  it("draws parts with a centre total and a legend of values and shares", () => {
    const { container } = render(
      createElement(kit.DonutChart, {
        data: LANGS,
        x: "lang",
        value: "files",
        "aria-label": "Files by language",
        centerLabel: "files",
      })
    );
    expect(container.querySelectorAll("[data-chart-part]")).toHaveLength(2);
    expect(container.textContent).toContain("400");
    expect(container.textContent).toContain("files");
    const legend = screen.getByRole("list", { name: "Legend" });
    expect([...legend.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "TypeScript30075%",
      "CSS10025%",
    ]);
    expect(
      screen.getByRole("group", { name: "Files by language" }).getAttribute("aria-describedby")
    ).toBe(legend.id);
  });

  it("points the tooltip at a part from the keyboard or the pointer", () => {
    const { container } = render(
      createElement(kit.DonutChart, {
        data: LANGS,
        x: "lang",
        value: "files",
        "aria-label": "Files",
        centerValue: "Two",
      })
    );
    expect(container.textContent).toContain("Two");
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toBe("300TypeScript · 75%");
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toBe("100CSS · 25%");
    fireEvent.blur(plot());
    const parts = container.querySelectorAll("[data-chart-part]");
    fireEvent.pointerEnter(parts[0]!);
    expect(tooltip()?.textContent).toBe("300TypeScript · 75%");
    fireEvent.pointerLeave(plot());
    expect(tooltip()).toBeNull();
  });

  it("draws one whole ring for a single part and survives bad props", () => {
    const { container } = render(
      createElement(kit.DonutChart, {
        data: [{ lang: "Go", files: 3 }],
        x: "lang",
        value: "files",
        "aria-label": "One",
      })
    );
    expect(container.querySelector("[data-chart-part]")?.getAttribute("fill-rule")).toBe("evenodd");
    cleanup();
    const untyped = { data: { a: 1 }, x: null, value: 3, "aria-label": "Bad", otherLabel: 5 };
    // @ts-expect-error the untyped shape a JavaScript view can send
    expect(() => render(createElement(kit.DonutChart, untyped))).not.toThrow();
    expect(screen.getByRole("group", { name: "Bad" }).textContent).toBe("No data");
  });

  it("pins parts to colours by name, and the rest take the free slots", () => {
    const rows = [
      { name: "Stocks", n: 6 },
      { name: "Bonds", n: 3 },
      { name: "Cash", n: 1 },
      { name: "toString", n: 1 },
    ];
    const parts = donutParts(rows, "name", "n", "Other", { Bonds: "blue", Cash: "plaid" });
    // Bonds holds blue, so the first free slot is amber; "toString" is no pin.
    expect(parts.map((part) => part.color)).toEqual([
      chartColor("amber"),
      chartColor("blue"),
      chartColor("indigo"),
      chartColor("orange"),
    ]);
    const many = Array.from({ length: 8 }, (_, index) => ({ name: `p${index}`, n: 1 }));
    const folded = donutParts(many, "name", "n", "Other", { Other: "teal", p7: "teal" });
    expect(folded[5]?.color).toBe(chartColor("neutral"));
    expect(folded.slice(0, 5).map((part) => part.color)).not.toContain(chartColor("teal"));
    cleanup();

    const { container } = render(
      createElement(kit.DonutChart, {
        data: LANGS,
        x: "lang",
        value: "files",
        "aria-label": "Pinned",
        colors: { CSS: "teal" },
      })
    );
    const fills = [...container.querySelectorAll<SVGPathElement>("[data-chart-part]")].map(
      (part) => part.style.fill
    );
    expect(fills).toEqual([chartColor("blue"), chartColor("teal")]);
  });
});
