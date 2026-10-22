// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SidebarViewSwitcherContext } from "@/components/Sidebar/sidebarViewContext";
import { SortableWorktreeTerminal } from "../SortableWorktreeTerminal";
import { useDragHandle } from "../DragHandleContext";
import type { PanelInstance } from "@shared/types/panel";

let mockIsDragging = false;
const mockSetActivatorNodeRef = vi.fn();
const sortableArgs = vi.hoisted(() => ({ last: null as { disabled?: unknown } | null }));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: (args: { disabled?: unknown }) => {
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
