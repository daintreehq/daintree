// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { PanelInstance } from "@shared/types/panel";
import { TwoPaneSplitLayout } from "../TwoPaneSplitLayout";
import { DIVIDER_WIDTH_PX } from "../TwoPaneSplitDivider";

// The split controller no longer owns the grid element (#12476): it lays the
// panes out by publishing a column template to ContentGridDefault, which keeps
// the panes in its own keyed list across the split boundary. It is mounted
// only while split mode is active, so its unmount still ends a split session.

const services = vi.hoisted(() => ({
  lockResize: vi.fn<(id: string, locked: boolean) => void>(),
  commitRatioIfChanged:
    vi.fn<(worktreeId: string, ratio: number, panels: [string, string]) => void>(),
}));

const splitState = vi.hoisted(() => ({
  ratioByWorktreeId: {},
  config: { enabled: true, defaultRatio: 0.6, preferPreview: false },
  commitRatioIfChanged: services.commitRatioIfChanged,
  resetWorktreeRatio: () => {},
  setWorktreeRatio: () => {},
}));

// Asymmetric, so a template hardcoded to equal halves would show.
const DEFAULT_RATIO = splitState.config.defaultRatio;

vi.mock("@/store", () => ({
  useTwoPaneSplitStore: <T,>(selector: (state: typeof splitState) => T) => selector(splitState),
}));

vi.mock("@/store/twoPaneSplitStore", () => ({
  resolveEffectiveRatio: () => undefined,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    lockResize: services.lockResize,
    runResizePass: () => {},
    scheduleBatchResize: () => {},
  },
}));

vi.mock("@/lib/layoutTransitionLock", () => ({
  isSidebarMeasurementLocked: () => true,
  subscribeSidebarLayoutTransitionUnlock: () => () => {},
  subscribeSidebarHydrationUnlock: () => () => {},
}));

class StubResizeObserver {
  observe() {}
  disconnect() {}
}

// Frames are queued, never run: the drag re-arm loop reschedules itself every
// frame, so a synchronous stub would recurse.
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function panel(id: string): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    worktreeId: "wt1",
    cwd: "/repo",
    cols: 80,
    rows: 24,
  };
}

function renderController(onGridTemplateChange: (template: string | null) => void) {
  const container = document.createElement("div");
  container.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 600 });
  return render(
    <TwoPaneSplitLayout
      terminals={[panel("a"), panel("b")]}
      activeWorktreeId="wt1"
      containerRef={{ current: container }}
      onGridTemplateChange={onGridTemplateChange}
    />
  );
}

// "minmax(0, 0.6fr) 6px minmax(0, 0.4fr)" -> ["minmax(0, 0.6fr)", "6px", ...]
function tracksOf(template: string | null | undefined): string[] {
  return (template ?? "").match(/minmax\([^)]*\)|\S+/g) ?? [];
}

function fractionOf(track: string | undefined): number {
  const match = /minmax\(0, ([\d.]+)fr\)/.exec(track ?? "");
  return match ? Number(match[1]) : Number.NaN;
}

function dragShield(): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')).find(
    (node) => node.style.cursor === "col-resize"
  );
}

describe("TwoPaneSplitLayout grid template", () => {
  beforeEach(() => {
    frames.clear();
    services.lockResize.mockClear();
    services.commitRatioIfChanged.mockClear();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(++nextFrame, cb);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("renders only the divider, leaving the panes to the grid", () => {
    const { container } = renderController(() => {});

    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.getAttribute("role")).toBe("separator");
  });

  it("publishes the configured ratio around the divider's own track on mount", () => {
    const onGridTemplateChange = vi.fn<(template: string | null) => void>();
    renderController(onGridTemplateChange);

    const [left, divider, right] = tracksOf(onGridTemplateChange.mock.calls.at(-1)?.[0]);
    expect(fractionOf(left)).toBeCloseTo(DEFAULT_RATIO);
    expect(divider).toBe(`${DIVIDER_WIDTH_PX}px`);
    expect(fractionOf(right)).toBeCloseTo(1 - DEFAULT_RATIO);
  });

  it("republishes the template when the divider moves", () => {
    const onGridTemplateChange = vi.fn<(template: string | null) => void>();
    const { getByRole } = renderController(onGridTemplateChange);

    fireEvent.keyDown(getByRole("separator"), { key: "ArrowRight" });

    const [left, , right] = tracksOf(onGridTemplateChange.mock.calls.at(-1)?.[0]);
    expect(fractionOf(left)).toBeGreaterThan(DEFAULT_RATIO);
    expect(fractionOf(left) + fractionOf(right)).toBeCloseTo(1);
  });

  it("clears the template on unmount so the grid falls back to its own columns", () => {
    const onGridTemplateChange = vi.fn<(template: string | null) => void>();
    const { unmount } = renderController(onGridTemplateChange);

    unmount();

    expect(onGridTemplateChange.mock.calls.at(-1)).toEqual([null]);
  });

  it("ends an in-flight divider drag cleanly when split mode goes away", () => {
    const { getByRole, unmount } = renderController(() => {});

    fireEvent.mouseDown(getByRole("separator"), { button: 0, clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 700 });

    expect(dragShield()).toBeDefined();
    expect(document.body.style.cursor).toBe("col-resize");
    expect(services.lockResize).toHaveBeenCalledWith("a", true);
    expect(services.lockResize).toHaveBeenCalledWith("b", true);
    services.lockResize.mockClear();

    unmount();

    expect(dragShield()).toBeUndefined();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(services.lockResize).toHaveBeenCalledWith("a", false);
    expect(services.lockResize).toHaveBeenCalledWith("b", false);
    expect(services.lockResize).not.toHaveBeenCalledWith(expect.any(String), true);
    expect(frames.size).toBe(0);
    // The ratio dragged to is kept for the pair and worktree it was set on.
    expect(services.commitRatioIfChanged).toHaveBeenCalledWith("wt1", 0.7, ["a", "b"]);
  });
});
