// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { PanelInstance, TabGroup } from "@shared/types/panel";
import type { ContentGridContext } from "../useContentGridContext";
import { ContentGrid } from "../ContentGrid";
import { DIVIDER_WIDTH_PX } from "../TwoPaneSplitDivider";

// #12476: closing one grid panel must leave every other panel mounted — a
// remount restarts media playback and drops scroll and viewer state that
// terminals hide behind their cached xterm instances.

const lifecycle = vi.hoisted(() => ({
  unmounts: [] as string[],
  nextInstance: 0,
}));

const grid = vi.hoisted(() => ({ ctx: {} as Partial<ContentGridContext> }));

// The real split controller runs; only its store and terminal services are
// stubbed. The default ratio is asymmetric so a grid that ignored the
// controller's template and fell back to equal halves would show.
const split = vi.hoisted(() => ({
  commitRatioIfChanged:
    vi.fn<(worktreeId: string, ratio: number, panels: [string, string]) => void>(),
}));
const splitState = vi.hoisted(() => ({
  ratioByWorktreeId: {},
  config: { enabled: true, defaultRatio: 0.7, preferPreview: false },
  commitRatioIfChanged: split.commitRatioIfChanged,
  resetWorktreeRatio: () => {},
  setWorktreeRatio: () => {},
}));

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

vi.mock("../GridTabGroup", async () => {
  const { GridPanel } = await import("../GridPanel");
  return {
    GridTabGroup: ({ group }: { group: TabGroup }) => (
      <GridPanel terminalId={group.activeTabId} isFocused={false} />
    ),
  };
});

vi.mock("@/store", () => ({
  useTwoPaneSplitStore: <T,>(selector: (state: typeof splitState) => T) => selector(splitState),
}));
vi.mock("@/store/twoPaneSplitStore", () => ({ resolveEffectiveRatio: () => undefined }));
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

vi.mock("@/components/DragDrop", async () => {
  const { SortableTerminal } = await vi.importActual<
    typeof import("@/components/DragDrop/SortableTerminal")
  >("@/components/DragDrop/SortableTerminal");
  return {
    GRID_PLACEHOLDER_ID: "__grid-placeholder__",
    SortableTerminal,
    SortableGridPlaceholder: () => <div data-testid="grid-placeholder" />,
  };
});

vi.mock("../GridShell", () => ({
  GridShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../GridScrollbar", () => ({
  GridScrollbar: () => null,
  GRID_SCROLLBAR_GUTTER_PX: 22,
}));
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

const PLACEHOLDER_ID = "__grid-placeholder__";

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

// A string is an ungrouped panel (a virtual singleton group keyed by its own
// id); an array is an explicit tab group whose first member is the active tab.
type Cell = string | string[];

interface GridFixture {
  cells: Cell[];
  split?: boolean;
  placeholderIndex?: number;
  layoutAnimationEnabled?: boolean;
  worktreeId?: string;
}

// Mirrors the shape useContentGridContext hands the layouts.
function setGrid({
  cells,
  split = false,
  placeholderIndex,
  layoutAnimationEnabled = true,
  worktreeId = "wt1",
}: GridFixture) {
  const tabGroups: TabGroup[] = cells.map((cell) => {
    const members = typeof cell === "string" ? [cell] : cell;
    return {
      id: typeof cell === "string" ? cell : `tabgroup-${members.join("-")}`,
      location: "grid",
      worktreeId: "wt1",
      activeTabId: members[0]!,
      panelIds: members,
    };
  });
  const byGroup = new Map(tabGroups.map((g) => [g.id, g.panelIds.map(panel)]));
  const showPlaceholder = placeholderIndex !== undefined;
  const panelIds = tabGroups.map((g) => g.panelIds[0]!);
  if (showPlaceholder) panelIds.splice(placeholderIndex, 0, PLACEHOLDER_ID);
  const twoPaneTerminals: [PanelInstance, PanelInstance] | null = split
    ? [byGroup.get(tabGroups[0]!.id)![0]!, byGroup.get(tabGroups[1]!.id)![0]!]
    : null;

  grid.ctx = {
    isFleetScopeRender: false,
    maximizedId: null,
    maximizeTarget: null,
    gridTerminals: [...byGroup.values()].flat(),
    useTwoPaneSplitMode: split,
    twoPaneTerminals,
    tabGroups,
    getTabGroupPanels: (groupId: string) => byGroup.get(groupId) ?? [],
    panelIds,
    gridItemCount: tabGroups.length + (showPlaceholder ? 1 : 0),
    gridCols: 2,
    gridWidth: 1000,
    isScrollMode: false,
    scrollRowHeight: 300,
    isEmpty: tabGroups.length === 0,
    showPlaceholder,
    placeholderInGrid: showPlaceholder,
    placeholderIndex: placeholderIndex ?? -1,
    focusedId: null,
    activeWorktreeId: worktreeId,
    isInTrash: () => false,
    layoutTransition: { duration: 0 },
    layoutAnimationEnabled,
    handleAddTabForPanel: async () => {},
    gridScrollRoot: null,
    setGridScrollRoot: () => {},
    isMacroFocused: false,
    handleGridRegionKeyDown: () => {},
    isOver: false,
  };
}

function view() {
  return (
    <DndContext>
      <ContentGrid />
    </DndContext>
  );
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
    expect(lifecycle.unmounts).not.toContain(id);
  }
}

function gridNode(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>("#panel-grid");
  if (!node) throw new Error("grid is not rendered");
  return node;
}

// Direct grid items in DOM order: a panel cell by its id, the split divider as
// "divider", anything else by its test id.
function gridOrder(container: HTMLElement): string[] {
  return Array.from(gridNode(container).children).map((child) =>
    child.getAttribute("role") === "separator"
      ? "divider"
      : (child.getAttribute("data-terminal-id") ?? child.getAttribute("data-testid") ?? "?")
  );
}

// "minmax(0, 0.7fr) 6px minmax(0, 0.3fr)" -> ["minmax(0, 0.7fr)", "6px", ...]
function gridTracks(container: HTMLElement): string[] {
  return (
    gridNode(container).style.gridTemplateColumns.match(/minmax\([^)]*\)|repeat\(.*\)|\S+/g) ?? []
  );
}

function fractionOf(track: string | undefined): number {
  const match = /^minmax\(0, ([\d.]+)fr\)$/.exec(track ?? "");
  return match ? Number(match[1]) : Number.NaN;
}

function isSplitGrid(container: HTMLElement): boolean {
  return gridNode(container).getAttribute("data-split-mode") === "true";
}

describe("ContentGrid panel identity across layout changes (#12476)", () => {
  beforeEach(() => {
    lifecycle.unmounts.length = 0;
    split.commitRatioIfChanged.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("keeps later panels mounted when an earlier grid panel closes", () => {
    setGrid({ cells: ["a", "b", "c", "d"] });
    const { container, rerender } = render(view());
    const before = snapshot(container, ["b", "c", "d"]);

    setGrid({ cells: ["b", "c", "d"] });
    rerender(view());

    expect(gridOrder(container)).toEqual(["b", "c", "d"]);
    expectSurvivors(container, before, ["b", "c", "d"]);
    expect(lifecycle.unmounts).toEqual(["a"]);
  });

  it("keeps earlier panels mounted when a later grid panel closes", () => {
    setGrid({ cells: ["a", "b", "c", "d"] });
    const { container, rerender } = render(view());
    const before = snapshot(container, ["a", "b", "c"]);

    setGrid({ cells: ["a", "b", "c"] });
    rerender(view());

    expectSurvivors(container, before, ["a", "b", "c"]);
    expect(lifecycle.unmounts).toEqual(["d"]);
  });

  it("keeps a tab group's active panel mounted when a neighbouring cell closes", () => {
    setGrid({ cells: ["x", ["p", "q"], "y"] });
    const { container, rerender } = render(view());
    const before = snapshot(container, ["p", "y"]);

    setGrid({ cells: [["p", "q"], "y"] });
    rerender(view());

    expectSurvivors(container, before, ["p", "y"]);
    expect(lifecycle.unmounts).toEqual(["x"]);
  });

  it.each([
    ["first", ["b", "c"]],
    ["middle", ["a", "c"]],
    ["last", ["a", "b"]],
  ])("keeps the survivors mounted when closing the %s of three enters split mode", (_, rest) => {
    setGrid({ cells: ["a", "b", "c"] });
    const { container, rerender } = render(view());
    const before = snapshot(container, rest);
    expect(isSplitGrid(container)).toBe(false);

    // The close lands with layout animation suppressed, then re-enables it.
    setGrid({ cells: rest, split: true, layoutAnimationEnabled: false });
    rerender(view());
    expect(isSplitGrid(container)).toBe(true);
    expectSurvivors(container, before, rest);

    setGrid({ cells: rest, split: true });
    rerender(view());

    expect(gridOrder(container)).toEqual([rest[0], "divider", rest[1]]);
    expectSurvivors(container, before, rest);
    expect(lifecycle.unmounts).toHaveLength(1);
  });

  it("lays the split out with the controller's template and drops it on exit", () => {
    setGrid({ cells: ["a", "b"], split: true });
    const { container, rerender } = render(view());

    const [left, divider, right] = gridTracks(container);
    expect(fractionOf(left)).toBeCloseTo(splitState.config.defaultRatio);
    expect(divider).toBe(`${DIVIDER_WIDTH_PX}px`);
    expect(fractionOf(right)).toBeCloseTo(1 - splitState.config.defaultRatio);

    setGrid({ cells: ["a", "b", "c"] });
    rerender(view());

    expect(isSplitGrid(container)).toBe(false);
    expect(gridTracks(container)).not.toContain(`${DIVIDER_WIDTH_PX}px`);
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  // Press on the divider and move without releasing, so the ratio stays pending
  // in the controller rather than committed to the store.
  function holdDividerDrag(divider: HTMLElement) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 600 })
    );
    fireEvent.mouseDown(divider, { button: 0, clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 760 });
  }

  it("flushes a pending divider ratio to its own split when another split replaces it", () => {
    setGrid({ cells: ["a", "b"], split: true });
    const { container, getByRole, rerender } = render(view());

    // A held drag is what leaves a ratio pending; a key step commits at once.
    holdDividerDrag(getByRole("separator"));
    const pending = fractionOf(gridTracks(container)[0]);
    expect(pending).toBeGreaterThan(splitState.config.defaultRatio);
    expect(split.commitRatioIfChanged).not.toHaveBeenCalled();

    setGrid({ cells: ["c", "d"], split: true, worktreeId: "wt2" });
    rerender(view());

    expect(split.commitRatioIfChanged).toHaveBeenCalledTimes(1);
    expect(split.commitRatioIfChanged).toHaveBeenCalledWith("wt1", pending, ["a", "b"]);
    expect(fractionOf(gridTracks(container)[0])).toBeCloseTo(splitState.config.defaultRatio);
  });

  it("keeps the split controller when the same pair re-renders", () => {
    setGrid({ cells: ["a", "b"], split: true });
    const { getByRole, rerender } = render(view());
    const divider = getByRole("separator");
    holdDividerDrag(divider);

    setGrid({ cells: ["a", "b"], split: true });
    rerender(view());

    expect(getByRole("separator")).toBe(divider);
    expect(split.commitRatioIfChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["first", "a", "b"],
    ["second", "b", "a"],
  ])("keeps the survivor mounted when closing the %s split pane", (_, closed, survivor) => {
    setGrid({ cells: ["a", "b"], split: true });
    const { container, rerender } = render(view());
    const before = snapshot(container, [survivor]);

    setGrid({ cells: [survivor] });
    rerender(view());

    expect(isSplitGrid(container)).toBe(false);
    expect(gridOrder(container)).toEqual([survivor]);
    expectSurvivors(container, before, [survivor]);
    expect(lifecycle.unmounts).toEqual([closed]);
  });

  it("keeps both panes mounted when split mode turns off and back on", () => {
    setGrid({ cells: ["a", "b"], split: true });
    const { container, rerender } = render(view());
    const before = snapshot(container, ["a", "b"]);

    setGrid({ cells: ["a", "b"] });
    rerender(view());
    expect(isSplitGrid(container)).toBe(false);

    setGrid({ cells: ["a", "b"], split: true });
    rerender(view());

    expect(isSplitGrid(container)).toBe(true);
    expectSurvivors(container, before, ["a", "b"]);
    expect(lifecycle.unmounts).toEqual([]);
  });

  it("keeps each split pane bound to its own panel when the pair reorders", () => {
    setGrid({ cells: ["a", "b"], split: true });
    const { container, rerender } = render(view());
    const before = snapshot(container, ["a", "b"]);

    setGrid({ cells: ["b", "a"], split: true });
    rerender(view());

    expect(gridOrder(container)).toEqual(["b", "divider", "a"]);
    expectSurvivors(container, before, ["a", "b"]);
    expect(panelNode(container, "a").getAttribute("data-initial-id")).toBe("a");
    expect(panelNode(container, "b").getAttribute("data-initial-id")).toBe("b");
  });

  it("keeps the drag placeholder and the panels mounted as it moves to the end", () => {
    setGrid({ cells: ["a", "b", "c"], placeholderIndex: 1 });
    const { container, rerender } = render(view());
    const before = snapshot(container, ["a", "b", "c"]);
    expect(gridOrder(container)).toEqual(["a", "grid-placeholder", "b", "c"]);
    const placeholder = container.querySelector('[data-testid="grid-placeholder"]');

    setGrid({ cells: ["a", "b", "c"], placeholderIndex: 3 });
    rerender(view());

    expect(gridOrder(container)).toEqual(["a", "b", "c", "grid-placeholder"]);
    expect(container.querySelector('[data-testid="grid-placeholder"]')).toBe(placeholder);
    expectSurvivors(container, before, ["a", "b", "c"]);
  });
});
