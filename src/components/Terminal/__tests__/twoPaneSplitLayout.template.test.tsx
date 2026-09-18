// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { PanelInstance } from "@shared/types/panel";
import { TwoPaneSplitLayout } from "../TwoPaneSplitLayout";

// The split controller no longer owns the grid element (#12476): it lays the
// panes out by publishing a column template to ContentGridDefault, which keeps
// the panes in its own keyed list across the split boundary.

const splitState = vi.hoisted(() => ({
  ratioByWorktreeId: {},
  config: { enabled: true, defaultRatio: 0.5, preferPreview: false },
  commitRatioIfChanged: () => {},
  resetWorktreeRatio: () => {},
  setWorktreeRatio: () => {},
}));

vi.mock("@/store", () => ({
  useTwoPaneSplitStore: <T,>(selector: (state: typeof splitState) => T) => selector(splitState),
}));

vi.mock("@/store/twoPaneSplitStore", () => ({
  resolveEffectiveRatio: () => undefined,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    lockResize: () => {},
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
  const containerRef = { current: document.createElement("div") };
  return render(
    <TwoPaneSplitLayout
      terminals={[panel("a"), panel("b")]}
      activeWorktreeId="wt1"
      containerRef={containerRef}
      onGridTemplateChange={onGridTemplateChange}
    />
  );
}

function ratiosOf(template: string | null | undefined): number[] {
  return Array.from((template ?? "").matchAll(/minmax\(0, ([\d.]+)fr\)/g), (m) =>
    Number(m[1])
  );
}

describe("TwoPaneSplitLayout grid template", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders only the divider, leaving the panes to the grid", () => {
    const { container } = renderController(() => {});

    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.getAttribute("role")).toBe("separator");
  });

  it("publishes the configured ratio as the grid's column template on mount", () => {
    const onGridTemplateChange = vi.fn<(template: string | null) => void>();
    renderController(onGridTemplateChange);

    const template = onGridTemplateChange.mock.calls.at(-1)?.[0];
    expect(ratiosOf(template)).toEqual([0.5, 0.5]);
  });

  it("republishes the template when the divider moves", () => {
    const onGridTemplateChange = vi.fn<(template: string | null) => void>();
    const { getByRole } = renderController(onGridTemplateChange);

    fireEvent.keyDown(getByRole("separator"), { key: "ArrowRight" });

    const [left, right] = ratiosOf(onGridTemplateChange.mock.calls.at(-1)?.[0]);
    expect(left).toBeGreaterThan(0.5);
    expect(left! + right!).toBeCloseTo(1);
  });

  it("clears the template on unmount so the grid falls back to its own columns", () => {
    const onGridTemplateChange = vi.fn<(template: string | null) => void>();
    const { unmount } = renderController(onGridTemplateChange);

    unmount();

    expect(onGridTemplateChange.mock.calls.at(-1)).toEqual([null]);
  });
});
