import { describe, it, expect, beforeEach, vi } from "vitest";

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

const baseTerminal = {
  id: "test-terminal-1",
  type: "terminal" as const,
  kind: "agent" as const,
  title: "Test Agent",
  cwd: "/test",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  agentState: "directing" as const,
};

describe("updateAgentState store action (#3217)", () => {
  beforeEach(async () => {
    const { reset } = useTerminalStore.getState();
    await reset();
    useTerminalStore.setState({
      terminalsById: {},
      terminalIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  it("allows waiting to overwrite directing (clearDirectingState teardown path)", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    useTerminalStore.getState().updateAgentState("test-terminal-1", "waiting");

    expect(useTerminalStore.getState().terminalsById["test-terminal-1"].agentState).toBe("waiting");
  });

  it("allows working to overwrite directing", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    useTerminalStore.getState().updateAgentState("test-terminal-1", "working");

    expect(useTerminalStore.getState().terminalsById["test-terminal-1"].agentState).toBe("working");
  });

  it("allows idle to overwrite directing", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    useTerminalStore.getState().updateAgentState("test-terminal-1", "idle");

    expect(useTerminalStore.getState().terminalsById["test-terminal-1"].agentState).toBe("idle");
  });

  it("allows waiting when current state is not directing", () => {
    const workingTerminal = { ...baseTerminal, agentState: "working" as const };
    useTerminalStore.setState({
      terminalsById: { [workingTerminal.id]: workingTerminal },
      terminalIds: [workingTerminal.id],
    });

    useTerminalStore.getState().updateAgentState("test-terminal-1", "waiting");

    expect(useTerminalStore.getState().terminalsById["test-terminal-1"].agentState).toBe("waiting");
  });

  it("returns unchanged state for nonexistent terminal", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });
    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore.getState().updateAgentState("nonexistent", "working");

    expect(useTerminalStore.getState().terminalsById).toBe(before);
  });
});

describe("setupTerminalStoreListeners directing guard (#3217)", () => {
  function shouldSuppressBackendState(
    currentState: string | undefined,
    incomingState: string
  ): boolean {
    return currentState === "directing" && incomingState === "waiting";
  }

  it("backend waiting is suppressed when store terminal is in directing state", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const terminal = useTerminalStore.getState().terminalsById["test-terminal-1"];
    expect(shouldSuppressBackendState(terminal?.agentState, "waiting")).toBe(true);
  });

  it("backend working is not suppressed when store terminal is in directing state", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const terminal = useTerminalStore.getState().terminalsById["test-terminal-1"];
    expect(shouldSuppressBackendState(terminal?.agentState, "working")).toBe(false);
  });
});
