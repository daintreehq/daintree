/**
 * Integration tests for terminal store state management
 * Tests terminal lifecycle, state transitions, and location changes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../store/panelStore");
import type { TerminalInstance } from "@shared/types";
import type { AddPanelOptions } from "../../store/panelStore";
type MockTerminal = Partial<TerminalInstance> & { id: string };

function setTerminals(terminals: MockTerminal[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])) as Record<
      string,
      TerminalInstance
    >,
    panelIds: terminals.map((t) => t.id),
  });
}

function getTerminals() {
  const state = usePanelStore.getState();
  return state.panelIds.map((id: string) => state.panelsById[id]);
}

describe("Terminal Store Integration", () => {
  beforeEach(() => {
    const { reset } = usePanelStore.getState();
    reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  describe("Terminal Addition", () => {
    it("should add terminal to store", async () => {
      const mockAddTerminal = vi.fn().mockResolvedValue("test-id-1");
      usePanelStore.setState({
        addPanel: mockAddTerminal as unknown as ReturnType<
          typeof usePanelStore.getState
        >["addPanel"],
      });

      await mockAddTerminal({
        id: "test-id-1",
        type: "terminal",
        cwd: "/test",
        cols: 80,
        rows: 24,
      });

      expect(mockAddTerminal).toHaveBeenCalled();
    });

    it("should add terminal with worktree ID", async () => {
      const mockAddTerminal = vi.fn().mockResolvedValue("test-id-2");
      usePanelStore.setState({
        addPanel: mockAddTerminal as unknown as ReturnType<
          typeof usePanelStore.getState
        >["addPanel"],
      });

      await mockAddTerminal({
        id: "test-id-2",
        type: "claude",
        cwd: "/test/worktree",
        cols: 80,
        rows: 24,
        worktreeId: "worktree-1",
      });

      expect(mockAddTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: "worktree-1",
        })
      );
    });

    it("should set focus to newly added grid terminal", async () => {
      const mockAddTerminal = vi.fn().mockResolvedValue("test-id-3");

      usePanelStore.setState({
        addPanel: (async (options: AddPanelOptions) => {
          const id = await mockAddTerminal(options);
          if (!options.location || options.location === "grid") {
            usePanelStore.setState({ focusedId: id });
          }
          return id;
        }) as unknown as ReturnType<typeof usePanelStore.getState>["addPanel"],
      });

      await usePanelStore.getState().addPanel({
        id: "test-id-3",
        type: "terminal",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      } as AddPanelOptions);

      const { focusedId } = usePanelStore.getState();
      expect(focusedId).toBe("test-id-3");
    });

    it("should not focus dock terminal", async () => {
      const mockAddTerminal = vi.fn().mockResolvedValue("test-id-4");

      usePanelStore.setState({
        addPanel: (async (options: AddPanelOptions) => {
          const id = await mockAddTerminal(options);
          if (!options.location || options.location === "grid") {
            usePanelStore.setState({ focusedId: id });
          }
          return id;
        }) as unknown as ReturnType<typeof usePanelStore.getState>["addPanel"],
      });

      await usePanelStore.getState().addPanel({
        id: "test-id-4",
        type: "terminal",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "dock",
      } as AddPanelOptions);

      const { focusedId } = usePanelStore.getState();
      expect(focusedId).not.toBe("test-id-4");
    });
  });

  describe("Terminal Location Changes", () => {
    beforeEach(() => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ]);
      usePanelStore.setState({ focusedId: "term-1" });
    });

    it("should move terminal to dock", () => {
      const mockMoveToDock = vi.fn((id: string) => {
        const state = usePanelStore.getState();
        const terminals = state.panelIds.map((tid: string) => {
          const t = state.panelsById[tid];
          return t.id === id ? { ...t, location: "dock" as const } : t;
        });

        const updates: Record<string, unknown> = {
          panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
          panelIds: terminals.map((t) => t.id),
        };

        if (state.focusedId === id) {
          const gridTerminals = terminals.filter((t) => t.id !== id && t.location === "grid");
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }

        usePanelStore.setState(updates);
      });

      usePanelStore.setState({ moveTerminalToDock: mockMoveToDock });
      mockMoveToDock("term-1");

      const terminals = getTerminals();
      const { focusedId } = usePanelStore.getState();
      expect(terminals.find((t: TerminalInstance) => t.id === "term-1")?.location).toBe("dock");
      expect(focusedId).toBe("term-2");
    });

    it("should move terminal to grid", () => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "dock",
        },
      ]);

      const mockMoveToGrid = vi.fn((id: string) => {
        const state = usePanelStore.getState();
        const terminals = state.panelIds.map((tid: string) => {
          const t = state.panelsById[tid];
          return t.id === id ? { ...t, location: "grid" as const } : t;
        });
        usePanelStore.setState({
          panelsById: Object.fromEntries(terminals.map((t: TerminalInstance) => [t.id, t])),
          panelIds: terminals.map((t: TerminalInstance) => t.id),
          focusedId: id,
        });
        return true;
      });

      usePanelStore.setState({ moveTerminalToGrid: mockMoveToGrid });
      mockMoveToGrid("term-1");

      const terminals = getTerminals();
      const { focusedId } = usePanelStore.getState();
      expect(terminals.find((t: TerminalInstance) => t.id === "term-1")?.location).toBe("grid");
      expect(focusedId).toBe("term-1");
    });
  });

  describe("Terminal Trash and Restore", () => {
    beforeEach(() => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ]);
      usePanelStore.setState({ focusedId: "term-1" });
    });

    it("should move terminal to trash", () => {
      const mockTrash = vi.fn((id: string) => {
        const state = usePanelStore.getState();
        const terminals = state.panelIds.map((tid: string) => {
          const t = state.panelsById[tid];
          return t.id === id ? { ...t, location: "trash" as const } : t;
        });

        const updates: Record<string, unknown> = {
          panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
          panelIds: terminals.map((t) => t.id),
        };

        if (state.focusedId === id) {
          const gridTerminals = terminals.filter((t) => t.id !== id && t.location === "grid");
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }

        usePanelStore.setState(updates);
      });

      usePanelStore.setState({ trashPanel: mockTrash });
      mockTrash("term-1");

      const terminals = getTerminals();
      const { focusedId } = usePanelStore.getState();
      expect(terminals.find((t: TerminalInstance) => t.id === "term-1")?.location).toBe("trash");
      expect(focusedId).toBe("term-2");
    });

    it("should restore terminal from trash", () => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "trash",
        },
      ]);

      const mockRestore = vi.fn((id: string) => {
        const state = usePanelStore.getState();
        const terminals = state.panelIds.map((tid: string) => {
          const t = state.panelsById[tid];
          return t.id === id ? { ...t, location: "grid" as const } : t;
        });
        usePanelStore.setState({
          panelsById: Object.fromEntries(terminals.map((t: TerminalInstance) => [t.id, t])),
          panelIds: terminals.map((t: TerminalInstance) => t.id),
          focusedId: id,
        });
      });

      usePanelStore.setState({ restoreTerminal: mockRestore });
      mockRestore("term-1");

      const terminals = getTerminals();
      const { focusedId } = usePanelStore.getState();
      expect(terminals.find((t: TerminalInstance) => t.id === "term-1")?.location).toBe("grid");
      expect(focusedId).toBe("term-1");
    });

    it("should clear maximized state when trashing maximized terminal", () => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ]);
      usePanelStore.setState({
        focusedId: "term-1",
        maximizedId: "term-1",
      });

      const mockTrash = vi.fn((id: string) => {
        const state = usePanelStore.getState();
        const terminals = state.panelIds.map((tid: string) => {
          const t = state.panelsById[tid];
          return t.id === id ? { ...t, location: "trash" as const } : t;
        });

        const updates: Record<string, unknown> = {
          panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
          panelIds: terminals.map((t) => t.id),
        };

        if (state.focusedId === id) {
          const gridTerminals = terminals.filter((t) => t.id !== id && t.location === "grid");
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }

        if (state.maximizedId === id) {
          updates.maximizedId = null;
        }

        usePanelStore.setState(updates);
      });

      usePanelStore.setState({ trashPanel: mockTrash });
      mockTrash("term-1");

      const { maximizedId } = usePanelStore.getState();
      expect(maximizedId).toBeNull();
    });
  });

  describe("Agent State Management", () => {
    beforeEach(() => {
      setTerminals([
        {
          id: "term-1",
          type: "claude",
          title: "Claude",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          agentState: "idle",
        },
      ]);
    });

    it("should update agent state", () => {
      const state = usePanelStore.getState();
      const terminal = state.panelsById["term-1"];

      usePanelStore.setState({
        panelsById: {
          ...state.panelsById,
          "term-1": { ...terminal, agentState: "working" as const },
        },
      });

      const updated = usePanelStore.getState().panelsById["term-1"];
      expect(updated?.agentState).toBe("working");
    });

    it("should track agent state transitions", () => {
      const states: ("idle" | "working" | "waiting" | "completed")[] = [
        "working",
        "waiting",
        "working",
        "completed",
      ];

      states.forEach((agentState) => {
        const curState = usePanelStore.getState();
        const terminal = curState.panelsById["term-1"];
        usePanelStore.setState({
          panelsById: {
            ...curState.panelsById,
            "term-1": { ...terminal, agentState },
          },
        });
      });

      const final = usePanelStore.getState().panelsById["term-1"];
      expect(final?.agentState).toBe("completed");
    });

    it("should handle completed state", () => {
      const state = usePanelStore.getState();
      const terminal = state.panelsById["term-1"];

      usePanelStore.setState({
        panelsById: {
          ...state.panelsById,
          "term-1": { ...terminal, agentState: "completed" as const },
        },
      });

      const updated = usePanelStore.getState().panelsById["term-1"];
      expect(updated?.agentState).toBe("completed");
    });
  });

  describe("Focus Management", () => {
    beforeEach(() => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ]);
      usePanelStore.setState({ focusedId: null });
    });

    it("should set focused terminal", () => {
      usePanelStore.setState({ focusedId: "term-1" });

      const { focusedId } = usePanelStore.getState();
      expect(focusedId).toBe("term-1");
    });

    it("should change focused terminal", () => {
      usePanelStore.setState({ focusedId: "term-1" });
      expect(usePanelStore.getState().focusedId).toBe("term-1");

      usePanelStore.setState({ focusedId: "term-2" });
      expect(usePanelStore.getState().focusedId).toBe("term-2");
    });

    it("should clear focus", () => {
      usePanelStore.setState({ focusedId: "term-1" });
      expect(usePanelStore.getState().focusedId).toBe("term-1");

      usePanelStore.setState({ focusedId: null });
      expect(usePanelStore.getState().focusedId).toBeNull();
    });
  });

  describe("Terminal Metadata", () => {
    it("should store terminal metadata", () => {
      setTerminals([
        {
          id: "term-1",
          type: "claude",
          title: "Claude Agent",
          cwd: "/test/worktree",
          cols: 120,
          rows: 30,
          location: "grid",
          worktreeId: "worktree-1",
          agentState: "working",
        },
      ]);

      const terminal = usePanelStore.getState().panelsById["term-1"];
      expect(terminal.type).toBe("claude");
      expect(terminal.title).toBe("Claude Agent");
      expect(terminal.worktreeId).toBe("worktree-1");
      expect(terminal.agentState).toBe("working");
    });

    it("should update terminal metadata", () => {
      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Shell",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ]);

      setTerminals([
        {
          id: "term-1",
          type: "terminal",
          title: "Updated Title",
          cwd: "/test",
          cols: 100,
          rows: 30,
          location: "grid",
        },
      ]);

      const terminal = usePanelStore.getState().panelsById["term-1"];
      expect(terminal.title).toBe("Updated Title");
      expect(terminal.cols).toBe(100);
      expect(terminal.rows).toBe(30);
    });
  });
});
