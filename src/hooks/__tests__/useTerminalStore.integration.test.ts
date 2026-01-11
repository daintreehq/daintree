/**
 * Integration tests for terminal store state management
 * Tests terminal lifecycle, state transitions, and location changes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const { useTerminalStore } = await import("../../store/terminalStore");
type AddTerminalOptions = any;

describe("Terminal Store Integration", () => {
  beforeEach(() => {
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    useTerminalStore.setState({
      terminals: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  describe("Terminal Addition", () => {
    it("should add terminal to store", async () => {
      const mockAddTerminal = vi.fn().mockResolvedValue("test-id-1");
      useTerminalStore.setState({ addTerminal: mockAddTerminal } as any);

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
      useTerminalStore.setState({ addTerminal: mockAddTerminal } as any);

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

      useTerminalStore.setState({
        addTerminal: async (options: AddTerminalOptions) => {
          const id = await mockAddTerminal(options);
          if (!options.location || options.location === "grid") {
            useTerminalStore.setState({ focusedId: id });
          }
          return id;
        },
      } as any);

      await useTerminalStore.getState().addTerminal({
        id: "test-id-3",
        type: "terminal",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      } as any);

      const { focusedId } = useTerminalStore.getState();
      expect(focusedId).toBe("test-id-3");
    });

    it("should not focus dock terminal", async () => {
      const mockAddTerminal = vi.fn().mockResolvedValue("test-id-4");

      useTerminalStore.setState({
        addTerminal: async (options: AddTerminalOptions) => {
          const id = await mockAddTerminal(options);
          if (!options.location || options.location === "grid") {
            useTerminalStore.setState({ focusedId: id });
          }
          return id;
        },
      } as any);

      await useTerminalStore.getState().addTerminal({
        id: "test-id-4",
        type: "terminal",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "dock",
      } as any);

      const { focusedId } = useTerminalStore.getState();
      expect(focusedId).not.toBe("test-id-4");
    });
  });

  describe("Terminal Location Changes", () => {
    beforeEach(() => {
      useTerminalStore.setState({
        terminals: [
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
        ],
        focusedId: "term-1",
      });
    });

    it("should move terminal to dock", () => {
      const mockMoveToDock = vi.fn((id: string) => {
        const state = useTerminalStore.getState();
        const terminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "dock" as const } : t
        );

        const updates: any = { terminals };

        if (state.focusedId === id) {
          const gridTerminals = terminals.filter((t) => t.id !== id && t.location === "grid");
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }

        useTerminalStore.setState(updates);
      });

      useTerminalStore.setState({ moveTerminalToDock: mockMoveToDock });
      mockMoveToDock("term-1");

      const { terminals, focusedId } = useTerminalStore.getState();
      expect(terminals.find((t) => t.id === "term-1")?.location).toBe("dock");
      expect(focusedId).toBe("term-2");
    });

    it("should move terminal to grid", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "dock",
          },
        ],
      });

      const mockMoveToGrid = vi.fn((id: string) => {
        const state = useTerminalStore.getState();
        const terminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "grid" as const } : t
        );
        useTerminalStore.setState({ terminals, focusedId: id });
        return true;
      });

      useTerminalStore.setState({ moveTerminalToGrid: mockMoveToGrid });
      mockMoveToGrid("term-1");

      const { terminals, focusedId } = useTerminalStore.getState();
      expect(terminals.find((t) => t.id === "term-1")?.location).toBe("grid");
      expect(focusedId).toBe("term-1");
    });
  });

  describe("Terminal Trash and Restore", () => {
    beforeEach(() => {
      useTerminalStore.setState({
        terminals: [
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
        ],
        focusedId: "term-1",
      });
    });

    it("should move terminal to trash", () => {
      const mockTrash = vi.fn((id: string) => {
        const state = useTerminalStore.getState();
        const terminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "trash" as const } : t
        );

        const updates: any = { terminals };

        if (state.focusedId === id) {
          const gridTerminals = terminals.filter((t) => t.id !== id && t.location === "grid");
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }

        useTerminalStore.setState(updates);
      });

      useTerminalStore.setState({ trashTerminal: mockTrash });
      mockTrash("term-1");

      const { terminals, focusedId } = useTerminalStore.getState();
      expect(terminals.find((t) => t.id === "term-1")?.location).toBe("trash");
      expect(focusedId).toBe("term-2");
    });

    it("should restore terminal from trash", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "trash",
          },
        ],
      });

      const mockRestore = vi.fn((id: string) => {
        const terminals = useTerminalStore
          .getState()
          .terminals.map((t) => (t.id === id ? { ...t, location: "grid" as const } : t));
        useTerminalStore.setState({ terminals, focusedId: id });
      });

      useTerminalStore.setState({ restoreTerminal: mockRestore });
      mockRestore("term-1");

      const { terminals, focusedId } = useTerminalStore.getState();
      expect(terminals.find((t) => t.id === "term-1")?.location).toBe("grid");
      expect(focusedId).toBe("term-1");
    });

    it("should clear maximized state when trashing maximized terminal", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        focusedId: "term-1",
        maximizedId: "term-1",
      });

      const mockTrash = vi.fn((id: string) => {
        const state = useTerminalStore.getState();
        const terminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "trash" as const } : t
        );

        const updates: any = { terminals };

        if (state.focusedId === id) {
          const gridTerminals = terminals.filter((t) => t.id !== id && t.location === "grid");
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }

        if (state.maximizedId === id) {
          updates.maximizedId = null;
        }

        useTerminalStore.setState(updates);
      });

      useTerminalStore.setState({ trashTerminal: mockTrash });
      mockTrash("term-1");

      const { maximizedId } = useTerminalStore.getState();
      expect(maximizedId).toBeNull();
    });
  });

  describe("Agent State Management", () => {
    beforeEach(() => {
      useTerminalStore.setState({
        terminals: [
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
        ],
      });
    });

    it("should update agent state", () => {
      const { terminals } = useTerminalStore.getState();

      useTerminalStore.setState({
        terminals: terminals.map((t) =>
          t.id === "term-1" ? { ...t, agentState: "working" as const } : t
        ),
      });

      const updated = useTerminalStore.getState().terminals.find((t) => t.id === "term-1");
      expect(updated?.agentState).toBe("working");
    });

    it("should track agent state transitions", () => {
      const states: ("idle" | "working" | "waiting" | "completed" | "failed")[] = [
        "working",
        "waiting",
        "working",
        "completed",
      ];

      states.forEach((state) => {
        const { terminals } = useTerminalStore.getState();
        useTerminalStore.setState({
          terminals: terminals.map((t) => (t.id === "term-1" ? { ...t, agentState: state } : t)),
        });
      });

      const final = useTerminalStore.getState().terminals.find((t) => t.id === "term-1");
      expect(final?.agentState).toBe("completed");
    });

    it("should handle error state", () => {
      const { terminals } = useTerminalStore.getState();

      useTerminalStore.setState({
        terminals: terminals.map((t) =>
          t.id === "term-1" ? { ...t, agentState: "failed" as const, error: "Test error" } : t
        ),
      });

      const updated = useTerminalStore.getState().terminals.find((t) => t.id === "term-1");
      expect(updated?.agentState).toBe("failed");
      expect(updated?.error).toBe("Test error");
    });
  });

  describe("Focus Management", () => {
    beforeEach(() => {
      useTerminalStore.setState({
        terminals: [
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
        ],
        focusedId: null,
      });
    });

    it("should set focused terminal", () => {
      useTerminalStore.setState({ focusedId: "term-1" });

      const { focusedId } = useTerminalStore.getState();
      expect(focusedId).toBe("term-1");
    });

    it("should change focused terminal", () => {
      useTerminalStore.setState({ focusedId: "term-1" });
      expect(useTerminalStore.getState().focusedId).toBe("term-1");

      useTerminalStore.setState({ focusedId: "term-2" });
      expect(useTerminalStore.getState().focusedId).toBe("term-2");
    });

    it("should clear focus", () => {
      useTerminalStore.setState({ focusedId: "term-1" });
      expect(useTerminalStore.getState().focusedId).toBe("term-1");

      useTerminalStore.setState({ focusedId: null });
      expect(useTerminalStore.getState().focusedId).toBeNull();
    });
  });

  describe("Terminal Metadata", () => {
    it("should store terminal metadata", () => {
      useTerminalStore.setState({
        terminals: [
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
        ],
      });

      const terminal = useTerminalStore.getState().terminals[0];
      expect(terminal.type).toBe("claude");
      expect(terminal.title).toBe("Claude Agent");
      expect(terminal.worktreeId).toBe("worktree-1");
      expect(terminal.agentState).toBe("working");
    });

    it("should update terminal metadata", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
      });

      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Updated Title",
            cwd: "/test",
            cols: 100,
            rows: 30,
            location: "grid",
          },
        ],
      });

      const terminal = useTerminalStore.getState().terminals[0];
      expect(terminal.title).toBe("Updated Title");
      expect(terminal.cols).toBe(100);
      expect(terminal.rows).toBe(30);
    });
  });
});
