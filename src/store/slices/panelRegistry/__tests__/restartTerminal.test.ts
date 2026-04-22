import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSpawn = vi.fn().mockResolvedValue({ id: "test-1" });
const mockKill = vi.fn().mockResolvedValue(undefined);

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: mockSpawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: mockKill,
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    gracefulKill: vi.fn().mockResolvedValue(null),
    submit: vi.fn().mockResolvedValue(undefined),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
    suppressNextExit: vi.fn(),
    get: vi.fn().mockReturnValue({ terminal: { cols: 80, rows: 24 } }),
    waitForInstance: vi.fn().mockResolvedValue(undefined),
    fit: vi.fn(),
    captureBufferText: vi.fn().mockReturnValue(""),
    addAgentStateListener: vi.fn().mockReturnValue(vi.fn()),
  },
}));

vi.mock("@/store/restartExitSuppression", () => ({
  markTerminalRestarting: vi.fn(),
  unmarkTerminalRestarting: vi.fn(),
}));

vi.mock("@/store/projectStore", () => ({
  setPanelStoreGetter: vi.fn(),
  setWorktreeSelectionStoreGetter: vi.fn(),
  setFleetArmingClear: vi.fn(),
  useProjectStore: {
    getState: () => ({ currentProject: { id: "proj-1" } }),
  },
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: vi.fn().mockReturnValue(true),
}));

vi.mock("@/utils/terminalValidation", () => ({
  validateTerminalConfig: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
}));

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: (type: string) => type === "claude" || type === "gemini",
  getAgentConfig: vi.fn().mockReturnValue({ command: "claude" }),
  getAgentIds: () => ["claude", "gemini", "codex"],
  getMergedPreset: vi.fn().mockReturnValue(undefined),
  sanitizeAgentEnv: (env: Record<string, string> | undefined) => env,
}));

vi.mock("@shared/types", () => ({
  generateAgentCommand: vi.fn().mockReturnValue("claude"),
  buildAgentLaunchFlags: vi.fn().mockReturnValue([]),
  buildResumeCommand: vi.fn().mockReturnValue(null),
  buildLaunchCommandFromFlags: vi.fn().mockReturnValue("claude --flag"),
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: {
    getState: () => ({ ccrPresetsByAgent: {} }),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

const agentPanelBase = {
  id: "test-1",
  type: "claude" as const,
  kind: "terminal" as const,
  agentId: "claude",
  agentLaunchFlags: ["--persisted-flag"],
  title: "Claude",
  cwd: "/some/path",
  command: "/bin/zsh",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  worktreeId: "wt-1",
};

describe("restartTerminal agent-exited demotion (#5764)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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

  it("restarts as plain shell when agent has exited", async () => {
    const demoted = { ...agentPanelBase, agentState: "exited" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.kind).toBe("terminal");
    expect(payload.type).toBe("terminal");
    expect(payload.agentId).toBeUndefined();
    expect(payload.command).toBeUndefined();
    expect(payload.agentLaunchFlags).toBeUndefined();
    expect(payload.agentModelId).toBeUndefined();
  });

  it("restarts as plain shell when PTY exited from idle state (exitCode set)", async () => {
    // AgentStateMachine never transitions idle->exited on PTY exit, so the
    // FSM leaves agentState as "idle" while exitCode is set. The restart
    // guard must still treat this as demoted.
    const idleExited = { ...agentPanelBase, agentState: "idle" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [idleExited.id]: idleExited },
      panelIds: [idleExited.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.kind).toBe("terminal");
    expect(payload.type).toBe("terminal");
    expect(payload.agentId).toBeUndefined();
    expect(payload.command).toBeUndefined();
    expect(payload.agentLaunchFlags).toBeUndefined();
  });

  it("restarts as agent terminal when agent is still active (working)", async () => {
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.kind).toBe("terminal");
    expect(payload.type).toBe("claude");
    expect(payload.agentId).toBe("claude");
    expect(payload.agentLaunchFlags).toEqual(["--persisted-flag"]);
  });

  it("preserves agentId on the panel after demoted restart (launch identity)", async () => {
    const demoted = { ...agentPanelBase, agentState: "exited" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"];
    expect(after?.agentId).toBe("claude");
  });

  it("preserves agentState: exited across repeated demoted restarts", async () => {
    // Without this, the first demoted restart clears agentState, and the
    // next restart relaunches the agent because the guard sees no exit
    // signal (exitCode is also cleared on restart).
    const demoted = { ...agentPanelBase, agentState: "exited" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const afterFirst = usePanelStore.getState().panelsById["test-1"];
    expect(afterFirst?.agentState).toBe("exited");

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const secondPayload = mockSpawn.mock.calls[1]![0];
    expect(secondPayload.kind).toBe("terminal");
    expect(secondPayload.agentId).toBeUndefined();
    expect(secondPayload.command).toBeUndefined();
  });

  it("clears persisted command on demoted restart so future spawns use default shell", async () => {
    const demoted = {
      ...agentPanelBase,
      command: "claude --model sonnet",
      agentState: "exited" as const,
      exitCode: 0,
    };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"];
    expect(after?.command).toBeUndefined();
  });
});
