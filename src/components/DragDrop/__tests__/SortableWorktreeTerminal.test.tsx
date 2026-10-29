// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SidebarViewSwitcherContext } from "@/components/Sidebar/sidebarViewContext";
import { SortableWorktreeTerminal } from "../SortableWorktreeTerminal";
import { useDragHandle } from "../DragHandleContext";
import type { PanelInstance } from "@shared/types/panel";

let mockIsDragging = false;
const mockSetActivatorNodeRef = vi.fn();
const sortableArgs = vi.hoisted(() => ({
  last: null as { disabled?: unknown; data?: Record<string, unknown> } | null,
}));

const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  trashedTerminals: new Map<string, unknown>(),
  groups: [] as { id: string; panelIds: string[] }[],
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      panelsById: panelState.panelsById,
      trashedTerminals: panelState.trashedTerminals,
      getPanelGroup: (id: string) => panelState.groups.find((g) => g.panelIds.includes(id)),
    }),
}));

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
  beforeEach(() => {
    panelState.panelsById = { t3: terminal };
    panelState.trashedTerminals = new Map();
    panelState.groups = [];
  });

  function renderRow() {
    render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <span />
      </SortableWorktreeTerminal>
    );
    return sortableArgs.last?.data;
  }

  // The worktree move takes a grouped row's whole tab group (#14962), so the
  // drag has to say so before release, the same way a grid or dock group drag does.
  it("carries its tab group's live members so the drag shows the whole group goes", () => {
    panelState.panelsById = {
      t3: terminal,
      t4: { ...terminal, id: "t4" },
      t5: { ...terminal, id: "t5" },
    };
    panelState.trashedTerminals = new Map([["t5", {}]]);
    panelState.groups = [{ id: "g1", panelIds: ["t4", "t3", "t5"] }];

    const data = renderRow();
    expect(data?.groupId).toBe("g1");
    expect(data?.groupPanelIds).toEqual(["t4", "t3"]);
  });

  it("drags as a single panel when ungrouped or the only live member left", () => {
    expect(renderRow()).not.toHaveProperty("groupId");

    panelState.groups = [{ id: "g1", panelIds: ["t3", "gone"] }];
    const data = renderRow();
    expect(data).not.toHaveProperty("groupId");
    expect(data).not.toHaveProperty("groupPanelIds");
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
