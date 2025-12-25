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
    state.toggleMaximize("term-1", 2, 4);

    expect(state.maximizedId).toBe("term-1");
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
  });

  it("should not capture snapshot when unmaximizing", () => {
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };
    state.maximizedId = "term-1";

    state.toggleMaximize("term-1", 2, 4);

    expect(state.maximizedId).toBe(null);
  });

  it("should clear snapshot when terminal is removed", () => {
    state.maximizedId = "term-1";
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.handleTerminalRemoved("term-1", [mockTerminals[1]], 0);

    expect(state.maximizedId).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should clear snapshot via clearPreMaximizeLayout", () => {
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.clearPreMaximizeLayout();

    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should not capture snapshot when gridCols or gridItemCount is undefined", () => {
    state.toggleMaximize("term-1", undefined, undefined);

    expect(state.maximizedId).toBe("term-1");
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("should preserve snapshot across multiple maximize/restore cycles", () => {
    state.toggleMaximize("term-1", 2, 4);

    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
    expect(state.maximizedId).toBe("term-1");

    state.toggleMaximize("term-1");

    expect(state.maximizedId).toBe(null);
  });
});
