// @vitest-environment jsdom
import { createElement, createRef, type ComponentType, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import * as kit from "@daintreehq/plugin-ui";
import {
  TerminalOutputCache,
  ansiStyle,
  clampPan,
  markdownHeadings,
  resolveHeadingElements,
} from "@/components/PluginKit/PluginKitRichDisplay";
import {
  MAX_HEATMAP_COLUMNS,
  contributionLevel,
  dayTotals,
  gaugeRange,
  gaugeTone,
  heatmapGrid,
  histogramBins,
  rampColor,
  stackLayers,
} from "@/components/PluginKit/PluginKitRichCharts";
import { withoutOverlaps } from "@/components/PluginKit/PluginKitCharts";
import { PLAIN_STYLE } from "@/components/PluginKit/kitAnsi";

// The setup file's ResizeObserver never reports; charts size from its
// entries, so this one reports a fixed width on observe.
class ReportingResizeObserver {
  constructor(private readonly callback: (entries: unknown[]) => void) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 480 } }]);
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
  await kit.whenPluginUiReady();
}, 60_000);

afterEach(() => {
  cleanup();
  dispatch.mockClear();
});

function mount(element: ReactNode) {
  return render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        VirtuosoMockContext.Provider,
        { value: { viewportHeight: 360, itemHeight: 18 } },
        element
      )
    )
  );
}

function renderLoose<P extends object>(component: ComponentType<P>, loose: object) {
  const props: P = JSON.parse(JSON.stringify(loose));
  return mount(createElement(component, props));
}

const plot = () => {
  const element = document.querySelector<HTMLElement>("[data-chart-plot]");
  if (!element) throw new Error("no chart plot");
  return element;
};
const tooltip = () => document.querySelector<HTMLElement>("[data-chart-tooltip]");

describe("AnsiText", () => {
  it("draws SGR colours in the terminal's theme tokens", () => {
    const { container } = mount(
      createElement(kit.AnsiText, { text: "\x1b[31mFAIL\x1b[0m src/auth.test.ts" })
    );
    const red = Array.from(container.querySelectorAll<HTMLElement>("span[style]")).find(
      (span) => span.textContent === "FAIL"
    );
    expect(red?.style.color).toContain("--theme-terminal-red");
    expect(container.textContent).toBe("FAIL src/auth.test.ts");
  });

  it("keeps line breaks as a block, and collapses rewrites", () => {
    const { container } = mount(
      createElement(kit.AnsiText, { text: "one\r\ntwo 10%\rtwo 100%\n", display: "block" })
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("one\ntwo 100%");
  });

  it("swaps the terminal's own ink and surface for reverse video", () => {
    const style = ansiStyle({ ...PLAIN_STYLE, inverse: true });
    expect(style?.color).toContain("--theme-terminal-background");
    expect(style?.backgroundColor).toContain("--theme-terminal-foreground");
    expect(ansiStyle(PLAIN_STYLE)).toBeUndefined();
  });

  it("always sits on the terminal's own surface, inline or as a block", () => {
    const { container } = mount(
      createElement("div", null, [
        createElement(kit.AnsiText, {
          key: "i",
          text: "\x1b[33mwarn\x1b[0m",
          "data-testid": "inline",
        }),
        createElement(kit.AnsiText, {
          key: "b",
          text: "x",
          display: "block",
          "data-testid": "block",
        }),
      ])
    );
    for (const id of ["inline", "block"]) {
      const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      expect(element.style.backgroundColor).toContain("--theme-terminal-background");
      expect(element.style.color).toContain("--theme-terminal-foreground");
    }
  });

  it("ignores junk props from untyped JS", () => {
    expect(() => renderLoose(kit.AnsiText, { text: 42, display: "huge" })).not.toThrow();
  });
});

describe("TerminalOutput", () => {
  const LOG = [
    "\x1b[1m> vitest run\x1b[0m",
    "\x1b[32m✓\x1b[0m src/a.test.ts \x1b[2m(3 tests)\x1b[22m",
    "\x1b[31m✗\x1b[0m src/b.test.ts",
    "progress 10%\rprogress 100%",
    "docs \x1b]8;;https://vitest.dev\x07vitest.dev\x1b]8;;\x07",
  ].join("\n");

  it("renders each line with its colours as one keyboard-reachable log", () => {
    const { container } = mount(
      createElement(kit.TerminalOutput, {
        text: LOG,
        "aria-label": "Test run",
        title: "npm test",
        // jsdom has no layout to pin the newest line against.
        follow: false,
      })
    );
    const log = screen.getByRole("log", { name: "Test run" });
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.tabIndex).toBe(0);
    const lines = Array.from(container.querySelectorAll("[data-ansi-line]")).map(
      (line) => line.textContent
    );
    expect(lines).toEqual([
      "> vitest run",
      "✓ src/a.test.ts (3 tests)",
      "✗ src/b.test.ts",
      "progress 100%",
      "docs vitest.dev",
    ]);
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("opens an OSC 8 link through the host, never the view", () => {
    mount(
      createElement(kit.TerminalOutput, { text: LOG, "aria-label": "Test run", follow: false })
    );
    const link = screen.getByRole("link", { name: "vitest.dev" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://vitest.dev" },
      { source: "user" }
    );
  });

  it("numbers lines from the first kept, and toggles wrap", () => {
    const onWrapChange = vi.fn();
    const { container } = mount(
      createElement(kit.TerminalOutput, {
        text: "a\nb\nc\nd",
        "aria-label": "Out",
        lineNumbers: true,
        maxLines: 2,
        follow: false,
        onWrapChange,
      })
    );
    const gutters = Array.from(
      container.querySelectorAll<HTMLElement>("[data-ansi-line] > span[aria-hidden]")
    );
    // Quiet ink is the terminal's own foreground mixed toward its background.
    expect(gutters[0]!.style.color).toContain("--theme-terminal-foreground");
    expect(gutters.map((gutter) => gutter.textContent)).toEqual(["3", "4"]);
    const wrap = screen.getByRole("button", { name: "Wrap lines" });
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(wrap);
    expect(onWrapChange).toHaveBeenCalledWith(false);
    expect(wrap.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-ansi-line]")?.className).toContain("whitespace-pre");
  });

  it("says how many earlier lines it no longer keeps", () => {
    mount(
      createElement(kit.TerminalOutput, {
        text: "a\nb\nc\nd",
        "aria-label": "Out",
        maxLines: 2,
        follow: false,
      })
    );
    expect(document.querySelector("[data-terminal-dropped]")?.textContent).toBe(
      "2 earlier lines not kept"
    );
    cleanup();
    mount(createElement(kit.TerminalOutput, { text: "a\nb", "aria-label": "Out", follow: false }));
    expect(document.querySelector("[data-terminal-dropped]")).toBeNull();
  });

  it("says there is no output, and drops the toolbar on request", () => {
    mount(createElement(kit.TerminalOutput, { text: "", "aria-label": "Out", toolbar: false }));
    const log = screen.getByRole("log", { name: "Out" });
    expect(log.textContent).toBe("No output");
    // The same one quiet stop as a log with output in it.
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.tabIndex).toBe(0);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("still says what it dropped when there is no toolbar", () => {
    mount(
      createElement(kit.TerminalOutput, {
        text: "a\nb\nc",
        "aria-label": "Out",
        maxLines: 1,
        toolbar: false,
        follow: false,
      })
    );
    expect(document.querySelector("[data-terminal-dropped]")?.textContent).toBe(
      "2 earlier lines not kept"
    );
  });

  it("parses only the new tail of output that grows", () => {
    const cache = new TerminalOutputCache();
    const first = cache.update("one\ntw", 100);
    expect(first.lines).toHaveLength(2);
    const second = cache.update("one\ntwo\x1b[31m!", 100);
    // The first line object is untouched: it was not parsed again.
    expect(second.lines[0]).toBe(first.lines[0]);
    expect(second.lines[1]!.segments.map((segment) => segment.text)).toEqual(["two", "!"]);
    const reset = cache.update("other", 100);
    expect(reset.lines.map((line) => line.segments[0]?.text)).toEqual(["other"]);
  });
});

describe("HoverCard", () => {
  it("opens on keyboard focus and closes on Escape", async () => {
    mount(
      createElement(kit.HoverCard, {
        content: createElement("p", null, "Ada Lovelace · 214 commits"),
        "aria-label": "Ada Lovelace, 214 commits",
        children: createElement("button", { type: "button" }, "@ada"),
      })
    );
    const trigger = screen.getByRole("button", { name: "@ada" });
    await act(async () => {
      fireEvent.focus(trigger);
    });
    const card = await screen.findByRole("tooltip", { hidden: true }, { timeout: 3000 });
    expect(card.textContent).toContain("Ada Lovelace, 214 commits");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByText("Ada Lovelace · 214 commits")).toBeNull();
  });

  it("stays while its trigger holds keyboard focus, whatever the pointer does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount(
        createElement(kit.HoverCard, {
          content: createElement("p", null, "Grace Hopper"),
          closeDelay: 50,
          children: createElement("button", { type: "button" }, "@grace"),
        })
      );
      const trigger = screen.getByRole("button", { name: "@grace" });
      await act(async () => {
        fireEvent.focus(trigger);
      });
      await screen.findByRole("tooltip", { hidden: true }, { timeout: 3000 });
      const card = screen.getAllByText("Grace Hopper")[0]!.closest("[data-side]")!;
      await act(async () => {
        fireEvent.pointerEnter(trigger);
        fireEvent.pointerLeave(trigger);
        fireEvent.pointerEnter(card);
        fireEvent.pointerLeave(card);
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryAllByText("Grace Hopper").length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.blur(trigger);
      });
      expect(screen.queryAllByText("Grace Hopper")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays open when controlled, on the host's hover-card width", () => {
    mount(
      createElement(kit.HoverCard, {
        open: true,
        content: createElement("p", { "data-testid": "body" }, "Card"),
        children: createElement("button", { type: "button" }, "Trigger"),
      })
    );
    const body = screen.getByTestId("body");
    const surface = body.closest("[data-side]") ?? body.parentElement!.parentElement!;
    expect(surface.className).toContain("w-[304px]");
  });

  it("renders the trigger alone when disabled or empty, nothing for a non-element", () => {
    mount(
      createElement(kit.HoverCard, {
        disabled: true,
        content: "Card",
        children: createElement("button", { type: "button" }, "Plain"),
      })
    );
    expect(screen.getByRole("button", { name: "Plain" })).toBeTruthy();
    cleanup();
    expect(() => renderLoose(kit.HoverCard, { content: "Card", children: "text" })).not.toThrow();
  });
});

describe("ImageViewer", () => {
  const SHOTS = [
    { src: "data:image/png;base64,AAA", alt: "Settings screen", caption: "Light theme" },
    { src: "data:image/png;base64,BBB", alt: "Dark settings screen" },
  ];

  function loadImage(width: number, height: number) {
    const image = document.querySelector<HTMLImageElement>("[data-image-viewer] img");
    if (!image) throw new Error("no image");
    Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: height, configurable: true });
    fireEvent.load(image);
    return image;
  }

  it("shows the picture's size and zoom, and zooms from the toolbar and keys", () => {
    mount(createElement(kit.ImageViewer, { images: SHOTS, defaultZoom: "actual" }));
    loadImage(1280, 800);
    const status = document.querySelector("[data-image-viewer-status]")!;
    expect(status.textContent).toBe("1280 × 800·100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(status.textContent).toContain("125%");
    const stage = screen.getByRole("group", { name: /^Settings screen\./ });
    fireEvent.keyDown(stage, { key: "-" });
    expect(status.textContent).toContain("100%");
    expect(screen.getByText("Light theme")).toBeTruthy();
  });

  it("steps through the set from the toolbar and with Page Down", () => {
    const onIndexChange = vi.fn();
    mount(createElement(kit.ImageViewer, { images: SHOTS, onIndexChange }));
    expect(
      screen.getByRole("button", { name: "Previous image" }).getAttribute("aria-disabled")
    ).toBe("true");
    const stage = screen.getByRole("group", { name: /^Settings screen\./ });
    fireEvent.keyDown(stage, { key: "PageDown" });
    expect(onIndexChange).toHaveBeenCalledWith(1);
    expect(document.querySelector("[data-image-viewer] img")?.getAttribute("alt")).toBe(
      "Dark settings screen"
    );
  });

  it("opens as a modal lightbox and reports its close", async () => {
    const onOpenChange = vi.fn();
    mount(
      createElement(kit.ImageViewer, {
        images: SHOTS,
        mode: "modal",
        open: true,
        title: "Screenshots",
        onOpenChange,
      })
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Screenshots");
    expect(dialog.textContent).toContain("1 of 2");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("starts each picture's caption at its first line", () => {
    const view = (index: number) =>
      createElement(kit.ImageViewer, {
        images: [
          { src: "data:image/png;base64,AA", alt: "One", caption: "First caption" },
          { src: "data:image/png;base64,BB", alt: "Two", caption: "Second caption" },
        ],
        index,
      });
    const { rerender } = mount(view(0));
    const caption = () => document.querySelector<HTMLElement>("[data-image-viewer-caption]")!;
    // jsdom does not scroll; give the caption a scroll position to keep.
    let scrolled = 0;
    Object.defineProperty(caption(), "scrollTop", {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => {
        scrolled = value;
      },
    });
    caption().scrollTop = 40;
    rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 360, itemHeight: 18 } },
          view(1)
        )
      )
    );
    expect(caption().textContent).toBe("Second caption");
    expect(caption().scrollTop).toBe(0);
  });

  it("leaves a caption's own scroll keys to the caption", () => {
    const onIndexChange = vi.fn();
    mount(createElement(kit.ImageViewer, { images: SHOTS, onIndexChange }));
    const caption = document.querySelector<HTMLElement>("[data-image-viewer-caption]")!;
    fireEvent.keyDown(caption, { key: "PageDown" });
    fireEvent.keyDown(caption, { key: "End" });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("never pans a picture past its own edges", () => {
    const natural = { width: 1000, height: 500 };
    const stage = { width: 400, height: 400 };
    expect(clampPan(900, 900, 1, natural, stage)).toEqual({ x: 300, y: 50 });
    expect(clampPan(50, 50, 0.2, natural, stage)).toEqual({ x: 0, y: 0 });
  });

  it("draws nothing for junk images", () => {
    renderLoose(kit.ImageViewer, { images: [{ alt: "no src" }, 7] });
    expect(screen.getByText("No image")).toBeTruthy();
  });
});

describe("charts", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ReportingResizeObserver);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const HOURS = [9, 10, 11];
  const DAYS = ["Mon", "Tue"];
  const BUILDS = DAYS.flatMap((day, d) =>
    HOURS.map((hour, h) => ({ day, hour, minutes: d * 10 + h }))
  );

  it("shades a Heatmap's cells along one ramp, with a readout per cell", () => {
    const { container } = mount(
      createElement(kit.Heatmap, {
        data: BUILDS,
        x: "hour",
        y: "day",
        value: "minutes",
        "aria-label": "Build minutes by hour",
        formatValue: (value: number) => `${value} min`,
      })
    );
    expect(container.querySelectorAll("[data-chart-cell]")).toHaveLength(6);
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toContain("Mon · 9");
    expect(tooltip()?.textContent).toContain("0 min");
    fireEvent.keyDown(plot(), { key: "ArrowDown" });
    expect(tooltip()?.textContent).toContain("Tue · 9");
    expect(container.querySelector("table caption")?.textContent).toBe("Build minutes by hour");
    expect(container.querySelector("[data-chart-ramp]")?.textContent).toBe("0 min12 min");
  });

  it("adds up a Heatmap's repeated pairs and keeps the given order", () => {
    const model = heatmapGrid(
      [
        { x: "b", y: 1, v: 2 },
        { x: "b", y: 1, v: 3 },
        { x: "a", y: 1, v: "junk" },
      ],
      "x",
      "y",
      "v",
      ["a", "b"]
    );
    expect(model.xs.keys).toEqual(["a", "b"]);
    expect(model.grid).toEqual([[null, 5]]);
  });

  it("keeps the faintest ramp shade well clear of the surface, rising to the full hue", () => {
    const share = (t: number) => Number(/ (\d+)%/.exec(rampColor("red", t))![1]);
    // Below about a third, a small value reads as no value at all.
    expect(share(0)).toBeGreaterThanOrEqual(35);
    expect(share(1)).toBe(100);
    expect(share(0.5)).toBeGreaterThan(share(0.25));
  });

  it("draws a missing heatmap pair as an empty outline, not a faint shade", () => {
    const { container } = mount(
      createElement(kit.Heatmap, {
        data: [
          { x: "a", y: "r", v: 0 },
          { x: "b", y: "s", v: 5 },
        ],
        x: "x",
        y: "y",
        value: "v",
        "aria-label": "Sparse",
      })
    );
    const cells = Array.from(container.querySelectorAll<SVGRectElement>("[data-chart-cell]"));
    const hollow = cells.filter((cell) => !cell.style.fill);
    const filled = cells.filter((cell) => cell.style.fill);
    // Two pairs are missing; the zero is a value and is shaded.
    expect(hollow).toHaveLength(2);
    expect(filled).toHaveLength(2);
    for (const cell of hollow) expect(cell.getAttribute("class")).toContain("stroke-");
    // A value's faintest shade still stands off the surface on a full-hue contour.
    for (const cell of filled) expect(cell.style.stroke).toContain("--theme-category-blue");
  });

  it("never lets formatted x labels collide, on the new charts or the line chart", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ x: 200 + i * 175, y: i }));
    const long = (value: number) => `${value.toLocaleString()} lines of code`;
    const extents = (container: Element) =>
      Array.from(container.querySelectorAll<SVGTextElement>("[data-chart-x-tick]")).map((tick) => {
        const at = Number(tick.getAttribute("x"));
        const width = (tick.textContent ?? "").length * 6.2;
        const anchor = tick.getAttribute("text-anchor");
        const start = anchor === "start" ? at : anchor === "end" ? at - width : at - width / 2;
        return [start, start + width] as const;
      });
    for (const component of [kit.ScatterChart, kit.LineChart]) {
      const { container, unmount } = mount(
        createElement(component, {
          data: rows,
          x: "x",
          series: [{ key: "y", label: "Y" }],
          formatX: long,
          "aria-label": "Ticks",
        })
      );
      const spans = extents(container);
      expect(spans.length).toBeGreaterThan(1);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThan(spans[i - 1]![1]);
      unmount();
    }
  });

  it("lays a ContributionGrid out a week a column, ending on the last day", () => {
    const end = new Date(2026, 8, 30);
    const data = [
      { date: end.toISOString(), commits: 4 },
      { date: new Date(2026, 8, 29).getTime(), commits: 1 },
      { date: new Date(2026, 8, 29), commits: 1 },
    ];
    const { container } = mount(
      createElement(kit.ContributionGrid, {
        data,
        x: "date",
        value: "commits",
        weeks: 4,
        unit: "commits",
        "aria-label": "Commits",
      })
    );
    const days = container.querySelectorAll("[data-chart-day]");
    // Three whole weeks and the last one up to Wednesday the 30th.
    expect(days.length).toBe(3 * 7 + 4);
    fireEvent.keyDown(plot(), { key: "End" });
    expect(tooltip()?.textContent).toContain("Sep 30, 2026");
    expect(tooltip()?.textContent).toContain("4commits");
    fireEvent.keyDown(plot(), { key: "ArrowUp" });
    expect(tooltip()?.textContent).toContain("2commits");
    // The table is the calendar as drawn: a row per week, a column per weekday.
    const rows = container.querySelectorAll("table tbody tr");
    expect(rows).toHaveLength(4);
    const last = rows[3]!.querySelectorAll("td");
    // Sunday-first weeks: Tue the 29th and Wed the 30th, then days not yet come.
    expect(Array.from(last).map((cell) => cell.textContent)).toEqual([
      "0",
      "0",
      "2",
      "4",
      "No value",
      "No value",
      "No value",
    ]);
  });

  it("buckets contribution counts by the busiest day", () => {
    expect(contributionLevel(0, 10)).toBe(0);
    expect(contributionLevel(1, 10)).toBe(1);
    expect(contributionLevel(10, 10)).toBe(4);
    const totals = dayTotals(
      [
        { d: "2026-01-02T10:00:00", n: 2 },
        { d: "nope", n: 1 },
      ],
      "d",
      "n"
    );
    expect([...totals.values()]).toEqual([2]);
  });

  it("draws a ScatterChart's series with their own markers, nearest point on hover", () => {
    const { container } = mount(
      createElement(kit.ScatterChart, {
        data: [
          { size: 10, ms: 100, name: "a.test.ts" },
          { size: 40, ms: 300, name: "b.test.ts" },
        ],
        x: "size",
        series: [{ key: "ms", label: "Duration" }],
        pointLabel: "name",
        xLabel: "Size",
        "aria-label": "Duration by size",
      })
    );
    expect(container.querySelectorAll("[data-chart-point]")).toHaveLength(2);
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tooltip()?.textContent).toContain("a.test.ts · Size 10");
    expect(tooltip()?.querySelector("[data-chart-swatch='point']")).not.toBeNull();
  });

  it("caps a ScatterChart at three series and lists the rest", () => {
    const series = ["a", "b", "c", "d"].map((key) => ({ key, label: key.toUpperCase() }));
    const { container } = mount(
      createElement(kit.ScatterChart, {
        data: [{ x: 1, a: 1, b: 2, c: 3, d: 4 }],
        x: "x",
        series,
        "aria-label": "Four",
      })
    );
    expect(container.querySelectorAll("[data-chart-series]")).toHaveLength(3);
    expect(container.querySelector("[data-chart-omitted]")?.textContent).toBe("+1 more not shown");
  });

  it("bins a Histogram on round edges, the top edge in the last bin", () => {
    const { edges, counts } = histogramBins([0, 1, 2, 9, 10], 5);
    expect(edges[0]).toBe(0);
    expect(edges[edges.length - 1]).toBe(10);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(5);
    expect(counts[counts.length - 1]).toBe(2);
    mount(
      createElement(kit.Histogram, {
        data: [0, 1, 2, 9, 10].map((ms) => ({ ms })),
        value: "ms",
        bins: 5,
        countLabel: "Tests",
        "aria-label": "Test durations",
      })
    );
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(tooltip()?.textContent).toMatch(/^0 – 2/);
    expect(tooltip()?.textContent).toContain("Tests");
  });

  it("piles a StackedAreaChart's series, to 100% when normalised", () => {
    const { lower, upper, totals } = stackLayers(
      [
        [1, 2],
        [3, null],
      ],
      false
    );
    expect(lower).toEqual([
      [0, 0],
      [1, 2],
    ]);
    expect(upper).toEqual([
      [1, 2],
      [4, 2],
    ]);
    expect(totals).toEqual([4, 2]);
    expect(stackLayers([[1], [3]], true).upper).toEqual([[25], [100]]);
    const single = mount(
      createElement(kit.StackedAreaChart, {
        data: [{ day: 1, a: 2, b: 3 }],
        x: "day",
        series: [
          { key: "a", label: "A" },
          { key: "b", label: "B" },
        ],
        "aria-label": "First run",
      })
    );
    for (const layer of single.container.querySelectorAll("[data-chart-series] path")) {
      expect(layer.getAttribute("d")).not.toBe("");
    }
    single.unmount();
    mount(
      createElement(kit.StackedAreaChart, {
        data: [
          { day: 1, linux: 10, mac: 5 },
          { day: 2, linux: 12, mac: 8 },
        ],
        x: "day",
        series: [
          { key: "linux", label: "Linux" },
          { key: "mac", label: "macOS" },
        ],
        normalize: true,
        "aria-label": "CI minutes",
      })
    );
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    const text = tooltip()?.textContent ?? "";
    expect(text).toContain("Total 15");
    expect(text.indexOf("macOS")).toBeLessThan(text.indexOf("Linux"));
    expect(text).toContain("67%");
  });

  it("announces a Gauge as a meter and turns tone at its thresholds", () => {
    mount(
      createElement(kit.Gauge, {
        value: 58,
        target: 80,
        thresholds: { warning: 70, danger: 50, direction: "below" },
        label: "Lines",
        "aria-label": "Coverage",
      })
    );
    const meter = screen.getByRole("meter", { name: "Coverage" });
    expect(meter.getAttribute("aria-valuenow")).toBe("58");
    expect(meter.getAttribute("aria-valuetext")).toBe("58%, warning");
    expect(meter.textContent).toContain("Lines");
    expect(gaugeTone(40, { warning: 70, danger: 50, direction: "below" })).toBe("danger");
    cleanup();
    mount(createElement(kit.Gauge, { value: Number.NaN, "aria-label": "Missing" }));
    const missing = screen.getByRole("meter", { name: "Missing" });
    expect(missing.getAttribute("aria-valuetext")).toBe("No value");
    expect(missing.querySelector("[data-chart-gauge-value]")).toBeNull();
    cleanup();
    mount(createElement(kit.Gauge, { value: 140, "aria-label": "Over" }));
    // The arc stops at the end; the number does not pretend to be 100.
    expect(screen.getByRole("meter", { name: "Over" }).getAttribute("aria-valuetext")).toBe("140%");
    expect(gaugeTone(90, { warning: 80 })).toBe("warning");
    expect(gaugeTone(10, null)).toBe("neutral");
    cleanup();
    // Below the smallest size its figure, label and ends fit in, it holds that size.
    mount(createElement(kit.Gauge, { value: 5, size: 48, label: "Lines", "aria-label": "Tiny" }));
    expect(screen.getByRole("meter", { name: "Tiny" }).style.width).toBe("96px");
  });

  it("keeps numeric extremes from hanging or breaking the charts", () => {
    // Tick indices past 2^53 once stalled the shared tick loop.
    expect(histogramBins([1e16, 1e16 + 2], 5).edges.length).toBeGreaterThanOrEqual(2);
    const flat = histogramBins([1e16, 1e16], 5).edges;
    expect(flat[1]! > flat[0]!).toBe(true);
    const many = histogramBins(
      Array.from({ length: 101 }, (_, i) => i),
      40
    );
    expect(many.counts.length).toBeLessThanOrEqual(40);
    expect(gaugeRange(1e16, 0)).toEqual([0, 100]);
    expect(gaugeRange(10, 20)).toEqual([10, 20]);
    const wide = Array.from({ length: MAX_HEATMAP_COLUMNS + 50 }, (_, i) => ({ x: i, y: 0, v: 1 }));
    expect(heatmapGrid(wide, "x", "y", "v").xs.keys).toHaveLength(MAX_HEATMAP_COLUMNS);
    const mixed = heatmapGrid(
      [
        { x: "", y: 0, v: 1 },
        { x: {}, y: 0, v: 5 },
      ],
      "x",
      "y",
      "v"
    );
    expect(mixed.grid).toEqual([[1]]);
  });

  it("keeps the last axis label, displacing every label it would touch", () => {
    const ticks = [
      { at: 0, text: "a" },
      { at: 40, text: "a" },
      { at: 70, text: "a" },
      { at: 100, text: "longer label" },
    ];
    // The last, drawn ending at 100, reaches back past both 70 and 40.
    expect(withoutOverlaps(ticks, 0, 100).map((tick) => tick.at)).toEqual([0, 100]);
  });

  it("names the scatter cap, not the line chart's, in its table caption", () => {
    const series = ["a", "b", "c", "d"].map((key) => ({ key, label: key.toUpperCase() }));
    const { container } = mount(
      createElement(kit.ScatterChart, {
        data: [{ x: 1, a: 1, b: 2, c: 3, d: 4 }],
        x: "x",
        series,
        "aria-label": "Four",
      })
    );
    expect(container.querySelector("table caption")?.textContent).toContain("draws 3 series");
  });

  it("shows the empty state for charts with nothing to draw", () => {
    const empty = {
      data: [],
      x: "x",
      y: "y",
      value: "v",
      series: [{ key: "v", label: "V" }],
      "aria-label": "Empty",
    };
    const mounts = [
      () => renderLoose(kit.Heatmap, empty),
      () => renderLoose(kit.ScatterChart, empty),
      () => renderLoose(kit.Histogram, empty),
      () => renderLoose(kit.StackedAreaChart, empty),
    ];
    for (const draw of mounts) {
      const { unmount } = draw();
      expect(screen.getByText("No data")).toBeTruthy();
      unmount();
    }
  });
});

describe("TableOfContents", () => {
  const DOC = [
    "# Report",
    "intro",
    "## Build",
    "```sh",
    "# not a heading",
    "```",
    "### Cache",
    "Tests",
    "-----",
    "## [Coverage](https://x) `summary`",
  ].join("\n");

  it("reads ATX and setext headings, skipping code", () => {
    expect(markdownHeadings(DOC)).toEqual([
      { text: "Report", level: 1 },
      { text: "Build", level: 2 },
      { text: "Cache", level: 3 },
      { text: "Tests", level: 2 },
      { text: "Coverage summary", level: 2 },
    ]);
  });

  it("reads headings in quotes and lists, keeping code and autolinks literal", () => {
    expect(
      markdownHeadings("> ## Quoted\n- ## Listed\n## `a*b*c` and <https://x.dev>").map(
        (h) => h.text
      )
    ).toEqual(["Quoted", "Listed", "a*b*c and https://x.dev"]);
  });

  it("never matches one drawn heading twice", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>Doc</h1><h2 id='d1'>Details</h2><h2>Details</h2>";
    const found = resolveHeadingElements(root, [
      { text: "Details", level: 2, id: "d1" },
      { text: "Details", level: 2 },
    ]);
    expect(found[0]).toBe(root.querySelector("#d1"));
    expect(found[1]).toBe(root.querySelectorAll("h2")[1]);
  });

  it("matches drawn headings by id, position, then text", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>Report</h1><h2 id='b'>Build</h2><p></p><h2>Tests</h2><h3>Notes</h3>";
    const found = resolveHeadingElements(root, [
      { text: "Build", level: 2, id: "b" },
      { text: "Missing", level: 2 },
      { text: "Tests", level: 2 },
    ]);
    expect(found.map((element) => element?.textContent ?? null)).toEqual(["Build", null, "Tests"]);
  });

  function renderToc(extra: object = {}) {
    const ref = createRef<HTMLDivElement>();
    const scrollTo = vi.fn();
    const utils = mount(
      createElement(
        "div",
        { style: { overflowY: "auto" }, "data-testid": "scroller" },
        createElement(kit.TableOfContents, { markdown: DOC, target: ref, ...extra }),
        createElement(
          "div",
          { ref },
          createElement("h1", null, "Report"),
          createElement("h2", null, "Build"),
          createElement("h3", null, "Cache"),
          createElement("h2", null, "Tests"),
          createElement("h2", null, "Coverage summary")
        )
      )
    );
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTo = scrollTo;
    return { ...utils, scrollTo };
  }

  it("lists headings to the depth asked, marks the current one and scrolls on click", async () => {
    const onNavigate = vi.fn();
    const { scrollTo } = renderToc({ onNavigate });
    const nav = screen.getByRole("navigation", { name: "Table of contents" });
    expect(nav.textContent).toContain("On this page");
    const entries = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent);
    expect(entries).toEqual(["Report", "Build", "Cache", "Tests", "Coverage summary"]);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(scrollTo).toHaveBeenCalled();
    // The reader is taken to the section, focus included.
    expect(document.activeElement?.textContent).toBe("Tests");
    expect(document.activeElement?.tagName).toBe("H2");
    expect(onNavigate).toHaveBeenCalledWith({ text: "Tests", level: 2, id: undefined }, 3);
    expect(screen.getByRole("button", { name: "Tests" }).getAttribute("aria-current")).toBe(
      "location"
    );
  });

  it("folds a section from the keyboard and keeps one tab stop", () => {
    renderToc({ maxLevel: 3 });
    const build = screen.getByRole("button", { name: "Build" });
    expect(build.getAttribute("aria-expanded")).toBe("true");
    const stops = screen.getByRole("navigation").querySelectorAll("button[tabindex='0']");
    expect(stops).toHaveLength(1);
    build.focus();
    fireEvent.keyDown(build, { key: "ArrowLeft" });
    expect(build.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Cache" })).toBeNull();
    fireEvent.keyDown(build, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Cache" })).toBeTruthy();
    fireEvent.keyDown(build, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Cache");
  });

  it("shows every section again when folding is turned off", () => {
    const ref = createRef<HTMLDivElement>();
    const view = (collapsible: boolean) =>
      createElement(
        "div",
        null,
        createElement(kit.TableOfContents, { markdown: DOC, target: ref, collapsible }),
        createElement("div", { ref })
      );
    const { rerender } = mount(view(true));
    const build = screen.getByRole("button", { name: "Build" });
    build.focus();
    fireEvent.keyDown(build, { key: "ArrowLeft" });
    expect(screen.queryByRole("button", { name: "Cache" })).toBeNull();
    rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 360, itemHeight: 18 } },
          view(false)
        )
      )
    );
    expect(screen.getByRole("button", { name: "Cache" })).toBeTruthy();
  });

  it("leaves out levels past maxLevel and survives junk headings", () => {
    renderToc({ maxLevel: 2, title: null });
    expect(screen.queryByRole("button", { name: "Cache" })).toBeNull();
    expect(screen.queryByText("On this page")).toBeNull();
    cleanup();
    renderLoose(kit.TableOfContents, { headings: [{ text: "", level: 9 }, "x"], target: null });
    expect(screen.getByText("No headings")).toBeTruthy();
  });
});
