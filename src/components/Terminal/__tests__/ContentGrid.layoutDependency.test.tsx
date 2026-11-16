// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { PanelInstance, TabGroup } from "@shared/types/panel";
import type { ContentGridContext } from "../useContentGridContext";
import { ContentGrid } from "../ContentGrid";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

// #17049: framer-motion re-measures every FLIP wrapper and restarts its 200ms
// animation whenever `layoutDependency` changes. Continuous geometry (container
// width, split ratio, scroll-mode row height) changes on every frame of a
// window, sidebar or divider drag, so it must not reach the key; the discrete
// shape of the grid must.

const grid = vi.hoisted(() => ({ ctx: {} as Partial<ContentGridContext> }));

const splitState = vi.hoisted(() => ({
  ratioByWorktreeId: {},
  config: { enabled: true, defaultRatio: 0.7, preferPreview: false },
  commitRatioIfChanged: () => {},
  resetWorktreeRatio: () => {},
  setWorktreeRatio: () => {},
}));

// The real motion wrapper never writes its dependency to the DOM; this one
// does, so the key every panel would be measured against is readable.
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  function MotionDiv({
    layout: _layout,
    layoutDependency,
    transition: _transition,
    transformTemplate: _transformTemplate,
    animate: _animate,
    children,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) {
    return (
      <div
        {...rest}
        data-layout-dependency={
          layoutDependency === undefined ? undefined : String(layoutDependency)
        }
      >
        {children}
      </div>
    );
  }
  return { ...actual, m: { div: MotionDiv } };
});

vi.mock("../useContentGridContext", () => ({
  useContentGridContext: () => ({
    ctx: grid.ctx,
    bindCombinedGrid: () => {},
    bindGridRegion: () => {},
  }),
  pixelSnapTransform: () => "none",
}));

vi.mock("../GridPanel", () => ({
  GridPanel: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="grid-panel" data-panel={terminalId} />
  ),
}));
vi.mock("../GridTabGroup", () => ({
  GridTabGroup: ({ group }: { group: TabGroup }) => (
    <div data-testid="grid-panel" data-panel={group.activeTabId} />
  ),
}));

vi.mock("@/store", () => ({
  useTwoPaneSplitStore: <T,>(selector: (state: typeof splitState) => T) => selector(splitState),
}));
vi.mock("@/store/twoPaneSplitStore", () => ({ resolveEffectiveRatio: () => undefined }));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: <T,>(selector: (state: { showAgentTaskTitles: boolean }) => T) =>
    selector({ showAgentTaskTitles: false }),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: <T,>(selector: (state: { worktrees: Map<string, unknown> }) => T) =>
    selector({ worktrees: new Map() }),
}));
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    lockResize: () => {},
    runResizePass: () => {},
    scheduleBatchResize: () => {},
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});
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
vi.mock("../ContentGridMaximizedGroup", () => ({ ContentGridMaximizedGroup: () => null }));
vi.mock("../ContentGridMaximizedSingle", () => ({ ContentGridMaximizedSingle: () => null }));
vi.mock("@/components/Plugin/ProjectPluginTrustBanner", () => ({
  ProjectPluginTrustBanner: () => null,
}));
vi.mock("@/components/Project/ProjectPresentationNotice", () => ({
  ProjectPresentationNotice: () => null,
}));
vi.mock("@/components/Project/ProjectThemeNotice", () => ({ ProjectThemeNotice: () => null }));
vi.mock("@/components/Plugin/ProjectLayoutSeedNotice", () => ({
  ProjectLayoutSeedNotice: () => null,
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
  gridCols?: number;
  gridWidth?: number;
  isScrollMode?: boolean;
  scrollRowHeight?: number;
  split?: boolean;
}

function setGrid({
  ids,
  gridCols = 2,
  gridWidth = 1000,
  isScrollMode = false,
  scrollRowHeight = 300,
  split = false,
}: GridFixture) {
  const tabGroups: TabGroup[] = ids.map((id) => ({
    id,
    location: "grid",
    worktreeId: "wt1",
    activeTabId: id,
    panelIds: [id],
  }));
  const panels = new Map(ids.map((id) => [id, panel(id)]));
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
    gridCols,
    gridWidth,
    isScrollMode,
    scrollRowHeight,
    isEmpty: ids.length === 0,
    showPlaceholder: false,
    placeholderInGrid: false,
    placeholderIndex: -1,
    focusedId: null,
    activeWorktreeId: "wt1",
    isInTrash: () => false,
    layoutTransition: { duration: 0 },
    layoutAnimationEnabled: true,
    handleAddTabForPanel: async () => {},
    gridScrollRoot: null,
    setGridScrollRoot: () => {},
    isMacroFocused: false,
    handleGridRegionKeyDown: () => {},
    isDropTarget: false,
  };
}

function setFleet({
  ids,
  fleetGridCols = 2,
  gridWidth = 1000,
}: {
  ids: string[];
  fleetGridCols?: number;
  gridWidth?: number;
}) {
  grid.ctx = {
    isFleetScopeRender: true,
    fleetPanels: ids.map(panel),
    fleetGridCols,
    fleetNeedsWorktreePrefix: false,
    gridWidth,
    focusedId: null,
    layoutTransition: { duration: 0 },
    layoutAnimationEnabled: true,
    isMacroFocused: false,
    handleGridRegionKeyDown: () => {},
  };
}

function view() {
  return (
    <DndContext>
      <ContentGrid />
    </DndContext>
  );
}

// Each panel's FLIP wrapper and the key it is measured against.
function dependencies(container: HTMLElement): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of container.querySelectorAll<HTMLElement>("[data-layout-dependency]")) {
    const id = node.querySelector("[data-panel]")?.getAttribute("data-panel");
    if (id) result.set(id, node.getAttribute("data-layout-dependency")!);
  }
  return result;
}

beforeAll(async () => {
  await loadTerminalService();
});

beforeEach(() => {
  splitState.config.defaultRatio = 0.7;
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
});

describe("grid FLIP dependency (#17049)", () => {
  it("holds steady while the container width moves within one column count", () => {
    setGrid({ ids: ["a", "b", "c"], gridWidth: 1000 });
    const { container, rerender } = render(view());
    const before = dependencies(container);
    expect(before.size).toBe(3);

    for (const gridWidth of [1001, 1180, 1400]) {
      setGrid({ ids: ["a", "b", "c"], gridWidth });
      rerender(view());
      expect(dependencies(container)).toEqual(before);
    }
  });

  it("changes when a width crosses into another column count", () => {
    setGrid({ ids: ["a", "b", "c"], gridCols: 2, gridWidth: 1400 });
    const { container, rerender } = render(view());
    const before = dependencies(container);

    setGrid({ ids: ["a", "b", "c"], gridCols: 3, gridWidth: 1401 });
    rerender(view());
    for (const [id, key] of dependencies(container)) expect(key).not.toBe(before.get(id));
  });

  it("holds steady while scroll-mode rows resize, and changes entering scroll mode", () => {
    const ids = ["a", "b", "c", "d", "e"];
    setGrid({ ids, isScrollMode: true, scrollRowHeight: 300 });
    const { container, rerender } = render(view());
    const scrolling = dependencies(container);

    setGrid({ ids, isScrollMode: true, scrollRowHeight: 342 });
    rerender(view());
    expect(dependencies(container)).toEqual(scrolling);

    setGrid({ ids, isScrollMode: false });
    rerender(view());
    expect(dependencies(container).get("a")).not.toBe(scrolling.get("a"));
  });

  it("holds steady while the split ratio moves, and changes entering or leaving the split", () => {
    setGrid({ ids: ["a", "b"] });
    const { container, rerender } = render(view());
    const unsplit = dependencies(container);

    setGrid({ ids: ["a", "b"], split: true });
    rerender(view());
    const split = dependencies(container);
    expect(split.get("a")).not.toBe(unsplit.get("a"));

    splitState.config.defaultRatio = 0.4;
    setGrid({ ids: ["a", "b"], split: true });
    rerender(view());
    expect(container.querySelector<HTMLElement>("#panel-grid")!.style.gridTemplateColumns).toMatch(
      /^minmax\(0, 0\.4fr\)/
    );
    expect(dependencies(container)).toEqual(split);

    setGrid({ ids: ["a", "b"] });
    rerender(view());
    expect(dependencies(container)).toEqual(unsplit);
  });

  it("changes when panels reorder", () => {
    setGrid({ ids: ["a", "b", "c"] });
    const { container, rerender } = render(view());
    const before = dependencies(container);

    setGrid({ ids: ["c", "a", "b"] });
    rerender(view());
    expect(dependencies(container).get("a")).not.toBe(before.get("a"));
  });
});

describe("fleet FLIP dependency (#17049)", () => {
  it("holds steady while the container width moves within one column count", () => {
    setFleet({ ids: ["a", "b", "c"], gridWidth: 1000 });
    const { container, rerender } = render(view());
    const before = dependencies(container);
    expect(before.size).toBe(3);

    setFleet({ ids: ["a", "b", "c"], gridWidth: 1240 });
    rerender(view());
    expect(dependencies(container)).toEqual(before);
  });

  it("changes with the column count and with membership", () => {
    setFleet({ ids: ["a", "b", "c"] });
    const { container, rerender } = render(view());
    const before = dependencies(container);

    setFleet({ ids: ["a", "b", "c"], fleetGridCols: 3 });
    rerender(view());
    const wider = dependencies(container);
    expect(wider.get("a")).not.toBe(before.get("a"));

    setFleet({ ids: ["a", "b"], fleetGridCols: 3 });
    rerender(view());
    expect(dependencies(container).get("a")).not.toBe(wider.get("a"));
  });
});
