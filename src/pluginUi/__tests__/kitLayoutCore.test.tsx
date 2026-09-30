// @vitest-environment jsdom
import { createElement, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import {
  autoGridTemplate,
  fitOverflow,
  gridColumnsTemplate,
  readOverflowItems,
  scrollEdgesOf,
} from "@/components/PluginKit/PluginKitLayoutCore";
import { breakpointFor } from "@/pluginUi/containerSize";
import { TooltipProvider } from "@/components/ui/tooltip";

// A ResizeObserver that reports when the test says the layout changed.
const resizeCallbacks = new Set<() => void>();
class ManualResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = () => callback();
  }
  observe() {
    resizeCallbacks.add(this.callback);
  }
  unobserve() {}
  disconnect() {
    resizeCallbacks.delete(this.callback);
  }
}

function relayout() {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback();
  });
}

// Geometry jsdom does not compute: every element reports the width a test
// assigns to its marker attribute, and 0 otherwise.
const widths = new Map<string, number>();
// Own descriptors, so teardown can put back exactly what was there: jsdom
// defines `clientWidth` on Element, not HTMLElement.
const ownRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
const ownClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

function restorePrototype(key: string, own: PropertyDescriptor | undefined) {
  if (own) Object.defineProperty(HTMLElement.prototype, key, own);
  else Reflect.deleteProperty(HTMLElement.prototype, key);
}

function widthOf(element: HTMLElement): number {
  for (const [attribute, width] of widths) {
    if (element.hasAttribute(attribute)) return width;
  }
  return 0;
}

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function rect(this: HTMLElement) {
      const width = widthOf(this);
      const height = widths.get(`height:${this.dataset.testid ?? ""}`) ?? 0;
      return DOMRect.fromRect({ x: 0, y: 0, width, height });
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return widthOf(this);
    },
  });
});

afterEach(() => {
  cleanup();
  widths.clear();
  resizeCallbacks.clear();
  vi.unstubAllGlobals();
  restorePrototype("getBoundingClientRect", ownRect);
  restorePrototype("clientWidth", ownClientWidth);
});

// The untyped shape a JavaScript view can send: the adapters must degrade, never throw.
function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function classesOf(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

function gapClass(element: HTMLElement): string | undefined {
  return classesOf(element).find((name) => /^gap-/.test(name));
}

describe("Stack, Inline and Cluster", () => {
  it("steps the gap along one scale, and ignores a value off it", () => {
    const gaps = (["none", "xs", "sm", "md", "lg", "xl"] as const).map((gap) => {
      render(createElement(kit.Stack, { gap, "data-testid": `stack-${gap}` }, "a"));
      return gapClass(screen.getByTestId(`stack-${gap}`));
    });
    expect(new Set(gaps).size).toBe(6);
    render(untyped("Stack", { gap: "huge", "data-testid": "bad" }, "a"));
    render(untyped("Stack", { "data-testid": "default" }, "a"));
    expect(gapClass(screen.getByTestId("bad"))).toBe(gapClass(screen.getByTestId("default")));
  });

  it("lays a Stack out as a column and an Inline as a row that wraps only on request", () => {
    render(createElement(kit.Stack, { "data-testid": "stack" }, "a"));
    render(createElement(kit.Inline, { "data-testid": "inline" }, "a"));
    render(createElement(kit.Inline, { wrap: true, "data-testid": "wrapping" }, "a"));
    render(createElement(kit.Cluster, { "data-testid": "cluster" }, "a"));
    expect(classesOf(screen.getByTestId("stack"))).toContain("flex-col");
    expect(classesOf(screen.getByTestId("inline"))).toContain("flex-nowrap");
    expect(classesOf(screen.getByTestId("wrapping"))).toContain("flex-wrap");
    expect(classesOf(screen.getByTestId("cluster"))).toContain("flex-wrap");
  });

  it("maps align and justify, falling back on unknown values", () => {
    render(
      createElement(kit.Inline, { align: "end", justify: "between", "data-testid": "set" }, "a")
    );
    render(untyped("Inline", { align: "diagonal", justify: 3, "data-testid": "bad" }, "a"));
    render(createElement(kit.Inline, { "data-testid": "default" }, "a"));
    const set = classesOf(screen.getByTestId("set"));
    expect(set).toContain("items-end");
    expect(set).toContain("justify-between");
    expect(screen.getByTestId("bad").className).toBe(screen.getByTestId("default").className);
  });

  it("renders as a listed element and strips list markers, and as a div otherwise", () => {
    render(
      createElement(
        kit.Stack,
        { as: "ul", "aria-label": "Checks", "data-testid": "list" },
        createElement("li", null, "Lint")
      )
    );
    const list = screen.getByTestId("list");
    expect(list.tagName).toBe("UL");
    expect(classesOf(list)).toContain("list-none");
    expect(list.getAttribute("aria-label")).toBe("Checks");
    render(untyped("Stack", { as: "script", "data-testid": "fallback" }, "x"));
    expect(screen.getByTestId("fallback").tagName).toBe("DIV");
  });

  it("forwards DOM props and drops what is not one", () => {
    const onClick = vi.fn();
    render(
      untyped(
        "Cluster",
        {
          role: "group",
          onClick,
          dangerouslySetInnerHTML: { __html: "<b>x</b>" },
          "data-testid": "cluster",
        },
        "tag"
      )
    );
    const cluster = screen.getByTestId("cluster");
    expect(cluster.getAttribute("role")).toBe("group");
    expect(cluster.querySelector("b")).toBeNull();
    fireEvent.click(cluster);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Grid and AutoGrid", () => {
  it("turns a column count or a template into a track list, and refuses the rest", () => {
    expect(gridColumnsTemplate(3)).toBe("repeat(3, minmax(0, 1fr))");
    expect(gridColumnsTemplate("200px 1fr")).toBe("200px 1fr");
    for (const bad of [0, 13, 2.5, Number.NaN, "", "1fr; color: red", "{}", null]) {
      expect(gridColumnsTemplate(bad)).toBeUndefined();
    }
  });

  it("lays out explicit columns and keeps its own tracks over a plugin style", () => {
    render(
      createElement(
        kit.Grid,
        { columns: 2, style: { color: "red", gridTemplateColumns: "1fr" }, "data-testid": "grid" },
        "a",
        "b"
      )
    );
    const grid = screen.getByTestId("grid");
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(grid.style.color).toBe("red");
    render(untyped("Grid", { columns: "nope;", "data-testid": "bad" }, "a"));
    expect(screen.getByTestId("bad").style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("fills the grid's own width with columns no narrower than the minimum", () => {
    expect(autoGridTemplate(160, undefined, false, 12)).toBe(
      "repeat(auto-fill, minmax(min(100%, 160px), 1fr))"
    );
    expect(autoGridTemplate(160, undefined, true, 12)).toContain("auto-fit");
    // A bad minimum falls back to the default rather than collapsing columns.
    expect(autoGridTemplate(-4, undefined, false, 12)).toBe(
      autoGridTemplate(undefined, undefined, false, 12)
    );
  });

  it("raises each column's floor so no more than maxColumns fit", () => {
    const template = autoGridTemplate(120, 4, false, 12);
    // Three gaps between four columns come off the width before it is shared.
    expect(template).toContain("calc((100% - 36px) / 4)");
    expect(autoGridTemplate(120, 0, false, 12)).toBe(autoGridTemplate(120, undefined, false, 12));
  });

  it("puts the track list on the element", () => {
    render(
      createElement(kit.AutoGrid, { minColumnWidth: 200, gap: "lg", "data-testid": "auto" }, "a")
    );
    const grid = screen.getByTestId("auto");
    expect(grid.style.gridTemplateColumns).toBe(autoGridTemplate(200, undefined, false, 16));
    expect(classesOf(grid)).toContain("grid");
  });
});

describe("PaneLayout", () => {
  function shell(props: Record<string, unknown>) {
    return render(
      createElement(
        TooltipProvider,
        null,
        untyped(
          "PaneLayout",
          {
            "data-testid": "shell",
            header: createElement("div", { "data-testid": "head" }, "Header"),
            toolbar: createElement("div", { "data-testid": "tools" }, "Tools"),
            footer: createElement("div", { "data-testid": "foot" }, "Footer"),
            statusBar: createElement("div", { "data-testid": "status" }, "Status"),
            ...props,
          },
          createElement("p", { "data-testid": "content" }, "Body")
        )
      )
    );
  }

  it("stacks the chrome around the body in order, with only the body scrolling", () => {
    shell({});
    const root = screen.getByTestId("shell");
    const order = [...root.querySelectorAll("[data-testid]")].map((el) =>
      el.getAttribute("data-testid")
    );
    expect(order).toEqual(["head", "tools", "content", "foot", "status"]);
    expect(classesOf(root)).toContain("overflow-hidden");
    const scrollers = [...root.querySelectorAll<HTMLElement>("*")].filter((el) =>
      classesOf(el).some((name) => /^overflow-(y-)?auto$/.test(name))
    );
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]?.contains(screen.getByTestId("content"))).toBe(true);
    for (const slot of ["header", "toolbar", "footer", "status"]) {
      const frame = root.querySelector<HTMLElement>(`[data-pane-layout-slot="${slot}"]`);
      expect(frame && classesOf(frame)).toContain("shrink-0");
    }
  });

  it("leaves out chrome it was not given", () => {
    render(createElement(kit.PaneLayout, { "data-testid": "shell" }, "Body"));
    const root = screen.getByTestId("shell");
    expect(root.querySelectorAll("[data-pane-layout-slot]")).toHaveLength(1);
  });

  it("hands the body's scroller to bodyRef and names it with bodyLabel", () => {
    const ref = { current: null as HTMLDivElement | null };
    shell({ bodyRef: ref, bodyLabel: "Dashboard" });
    const region = screen.getByRole("region", { name: "Dashboard" });
    expect(ref.current).toBe(region);
    expect(classesOf(region)).toContain("overflow-y-auto");
  });

  it("does not scroll the body with scroll none, for content with its own scroller", () => {
    shell({ scroll: "none", padding: "md" });
    const body = screen
      .getByTestId("shell")
      .querySelector<HTMLElement>('[data-pane-layout-slot="body"]');
    expect(body && classesOf(body)).toContain("overflow-hidden");
    expect(body && classesOf(body)).toContain("p-3");
  });
});

describe("StatusBar", () => {
  it("draws a quiet, unannounced dot between the facts of an array, skipping empties", () => {
    render(
      createElement(kit.StatusBar, {
        left: ["12 lines", "", null, "3 KB", "UTF-8"],
        right: "Saved",
        "data-testid": "bar",
      })
    );
    const left = screen
      .getByTestId("bar")
      .querySelector<HTMLElement>('[data-status-bar-slot="left"]');
    expect(left?.textContent).toBe("12 lines·3 KB·UTF-8");
    expect(left?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(screen.getByTestId("bar").getAttribute("aria-live")).toBeNull();
  });

  it("keeps an element fact whole and truncates text facts", () => {
    render(
      createElement(kit.StatusBar, {
        left: ["Long branch name", createElement("button", { type: "button" }, "Save")],
        "data-testid": "bar",
      })
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.parentElement?.getAttribute("data-status-bar-slot")).toBe("left");
    expect(classesOf(screen.getByText("Long branch name"))).toContain("truncate");
  });

  it("moves its hairline to the other edge when it sits above the content", () => {
    render(createElement(kit.StatusBar, { left: "a", "data-testid": "bottom" }));
    render(createElement(kit.StatusBar, { left: "a", placement: "top", "data-testid": "top" }));
    expect(classesOf(screen.getByTestId("bottom"))).toContain("border-t");
    expect(classesOf(screen.getByTestId("bottom"))).not.toContain("border-b");
    expect(classesOf(screen.getByTestId("top"))).toContain("border-b");
    expect(classesOf(screen.getByTestId("top"))).not.toContain("border-t");
  });

  it("is taller in the comfortable density", () => {
    render(createElement(kit.StatusBar, { left: "a", "data-testid": "compact" }));
    render(
      createElement(kit.StatusBar, { left: "a", density: "comfortable", "data-testid": "roomy" })
    );
    // Tailwind steps are quarter-rems, so the class's number orders the heights.
    const height = (id: string) => {
      const step = classesOf(screen.getByTestId(id))
        .map((name) => /^(?:min-)?h-(\d+(?:\.\d+)?)$/.exec(name)?.[1])
        .find((value) => value !== undefined);
      return Number(step);
    };
    expect(height("roomy")).toBeGreaterThan(height("compact"));
  });

  it("balances both sides around a centre slot", () => {
    render(createElement(kit.StatusBar, { left: "a", center: "b", "data-testid": "bar" }));
    const bar = screen.getByTestId("bar");
    const slots = [...bar.querySelectorAll<HTMLElement>("[data-status-bar-slot]")];
    expect(slots.map((slot) => slot.dataset.statusBarSlot)).toEqual(["left", "center", "right"]);
    expect(classesOf(slots[0]!)).toContain("basis-0");
    expect(classesOf(slots[2]!)).toContain("basis-0");
  });

  it("flattens nested facts and ignores empty ones, leaving no stray dots or slots", () => {
    render(
      untyped("StatusBar", {
        left: ["A", [], ["B", ["", null]], false, Number.NaN, "C"],
        center: [null, false, ""],
        "data-testid": "bar",
      })
    );
    const bar = screen.getByTestId("bar");
    const left = bar.querySelector<HTMLElement>('[data-status-bar-slot="left"]');
    expect(left?.textContent).toBe("A·B·C");
    expect(bar.querySelector('[data-status-bar-slot="center"]')).toBeNull();
    expect(bar.querySelector('[data-status-bar-slot="right"]')).toBeNull();
  });

  it("never truncates the right side, even around a centre slot", () => {
    render(
      createElement(kit.StatusBar, {
        left: "12 lines",
        center: "Ln 4, Col 2",
        right: ["Unsaved changes", "LF"],
        "data-testid": "bar",
      })
    );
    const right = screen
      .getByTestId("bar")
      .querySelector<HTMLElement>('[data-status-bar-slot="right"]');
    expect(right?.querySelector(".truncate")).toBeNull();
    expect(classesOf(right!)).toContain("min-w-fit");
    expect(classesOf(screen.getByText("12 lines"))).toContain("truncate");
  });

  it("ignores unknown density and placement", () => {
    render(untyped("StatusBar", { left: "a", density: "huge", placement: 1, "data-testid": "x" }));
    render(createElement(kit.StatusBar, { left: "a", "data-testid": "y" }));
    expect(screen.getByTestId("x").className).toBe(screen.getByTestId("y").className);
  });
});

describe("ScrollArea", () => {
  const base = {
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    scrollLeft: 0,
    scrollWidth: 500,
    clientWidth: 200,
    rtl: false,
  };

  it("fades only the edges that have more to scroll", () => {
    expect(scrollEdgesOf(base)).toEqual({ top: false, bottom: false, left: false, right: true });
    expect(scrollEdgesOf({ ...base, scrollLeft: 150 })).toEqual({
      top: false,
      bottom: false,
      left: true,
      right: true,
    });
    expect(scrollEdgesOf({ ...base, scrollLeft: 300 }).right).toBe(false);
    expect(
      scrollEdgesOf({ ...base, scrollHeight: 400, scrollTop: 300, clientHeight: 100 })
    ).toMatchObject({ top: true, bottom: false });
  });

  it("reads a right-to-left scroller from its right edge", () => {
    expect(scrollEdgesOf({ ...base, rtl: true })).toMatchObject({ left: true, right: false });
    expect(scrollEdgesOf({ ...base, rtl: true, scrollLeft: -300 })).toMatchObject({
      left: false,
      right: true,
    });
  });

  it("scrolls the axes it is given and puts DOM props on the scroller", () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      createElement(
        kit.ScrollArea,
        { orientation: "horizontal", ref, "aria-label": "Recent builds", tabIndex: 0 },
        "cards"
      )
    );
    const scroller = screen.getByLabelText("Recent builds");
    expect(ref.current).toBe(scroller);
    expect(classesOf(scroller)).toContain("overflow-x-auto");
    expect(classesOf(scroller)).toContain("overflow-y-hidden");
    expect(scroller.tabIndex).toBe(0);
  });

  it("shows the right fade once the content overflows, and the left one after a scroll", () => {
    render(
      createElement(
        kit.ScrollArea,
        { orientation: "horizontal", "data-testid": "scroller" },
        "cards"
      )
    );
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 800 });
    widths.set("data-testid", 200);
    relayout();
    const frame = scroller.parentElement!;
    const visible = () =>
      [...frame.querySelectorAll<HTMLElement>(':scope > [aria-hidden="true"]')].map(
        (fade) => fade.dataset.visible
      );
    expect(visible()).toEqual(["false", "true"]);
    scroller.scrollLeft = 100;
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(visible()).toEqual(["true", "true"]);
  });

  it("is a named region when labelled, keeping a role of its own", () => {
    render(createElement(kit.ScrollArea, { "aria-label": "Cards" }, "x"));
    expect(screen.getByRole("region", { name: "Cards" })).toBeTruthy();
    render(createElement(kit.ScrollArea, { "aria-label": "Files", role: "listbox" }, "x"));
    expect(screen.getByRole("listbox", { name: "Files" })).toBeTruthy();
    render(createElement(kit.ScrollArea, { "data-testid": "plain" }, "x"));
    expect(screen.getByTestId("plain").getAttribute("role")).toBeNull();
  });

  it("runs a callback ref's cleanup on unmount", () => {
    const cleanup = vi.fn();
    const ref = vi.fn(() => cleanup);
    const { unmount } = render(createElement(kit.ScrollArea, { ref }, "x"));
    expect(ref).toHaveBeenCalledTimes(1);
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("ignores a ref it cannot write, rather than throwing", () => {
    expect(() =>
      render(
        createElement(
          "div",
          null,
          untyped("ScrollArea", { ref: Object.freeze([]) }, "x"),
          untyped("PaneLayout", { bodyRef: Object.freeze({ current: null }) }, "y"),
          untyped("PaneLayout", { bodyRef: Object.freeze([]), scroll: "none" }, "z")
        )
      )
    ).not.toThrow();
    expect(screen.getByText("y")).toBeTruthy();
    expect(screen.getByText("z")).toBeTruthy();
  });

  it("falls back to vertical for an unknown orientation", () => {
    render(untyped("ScrollArea", { orientation: "diagonal", "data-testid": "s" }, "x"));
    expect(classesOf(screen.getByTestId("s"))).toContain("overflow-y-auto");
  });
});

describe("OverflowToolbar", () => {
  const layout = (
    widths: number[],
    available: number,
    extra: Partial<Parameters<typeof fitOverflow>[0]> = {}
  ) =>
    fitOverflow({
      sequence: widths.map((_, index) => index),
      widths,
      priorities: widths.map(() => 0),
      available,
      gap: 2,
      moreWidth: 26,
      separatorWidth: 9,
      ...extra,
    });
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

  it("keeps everything when it fits, else the highest priorities beside the menu button", () => {
    expect(sorted(layout([26, 26, 26], 100))).toEqual([0, 1, 2]);
    // 26 (menu) + 2 + 26 + 2 + 26 = 82 fits in 90; a third would not.
    expect(sorted(layout([26, 26, 26, 26], 90))).toEqual([0, 1]);
    expect(sorted(layout([26, 26, 26, 26], 90, { priorities: [0, 0, 5, 0] }))).toEqual([0, 2]);
    expect(layout([26, 26], 10).size).toBe(0);
  });

  it("skips a control too wide to fit rather than stopping at it", () => {
    expect(sorted(layout([200, 26, 26], 82, { priorities: [10, 0, 0] }))).toEqual([1, 2]);
  });

  it("counts only the separators the strip would draw", () => {
    // Leading and trailing separators are never drawn: 26 + 2 + 26 fits.
    const sequence = ["separator", "separator", 0, 1, "separator"] as const;
    expect(sorted(layout([26, 26], 54, { sequence: [...sequence] }))).toEqual([0, 1]);
    // A separator between two drawn controls costs its width and a gap.
    expect(layout([26, 26], 54, { sequence: [0, "separator", 1] }).size).toBeLessThan(2);
    expect(sorted(layout([26, 26], 65, { sequence: [0, "separator", 1] }))).toEqual([0, 1]);
  });

  it("drops rows without an id or label and repeated ids", () => {
    const entries = readOverflowItems([
      { id: "a", label: "Alpha" },
      { id: "a", label: "Again" },
      { id: "", label: "Empty" },
      { id: "b" },
      { type: "separator" },
      { type: "mystery", id: "c", label: "C" },
      "nonsense",
      { id: "d", label: "Delta", priority: "high", pressed: "yes" },
    ]);
    expect(entries.map((entry) => (entry.kind === "action" ? entry.id : "|"))).toEqual([
      "a",
      "|",
      "d",
    ]);
    const delta = entries[2];
    expect(delta?.kind === "action" && delta.priority).toBe(0);
    expect(delta?.kind === "action" && delta.pressed).toBeUndefined();
  });

  const ITEMS = [
    { id: "refresh", label: "Refresh", icon: "refresh" },
    { id: "filter", label: "Filter", icon: "filter" },
    { type: "separator" as const },
    { id: "export", label: "Export", icon: "download" },
    { id: "pin", label: "Pin", icon: "pin", pressed: false },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  function toolbar(onSelect = vi.fn(), items: readonly Record<string, unknown>[] = ITEMS) {
    const wired = items.map((item) => ("id" in item ? { ...item, onSelect } : item));
    return render(
      createElement(
        TooltipProvider,
        null,
        untyped("OverflowToolbar", {
          "aria-label": "Dashboard actions",
          items: wired,
          variant: "bar",
        })
      )
    );
  }

  function setGeometry(region: number) {
    widths.set("data-measure-id", 26);
    widths.set("data-measure-more", 26);
    widths.set("data-overflow-region", region);
  }

  it("shows every control when the strip is wide enough", () => {
    setGeometry(1000);
    toolbar();
    relayout();
    const bar = screen.getByRole("toolbar", { name: "Dashboard actions" });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Refresh",
      "Filter",
      "Export",
      "Pin",
      "Settings",
    ]);
    expect(bar.querySelector("[data-overflow-more]")).toBeNull();
    expect(bar.querySelectorAll("hr")).toHaveLength(1);
  });

  it("folds the last controls into the menu when the strip narrows, and back out", () => {
    setGeometry(1000);
    toolbar();
    relayout();
    setGeometry(100);
    relayout();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names[names.length - 1]).toBe("More actions");
    expect(names).toContain("Refresh");
    expect(names).not.toContain("Settings");
    setGeometry(1000);
    relayout();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("stays one tab stop with arrow keys reaching the menu button", () => {
    setGeometry(100);
    toolbar();
    relayout();
    const buttons = screen.getAllByRole("button");
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    buttons[0]!.focus();
    for (let step = 1; step < buttons.length; step++) {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    }
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
  });

  it("offers the folded controls in the menu, a toggle as a check row", async () => {
    const onSelect = vi.fn();
    setGeometry(90);
    toolbar(onSelect);
    relayout();
    const more = screen.getByRole("button", { name: "More actions" });
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
    });
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("aria-label")).toBe("More actions");
    expect(screen.getByRole("menuitemcheckbox", { name: "Pin" })).toBeTruthy();
    const settings = screen.getByRole("menuitem", { name: "Settings" });
    await act(async () => {
      fireEvent.click(settings);
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("hands focus to the menu button when the focused control folds away", () => {
    setGeometry(1000);
    toolbar();
    relayout();
    screen.getByRole("button", { name: "Settings" }).focus();
    setGeometry(100);
    relayout();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
  });

  it("hands focus back to a control when the menu button goes away", () => {
    setGeometry(100);
    toolbar();
    relayout();
    screen.getByRole("button", { name: "More actions" }).focus();
    setGeometry(1000);
    relayout();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    const focused = document.activeElement;
    expect(focused instanceof HTMLElement && focused.dataset.overflowId).toBeTruthy();
  });

  it("hands focus to the menu button when new items fold the focused control", () => {
    setGeometry(90);
    const two = [
      { id: "a", label: "A", icon: "refresh" },
      { id: "b", label: "B", icon: "filter" },
    ];
    const { rerender } = toolbar(vi.fn(), two);
    relayout();
    screen.getByRole("button", { name: "B" }).focus();
    rerender(
      createElement(
        TooltipProvider,
        null,
        untyped("OverflowToolbar", {
          "aria-label": "Dashboard actions",
          items: [
            ...two,
            { id: "c", label: "C", icon: "download", priority: 5 },
            { id: "d", label: "D", icon: "settings", priority: 5 },
          ],
        })
      )
    );
    expect(screen.queryByRole("button", { name: "B" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
  });

  it("keeps a high-priority control in the strip over earlier ones", () => {
    setGeometry(90);
    toolbar(vi.fn(), [
      { id: "a", label: "A", icon: "refresh" },
      { id: "b", label: "B", icon: "filter" },
      { id: "c", label: "C", icon: "download" },
      { id: "d", label: "D", icon: "settings", priority: 10 },
    ]);
    relayout();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["A", "D", "More actions"]);
  });

  it("keeps an inline disabled control in the arrow order but ignores its press", () => {
    const onSelect = vi.fn();
    setGeometry(1000);
    toolbar(onSelect, [{ id: "a", label: "A", icon: "refresh", disabled: true }]);
    relayout();
    const button = screen.getByRole("button", { name: "A" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("useContainerSize and useBreakpoint", () => {
  it("names the widest step a width reaches, or null below all of them", () => {
    const steps = { sm: 360, md: 640, lg: 960 };
    expect(breakpointFor(200, steps)).toBeNull();
    expect(breakpointFor(360, steps)).toBe("sm");
    expect(breakpointFor(700, steps)).toBe("md");
    expect(breakpointFor(4000, steps)).toBe("lg");
    // Order in the record does not matter; bad steps are skipped.
    expect(breakpointFor(700, { wide: 600, narrow: 0, broken: Number.NaN })).toBe("wide");
    // An array is not a record of names: the defaults apply.
    expect(breakpointFor(700, [360, 640])).toBe("md");
  });

  const CUSTOM_STEPS = { narrow: 0, wide: 600 };

  function Probe({ custom }: { custom?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const size = kit.useContainerSize(ref);
    const standard = kit.useBreakpoint(ref);
    const own = kit.useBreakpoint(ref, CUSTOM_STEPS);
    const step = custom ? own : standard;
    return createElement(
      "div",
      { ref, "data-testid": "probe" },
      `${size.width}x${size.height} ${step ?? "none"}`
    );
  }

  it("reports the container's size and step, and follows it as it resizes", () => {
    widths.set("data-testid", 700);
    widths.set("height:probe", 300);
    render(createElement(Probe));
    relayout();
    expect(screen.getByTestId("probe").textContent).toBe("700x300 md");
    widths.set("data-testid", 300);
    relayout();
    expect(screen.getByTestId("probe").textContent).toBe("300x300 none");
  });

  it("takes custom steps", () => {
    widths.set("data-testid", 640);
    render(createElement(Probe, { custom: true }));
    relayout();
    expect(screen.getByTestId("probe").textContent).toContain("wide");
  });

  it("picks up an element that mounts after the hook's first render", () => {
    function Late() {
      const ref = useRef<HTMLDivElement>(null);
      const [shown, setShown] = useState(false);
      const { width } = kit.useContainerSize(ref);
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => setShown(true) }, "Show"),
        createElement("output", null, String(width)),
        shown ? createElement("div", { ref, "data-testid": "late" }) : null
      );
    }
    widths.set("data-testid", 420);
    render(createElement(Late));
    expect(screen.getByRole("status").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    relayout();
    expect(screen.getByRole("status").textContent).toBe("420");
  });

  it("stops observing on unmount", () => {
    widths.set("data-testid", 500);
    const { unmount } = render(createElement(Probe));
    expect(resizeCallbacks.size).toBeGreaterThan(0);
    unmount();
    expect(resizeCallbacks.size).toBe(0);
  });
});
