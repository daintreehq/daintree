// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { PanelInstance, TabGroup } from "@shared/types/panel";
import { ContentGrid } from "../ContentGrid";

// #12476: closing one grid panel must leave every other panel mounted — a
// remount restarts media playback and drops scroll and viewer state that
// terminals hide behind their cached xterm instances.

const lifecycle = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
  nextInstance: 0,
}));

const grid = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));

vi.mock("../useContentGridContext", () => ({
  useContentGridContext: () => ({
    ctx: grid.ctx,
    bindCombinedGrid: () => {},
    bindGridRegion: () => {},
  }),
}));

vi.mock("../GridPanel", async () => {
  const { useEffect, useState } = await import("react");
  function GridPanel({ terminalId }: { terminalId: string }) {
    const [identity] = useState(() => ({
      instance: ++lifecycle.nextInstance,
      initialId: terminalId,
    }));
    useEffect(() => {
      lifecycle.mounts.push(identity.initialId);
      return () => {
        lifecycle.unmounts.push(identity.initialId);
      };
    }, [identity]);
    return (
      <div
        data-testid="grid-panel"
        data-terminal-id={terminalId}
        data-instance={identity.instance}
        data-initial-id={identity.initialId}
      />
    );
  }
  return { GridPanel };
});

vi.mock("../TwoPaneSplitLayout", () => ({
  TwoPaneSplitLayout: () => <div data-testid="split-divider" />,
}));

vi.mock("@/components/DragDrop", () => ({
  GRID_PLACEHOLDER_ID: "__grid-placeholder__",
  SortableTerminal: ({
    terminal,
    children,
  }: {
    terminal: PanelInstance;
    children: React.ReactNode;
  }) => <div data-sortable-id={terminal.id}>{children}</div>,
  SortableGridPlaceholder: () => <div data-testid="grid-placeholder" />,
}));

vi.mock("../GridShell", () => ({
  GridShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../GridScrollbar", () => ({
  GridScrollbar: () => null,
  GRID_SCROLLBAR_GUTTER_PX: 22,
}));
vi.mock("../GridTabGroup", () => ({ GridTabGroup: () => null }));
vi.mock("../GridNotificationBar", () => ({ GridNotificationBar: () => null }));
vi.mock("../TerminalCountWarning", () => ({ TerminalCountWarning: () => null }));
vi.mock("../BatchScrollbackRestoreBar", () => ({ BatchScrollbackRestoreBar: () => null }));
vi.mock("../ContentGridEmptyState", () => ({ ContentGridEmptyState: () => null }));
vi.mock("../ContentGridFleetScope", () => ({ ContentGridFleetScope: () => null }));
vi.mock("../ContentGridMaximizedGroup", () => ({ ContentGridMaximizedGroup: () => null }));
vi.mock("../ContentGridMaximizedSingle", () => ({ ContentGridMaximizedSingle: () => null }));
vi.mock("@/components/Plugin/ProjectPluginTrustBanner", () => ({
  ProjectPluginTrustBanner: () => null,
}));
vi.mock("@/components/Plugin/ProjectSurfaceFrame", () => ({
  ProjectSurfaceFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

interface GridFixture {
  ids: string[];
  split?: boolean;
  placeholderIndex?: number;
}

// Mirrors what useContentGridContext hands the layouts: one virtual singleton
// group per panel, and the two-pane pair when split mode is active.
function setGrid({ ids, split = false, placeholderIndex }: GridFixture) {
  const panels = new Map(ids.map((id) => [id, panel(id)]));
  const tabGroups: TabGroup[] = ids.map((id) => ({
    id,
    location: "grid",
    worktreeId: "wt1",
    activeTabId: id,
    panelIds: [id],
  }));
  const showPlaceholder = placeholderIndex !== undefined;
  grid.ctx = {
    isFleetScopeRender: false,
    maximizedId: null,
    maximizeTarget: null,
    gridTerminals: [...panels.values()],
    useTwoPaneSplitMode: split,
    twoPaneTerminals: split ? [panels.get(ids[0]!)!, panels.get(ids[1]!)!] : null,
    tabGroups,
    getTabGroupPanels: (groupId: string) => {
      const found = panels.get(groupId);
      return found ? [found] : [];
    },
    panelIds: ids,
    gridItemCount: ids.length,
    gridCols: 2,
    gridWidth: 1000,
    isScrollMode: false,
    scrollRowHeight: 300,
    isEmpty: ids.length === 0,
    showPlaceholder,
    placeholderInGrid: showPlaceholder,
    placeholderIndex: placeholderIndex ?? -1,
    focusedId: null,
    activeWorktreeId: "wt1",
    isInTrash: () => false,
    layoutTransition: { duration: 0 },
    layoutAnimationEnabled: true,
    handleAddTabForPanel: () => {},
    gridScrollRoot: null,
    setGridScrollRoot: () => {},
    isMacroFocused: false,
    handleGridRegionKeyDown: () => {},
    isOver: false,
  };
}

function panelNode(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(
    `[data-testid="grid-panel"][data-terminal-id="${id}"]`
  );
  if (!node) throw new Error(`panel ${id} is not rendered`);
  return node;
}

function snapshot(container: HTMLElement, ids: string[]): Map<string, HTMLElement> {
  return new Map(ids.map((id) => [id, panelNode(container, id)]));
}

function expectSurvivors(
  container: HTMLElement,
  before: Map<string, HTMLElement>,
  survivors: string[]
) {
  for (const id of survivors) {
    expect(panelNode(container, id)).toBe(before.get(id));
  }
  for (const id of survivors) {
    expect(lifecycle.unmounts).not.toContain(id);
  }
}

function splitGrid(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-split-mode="true"]');
}

describe("ContentGrid panel identity across layout changes (#12476)", () => {
  beforeEach(() => {
    lifecycle.mounts.length = 0;
    lifecycle.unmounts.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps later panels mounted when an earlier grid panel closes", () => {
    setGrid({ ids: ["a", "b", "c", "d"] });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, ["b", "c", "d"]);

    setGrid({ ids: ["b", "c", "d"] });
    rerender(<ContentGrid />);

    expectSurvivors(container, before, ["b", "c", "d"]);
    expect(lifecycle.unmounts).toEqual(["a"]);
  });

  it("keeps earlier panels mounted when a later grid panel closes", () => {
    setGrid({ ids: ["a", "b", "c", "d"] });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, ["a", "b", "c"]);

    setGrid({ ids: ["a", "b", "c"] });
    rerender(<ContentGrid />);

    expectSurvivors(container, before, ["a", "b", "c"]);
    expect(lifecycle.unmounts).toEqual(["d"]);
  });

  it.each([
    ["first", ["b", "c"]],
    ["middle", ["a", "c"]],
    ["last", ["a", "b"]],
  ])("keeps the survivors mounted when closing the %s of three enters split mode", (_, rest) => {
    setGrid({ ids: ["a", "b", "c"] });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, rest);
    expect(splitGrid(container)).toBeNull();

    setGrid({ ids: rest, split: true });
    rerender(<ContentGrid />);

    expect(splitGrid(container)).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="split-divider"]')).toHaveLength(1);
    expectSurvivors(container, before, rest);
    expect(lifecycle.unmounts).toHaveLength(1);
  });

  it("places the split divider between the two panes", () => {
    setGrid({ ids: ["a", "b"], split: true });
    const { container } = render(<ContentGrid />);
    const gridNode = splitGrid(container)!;

    const order = Array.from(gridNode.children).map(
      (child) => child.getAttribute("data-sortable-id") ?? child.getAttribute("data-testid") ?? "?"
    );
    expect(order).toEqual(["a", "split-divider", "b"]);
  });

  it.each([
    ["first", "b"],
    ["second", "a"],
  ])("keeps the survivor mounted when closing the %s split pane", (_, survivor) => {
    setGrid({ ids: ["a", "b"], split: true });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, [survivor]);

    setGrid({ ids: [survivor] });
    rerender(<ContentGrid />);

    expect(splitGrid(container)).toBeNull();
    expect(container.querySelector('[data-testid="split-divider"]')).toBeNull();
    expectSurvivors(container, before, [survivor]);
  });

  it("keeps both panes mounted when split mode turns off and back on", () => {
    setGrid({ ids: ["a", "b"], split: true });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, ["a", "b"]);

    setGrid({ ids: ["a", "b"] });
    rerender(<ContentGrid />);
    expect(splitGrid(container)).toBeNull();

    setGrid({ ids: ["a", "b"], split: true });
    rerender(<ContentGrid />);

    expect(splitGrid(container)).not.toBeNull();
    expectSurvivors(container, before, ["a", "b"]);
    expect(lifecycle.unmounts).toEqual([]);
  });

  it("keeps each split pane bound to its own panel when the pair reorders", () => {
    setGrid({ ids: ["a", "b"], split: true });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, ["a", "b"]);

    setGrid({ ids: ["b", "a"], split: true });
    rerender(<ContentGrid />);

    expectSurvivors(container, before, ["a", "b"]);
    expect(panelNode(container, "a").getAttribute("data-initial-id")).toBe("a");
    expect(panelNode(container, "b").getAttribute("data-initial-id")).toBe("b");
  });

  it("keeps the drag placeholder and the panels mounted as it moves to the end", () => {
    setGrid({ ids: ["a", "b", "c"], placeholderIndex: 1 });
    const { container, rerender } = render(<ContentGrid />);
    const before = snapshot(container, ["a", "b", "c"]);
    const placeholder = container.querySelector('[data-testid="grid-placeholder"]');
    expect(placeholder).not.toBeNull();

    setGrid({ ids: ["a", "b", "c"], placeholderIndex: 3 });
    rerender(<ContentGrid />);

    expect(container.querySelector('[data-testid="grid-placeholder"]')).toBe(placeholder);
    expectSurvivors(container, before, ["a", "b", "c"]);
  });
});
