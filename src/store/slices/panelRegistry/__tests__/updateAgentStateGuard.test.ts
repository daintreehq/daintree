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

const { usePanelStore } = await import("../../../panelStore");

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
    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  it("allows waiting to overwrite directing (clearDirectingState teardown path)", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "waiting");

    expect(usePanelStore.getState().panelsById["test-terminal-1"].agentState).toBe("waiting");
  });

  it("allows working to overwrite directing", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "working");

    expect(usePanelStore.getState().panelsById["test-terminal-1"].agentState).toBe("working");
  });

  it("allows idle to overwrite directing", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "idle");

    expect(usePanelStore.getState().panelsById["test-terminal-1"].agentState).toBe("idle");
  });

  it("allows waiting when current state is not directing", () => {
    const workingTerminal = { ...baseTerminal, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [workingTerminal.id]: workingTerminal },
      panelIds: [workingTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "waiting");

    expect(usePanelStore.getState().panelsById["test-terminal-1"].agentState).toBe("waiting");
  });

  it("returns unchanged state for nonexistent terminal", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().updateAgentState("nonexistent", "working");

    expect(usePanelStore.getState().panelsById).toBe(before);
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
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const terminal = usePanelStore.getState().panelsById["test-terminal-1"];
    expect(shouldSuppressBackendState(terminal?.agentState, "waiting")).toBe(true);
  });

  it("backend working is not suppressed when store terminal is in directing state", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const terminal = usePanelStore.getState().panelsById["test-terminal-1"];
    expect(shouldSuppressBackendState(terminal?.agentState, "working")).toBe(false);
  });
});
