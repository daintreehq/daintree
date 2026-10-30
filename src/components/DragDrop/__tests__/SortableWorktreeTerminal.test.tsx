// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { SidebarViewSwitcherContext } from "@/components/Sidebar/sidebarViewContext";
import { SortableWorktreeTerminal } from "../SortableWorktreeTerminal";
import { useDragHandle } from "../DragHandleContext";
import { usePanelStore } from "@/store/panelStore";
import type { PanelInstance, PanelLocation, TabGroup } from "@shared/types/panel";

let mockIsDragging = false;
const mockSetActivatorNodeRef = vi.fn();
const sortableArgs = vi.hoisted(() => ({
  last: null as { disabled?: unknown; data?: Record<string, unknown> } | null,
}));

// A real zustand store, so the row's selectors run under real subscriptions:
// an unstable selector result would loop here the way it would in the app.
// `getPanelGroup` keeps the real one's location rule (tabGroups.ts): a group is
// only the panel's when it lives where the panel does.
vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  type Panel = import("@shared/types/panel").PanelInstance;
  type Group = import("@shared/types/panel").TabGroup;
  type Trashed = import("@/store/slices/panelRegistry/types").TrashedTerminal;
  const groupLocation = (panel: Panel | undefined) => {
    if (!panel) return null;
    if (panel.location === "grid" || panel.location === undefined) return "grid";
    return panel.location === "dock" ? "dock" : null;
  };
  const usePanelStore = create<{
    panelsById: Record<string, Panel>;
    trashedTerminals: Map<string, Trashed>;
    tabGroups: Map<string, Group>;
    getPanelGroup: (id: string) => Group | undefined;
  }>()((_set, get) => ({
    panelsById: {},
    trashedTerminals: new Map(),
    tabGroups: new Map(),
    getPanelGroup: (id) => {
      const { panelsById, tabGroups } = get();
      const location = groupLocation(panelsById[id]);
      return [...tabGroups.values()].find(
        (g) => g.panelIds.includes(id) && (location === null || location === g.location)
      );
    },
  }));
  return { usePanelStore };
});

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: (args: { disabled?: unknown; data?: Record<string, unknown> }) => {
    sortableArgs.last = args;
    return {
      attributes: { role: "button" },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef: vi.fn(),
      setActivatorNodeRef: mockSetActivatorNodeRef,
      transform: null,
      transition: undefined,
      isDragging: mockIsDragging,
    };
  },
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

const terminal: PanelInstance = {
  id: "t3",
  kind: "terminal",
  title: "Worktree Terminal",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "grid",
  isVisible: true,
} as PanelInstance;

// Stands in for SidebarViewHost: the worktree list is hidden while a plugin's
// sidebar view shows.
function underPluginView(children: ReactNode) {
  return (
    <SidebarViewSwitcherContext.Provider
      value={{
        options: [],
        activeId: "acme.beads.board",
        builtIn: { title: "Worktrees", icon: () => null },
        choose: () => {},
      }}
    >
      {children}
    </SidebarViewSwitcherContext.Provider>
  );
}

describe("SortableWorktreeTerminal", () => {
  const sibling = (id: string, location: PanelLocation = "grid"): PanelInstance => ({
    ...terminal,
    id,
    location,
  });
  const group = (id: string, panelIds: string[], location: "grid" | "dock" = "grid"): TabGroup => ({
    id,
    location,
    worktreeId: "wt1",
    activeTabId: panelIds[0]!,
    panelIds,
  });

  function seed(panels: PanelInstance[], tabGroups: TabGroup[], trashed: string[] = []) {
    usePanelStore.setState({
      panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
      tabGroups: new Map(tabGroups.map((g) => [g.id, g])),
      trashedTerminals: new Map(
        trashed.map((id) => [id, { id, expiresAt: 0, originalLocation: "grid" }])
      ),
    });
  }

  function resetCapture() {
    sortableArgs.last = null;
  }

  /** The payload of the render this call makes, never a stale earlier one. */
  function renderRow() {
    resetCapture();
    const view = render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <span />
      </SortableWorktreeTerminal>
    );
    expect(sortableArgs.last).not.toBeNull();
    return { data: sortableArgs.last?.data, ...view };
  }

  beforeEach(() => {
    seed([terminal], []);
  });

  // The worktree move takes a grouped row's whole tab group (#14962), so the
  // drag has to say so before release, the same way a grid or dock group drag does.
  it("carries its tab group's live members so the drag shows the whole group goes", () => {
    seed(
      [terminal, sibling("t4"), sibling("t5"), sibling("t6"), sibling("t7"), sibling("o1")],
      [group("other", ["o1", "t7"]), group("g-build", ["t4", "t3", "t5", "t6"])],
      ["t5"]
    );

    const { data } = renderRow();
    expect(data?.groupId).toBe("g-build");
    expect(data?.groupPanelIds).toEqual(["t4", "t3", "t6"]);
  });

  it("drags as a single panel when ungrouped or the only live member left", () => {
    const ungrouped = renderRow();
    expect(ungrouped.data).not.toHaveProperty("groupId");
    expect(ungrouped.data).not.toHaveProperty("groupPanelIds");
    ungrouped.unmount();

    seed([terminal, sibling("t4", "trash")], [group("g1", ["t3", "t4", "gone"])]);
    const lastLive = renderRow();
    expect(lastLive.data).not.toHaveProperty("groupId");
    expect(lastLive.data).not.toHaveProperty("groupPanelIds");
  });

  it("ignores a group that lives somewhere other than the row's panel", () => {
    seed([terminal, sibling("t4", "dock")], [group("g-dock", ["t3", "t4"], "dock")]);
    expect(renderRow().data).not.toHaveProperty("groupId");
  });

  it("follows membership changes while mounted", () => {
    seed([terminal, sibling("t4")], [group("g1", ["t3", "t4"])]);
    renderRow();
    expect(sortableArgs.last?.data?.groupPanelIds).toEqual(["t3", "t4"]);

    act(() => {
      seed([terminal, sibling("t4"), sibling("t5")], [group("g1", ["t3", "t4", "t5"])]);
    });
    expect(sortableArgs.last?.data?.groupPanelIds).toEqual(["t3", "t4", "t5"]);
  });

  it("stops taking drops while the worktree list is hidden behind a plugin's sidebar view", () => {
    const chip = (
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <span />
      </SortableWorktreeTerminal>
    );
    const { unmount } = render(chip);
    expect(sortableArgs.last?.disabled).toEqual({ draggable: false, droppable: false });
    unmount();
    render(underPluginView(chip));
    expect(sortableArgs.last?.disabled).toEqual({ draggable: false, droppable: true });
  });

  it("forwards setActivatorNodeRef and listeners through DragHandleProvider for keyboard a11y", () => {
    mockIsDragging = false;
    let captured: ReturnType<typeof useDragHandle> = null;
    function Probe() {
      captured = useDragHandle();
      return null;
    }
    render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <Probe />
      </SortableWorktreeTerminal>
    );
    expect(captured).not.toBeNull();
    expect(captured!.setActivatorNodeRef).toBe(mockSetActivatorNodeRef);
    expect(captured!.listeners).toBeDefined();
  });
});
