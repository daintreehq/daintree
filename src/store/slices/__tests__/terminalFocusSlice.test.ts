import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTerminalFocusSlice, type TerminalFocusSlice } from "../terminalFocusSlice";
import type { TerminalInstance } from "../terminalRegistrySlice";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    wake: vi.fn(),
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: vi.fn(() => ({
      activeWorktreeId: "worktree-1",
      trackTerminalFocus: vi.fn(),
      selectWorktree: vi.fn(),
    })),
  },
}));

describe("TerminalFocusSlice - Layout Snapshot", () => {
  const mockTerminals: TerminalInstance[] = [
    {
      id: "term-1",
      title: "Terminal 1",
      type: "claude",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-2",
      title: "Terminal 2",
      type: "terminal",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
  ] as TerminalInstance[];

  const getTerminals = vi.fn(() => mockTerminals);

  // Mock getPanelGroup that returns undefined (no group)
  const mockGetPanelGroup = vi.fn(() => undefined);

  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    state = createTerminalFocusSlice(getTerminals)(setState, getState, {} as never);
  });

  it("should capture layout snapshot when maximizing", () => {
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
  });

  it("should not capture snapshot when unmaximizing", () => {
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };

    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should clear snapshot when terminal is removed", () => {
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.handleTerminalRemoved("term-1", [mockTerminals[1]], 0);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should clear snapshot via clearPreMaximizeLayout", () => {
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.clearPreMaximizeLayout();

    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should not capture snapshot when gridCols or gridItemCount is undefined", () => {
    state.toggleMaximize("term-1", undefined, undefined, mockGetPanelGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("should preserve snapshot across multiple maximize/restore cycles", () => {
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroup);

    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });

    state.toggleMaximize("term-1", undefined, undefined, mockGetPanelGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });
});

describe("TerminalFocusSlice - Tab Group Maximize", () => {
  const mockTerminals: TerminalInstance[] = [
    {
      id: "term-1",
      title: "Terminal 1",
      type: "claude",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-2",
      title: "Terminal 2",
      type: "terminal",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-3",
      title: "Terminal 3",
      type: "terminal",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
  ] as TerminalInstance[];

  const mockGroup = {
    id: "group-1",
    panelIds: ["term-1", "term-2"],
    location: "grid" as const,
  };

  const getTerminals = vi.fn(() => mockTerminals);

  // Mock getPanelGroup that returns a group for term-1 and term-2
  const mockGetPanelGroupWithGroup = vi.fn((panelId: string) => {
    if (panelId === "term-1" || panelId === "term-2") {
      return mockGroup;
    }
    return undefined;
  });

  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    state = createTerminalFocusSlice(getTerminals)(setState, getState, {} as never);
  });

  it("should maximize entire group when panel is in a group with multiple panels", () => {
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroupWithGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
  });

  it("should unmaximize group when clicking any panel in the maximized group", () => {
    // First maximize term-1 (which is in group-1)
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroupWithGroup);
    expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });

    // Now click term-2 (also in group-1) - should unmaximize
    state.toggleMaximize("term-2", 2, 4, mockGetPanelGroupWithGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should maximize as single panel when panel is not in any group", () => {
    state.toggleMaximize("term-3", 2, 4, mockGetPanelGroupWithGroup);

    expect(state.maximizedId).toBe("term-3");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-3" });
  });

  it("should maximize as single panel when getPanelGroup returns single-panel group", () => {
    const singlePanelGroup = {
      id: "group-single",
      panelIds: ["term-3"],
      location: "grid" as const,
    };
    const mockGetSinglePanelGroup = vi.fn((panelId: string) => {
      if (panelId === "term-3") {
        return singlePanelGroup;
      }
      return undefined;
    });

    state.toggleMaximize("term-3", 2, 4, mockGetSinglePanelGroup);

    expect(state.maximizedId).toBe("term-3");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-3" });
  });

  it("should work without getPanelGroup (backwards compatibility)", () => {
    state.toggleMaximize("term-1", 2, 4);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
  });

  it("should unmaximize group when getPanelGroup is omitted but panel ID matches", () => {
    // First maximize with group
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroupWithGroup);
    expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });

    // Now toggle again without getPanelGroup - should still unmaximize
    state.toggleMaximize("term-1", 2, 4);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should downgrade group maximize to panel when group shrinks to single panel", () => {
    const singlePanelGroup = {
      id: "group-1",
      panelIds: ["term-1"],
      location: "grid" as const,
    };
    const mockGetShrunkGroup = vi.fn((panelId: string) => {
      if (panelId === "term-1") {
        return singlePanelGroup;
      }
      return undefined;
    });
    const mockGetTerminal = vi.fn((id: string) => mockTerminals.find((t) => t.id === id));

    // First maximize a multi-panel group
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-1" };

    // Now validate with a shrunk group (only 1 panel)
    state.validateMaximizeTarget(mockGetShrunkGroup, mockGetTerminal);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
  });

  it("should clear maximize when group is deleted", () => {
    const mockGetTerminal = vi.fn((id: string) => mockTerminals.find((t) => t.id === id));
    const mockGetNoGroup = vi.fn(() => undefined);

    // Maximize a group
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-1" };

    // Now validate with group gone
    state.validateMaximizeTarget(mockGetNoGroup, mockGetTerminal);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should clear maximize when panel is moved to trash", () => {
    const trashedTerminal = { ...mockTerminals[0], location: "trash" as const };
    const mockGetTerminal = vi.fn((id: string) =>
      id === "term-1" ? trashedTerminal : mockTerminals.find((t) => t.id === id)
    );
    const mockGetPanelGroup = vi.fn(() => undefined);

    // Maximize a panel
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };

    // Now validate with panel in trash
    state.validateMaximizeTarget(mockGetPanelGroup, mockGetTerminal);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });
});
