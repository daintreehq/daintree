import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
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
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

const { useTerminalStore } = await import("../../../terminalStore");

function addMockTerminal(id: string, location: "grid" | "dock" = "grid") {
  useTerminalStore.setState((state) => ({
    terminals: [
      ...state.terminals,
      {
        id,
        title: id,
        kind: "browser" as const,
        type: "terminal" as const,
        location,
        worktreeId: "wt-1",
        isVisible: true,
      } as import("../types").TerminalInstance,
    ],
  }));
}

describe("restoreTerminalOrder", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    await reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reorders terminals to match the given ID list", () => {
    addMockTerminal("browser-1");
    addMockTerminal("term-1");
    addMockTerminal("term-2");
    addMockTerminal("term-3");

    // Saved order was: term-1, term-2, term-3, browser-1
    useTerminalStore.getState().restoreTerminalOrder(["term-1", "term-2", "term-3", "browser-1"]);

    const ids = useTerminalStore.getState().terminals.map((t) => t.id);
    expect(ids).toEqual(["term-1", "term-2", "term-3", "browser-1"]);
  });

  it("places unmatched terminals after matched ones", () => {
    addMockTerminal("a");
    addMockTerminal("orphan");
    addMockTerminal("b");
    addMockTerminal("c");

    // orderedIds only includes a, b, c — orphan is not in saved state
    useTerminalStore.getState().restoreTerminalOrder(["c", "b", "a"]);

    const ids = useTerminalStore.getState().terminals.map((t) => t.id);
    expect(ids).toEqual(["c", "b", "a", "orphan"]);
  });

  it("is a no-op when order already matches", () => {
    addMockTerminal("a");
    addMockTerminal("b");
    addMockTerminal("c");

    const terminalsBefore = useTerminalStore.getState().terminals;
    useTerminalStore.getState().restoreTerminalOrder(["a", "b", "c"]);
    const terminalsAfter = useTerminalStore.getState().terminals;

    // Same reference means set() returned state (no-op)
    expect(terminalsBefore).toBe(terminalsAfter);
  });

  it("is a no-op with empty orderedIds", () => {
    addMockTerminal("a");

    const terminalsBefore = useTerminalStore.getState().terminals;
    useTerminalStore.getState().restoreTerminalOrder([]);
    const terminalsAfter = useTerminalStore.getState().terminals;

    expect(terminalsBefore).toBe(terminalsAfter);
  });

  it("gracefully ignores orderedIds not present in the store", () => {
    addMockTerminal("a");
    addMockTerminal("b");

    useTerminalStore.getState().restoreTerminalOrder(["nonexistent", "b", "a"]);

    const ids = useTerminalStore.getState().terminals.map((t) => t.id);
    expect(ids).toEqual(["b", "a"]);
  });
});
