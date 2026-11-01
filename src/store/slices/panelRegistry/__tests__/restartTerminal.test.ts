import { beforeAll, describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";

const mockSpawn = vi.fn().mockResolvedValue({ id: "test-1" });
const mockKill = vi.fn().mockResolvedValue(undefined);
const mockGracefulKill = vi.fn().mockResolvedValue(null);
const getMergedPresetMock = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
const buildAgentLaunchFlagsMock = vi.hoisted(() => vi.fn().mockReturnValue([]));
const reconcileBypassFlagsMock = vi.hoisted(() => vi.fn((flags: readonly string[]) => [...flags]));

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
    updateTitle: vi.fn(),
    gracefulKill: mockGracefulKill,
    submit: vi.fn().mockResolvedValue(undefined),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
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
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    suppressNextExit: vi.fn(),
    get: vi.fn().mockReturnValue({ terminal: { cols: 80, rows: 24 } }),
    waitForInstance: vi.fn().mockResolvedValue(undefined),
    fit: vi.fn(),
    invalidatePtyGrid: vi.fn(),
    captureBufferText: vi.fn().mockReturnValue(""),
    addAgentStateListener: vi.fn().mockReturnValue(vi.fn()),
    setInputLocked: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/store/restartExitSuppression", () => ({
  markTerminalRestarting: vi.fn(),
  unmarkTerminalRestarting: vi.fn(),
}));

vi.mock("@/store/projectStore", () => ({
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
  getMergedPreset: (...args: unknown[]) => getMergedPresetMock(...args),
  sanitizeAgentEnv: (env: Record<string, string> | undefined) => env,
}));

vi.mock("@shared/types", async () => {
  const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
  return {
    ...actual,
    generateAgentCommand: vi.fn().mockReturnValue("claude"),
    buildAgentLaunchFlags: (...args: unknown[]) => buildAgentLaunchFlagsMock(...args),
    buildResumeCommand: vi.fn().mockReturnValue(null),
    buildResumeLatestCommand: vi.fn().mockReturnValue(null),
    buildLaunchCommandFromFlags: vi.fn().mockReturnValue("claude --flag"),
    // Identity reconcile keeps persisted flags verbatim so these dispatch-path
    // tests stay focused on restart wiring rather than bypass reconciliation
    // (#10432, covered by agentSettings.test.ts and statePatcher.test.ts).
    reconcileBypassFlags: (flags: readonly string[]) => reconcileBypassFlagsMock(flags),
    resolveEffectiveBypass: () => false,
  };
});

const notifyRetiredModelDroppedMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/terminal/retiredModelNotice", () => ({
  notifyRetiredModelDropped: notifyRetiredModelDroppedMock,
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: {
    getState: () => ({ ccrPresetsByAgent: {} }),
  },
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: {
    getState: () => ({ presetsByAgent: {} }),
  },
}));

const { usePanelStore } = await import("../../../panelStore");
const { load: loadTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

const agentPanelBase = {
  id: "test-1",
  kind: "terminal" as const,
  launchAgentId: "claude",
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
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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
    expect(payload.launchAgentId).toBeUndefined();
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
    expect(payload.launchAgentId).toBeUndefined();
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
    expect(payload.launchAgentId).toBe("claude");
    expect(payload.agentLaunchFlags).toEqual(["--persisted-flag"]);
  });

  it("holds a restart to the pane's required plugin tools, and shows a refusal as the spawn banner (#14096)", async () => {
    const { ClientAppError } = await import("@/utils/clientAppError");
    const tools = [
      { pluginInstanceId: "acme.tools", pluginDisplayName: "Acme", state: "pending-load" as const },
    ];
    mockSpawn.mockRejectedValueOnce(
      new ClientAppError("REQUIRED_PLUGIN_TOOLS_UNAVAILABLE", "refused", "Not ready.", {
        code: "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE",
        tools,
      })
    );
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      requiredPluginTools: ["acme.tools"],
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].requiredPluginTools).toEqual(["acme.tools"]);
    expect(mockSpawn.mock.calls[0]![0].allowMissingPluginTools).toBeUndefined();
    const panel = usePanelStore.getState().panelsById["test-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("expected the PTY panel to remain");
    expect(panel.restartError).toBeUndefined();
    expect(panel.isRestarting).toBe(false);
    expect(panel.spawnStatus).toBe("failed");
    expect(panel.agentState).toBe("exited");
    expect(panel.spawnError).toEqual({
      code: "REQUIRED_PLUGIN_TOOLS",
      message: "Not ready.",
      pluginTools: tools,
    });

    // Starting without them is the user's choice for that one launch only.
    await usePanelStore.getState().restartTerminal("test-1", { allowMissingPluginTools: true });
    expect(mockSpawn.mock.calls[1]![0].allowMissingPluginTools).toBe(true);
    expect(mockSpawn.mock.calls[1]![0].requiredPluginTools).toEqual(["acme.tools"]);
    await usePanelStore.getState().restartTerminal("test-1");
    expect(mockSpawn.mock.calls[2]![0].allowMissingPluginTools).toBeUndefined();
  });

  it("carries a launch context into a Claude restart, since the fresh bearer binds to it (#12486)", async () => {
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.actionContext).toMatchObject({
      activeWorktreeId: "wt-1",
      focusedWorktreeId: "wt-1",
      focusedTerminalId: "test-1",
      focusedTerminalKind: "terminal",
    });
  });

  it("sends no launch context when the restart demotes to a plain shell", async () => {
    const demoted = { ...agentPanelBase, agentState: "exited" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].actionContext).toBeUndefined();
  });

  it("restarts as agent terminal when a failed-to-start spawn is retried (#10816)", async () => {
    // A failed-to-start agent spawn carries agentState "exited" (so MCP read
    // paths report the crash) but no exitCode — it never ran. Retrying it must
    // relaunch the agent rather than demote to a shell.
    const failedToStart = {
      ...agentPanelBase,
      agentState: "exited" as const,
      spawnStatus: "failed" as const,
    };
    usePanelStore.setState({
      panelsById: { [failedToStart.id]: failedToStart },
      panelIds: [failedToStart.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.kind).toBe("terminal");
    expect(payload.launchAgentId).toBe("claude");
    expect(payload.agentLaunchFlags).toEqual(["--persisted-flag"]);
  });

  it("does not re-promote a demoted shell whose restart later fails to spawn (#10816 / #5764)", async () => {
    // A demoted shell (agent quit to its shell) keeps launchAgentId but has its
    // command cleared. If a subsequent restart fails to spawn, spawnStatus
    // becomes "failed" — but command is still undefined, so it must stay a shell
    // and NOT be reclassified as an agent.
    const demotedFailed = {
      ...agentPanelBase,
      command: undefined,
      agentState: "exited" as const,
      spawnStatus: "failed" as const,
    };
    usePanelStore.setState({
      panelsById: { [demotedFailed.id]: demotedFailed },
      panelIds: [demotedFailed.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.kind).toBe("terminal");
    expect(payload.launchAgentId).toBeUndefined();
  });

  it("reapplies preset env, color, IDs, and args when restarting an active agent terminal", async () => {
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: {
        claude: {
          globalEnv: { AGENT_GLOBAL: "g", SHARED: "agent" },
        },
      },
    });
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      environmentVariables: { PROJECT_ONLY: "p", SHARED: "project" },
    });
    getMergedPresetMock.mockReturnValue({
      id: "blue-provider",
      name: "Blue Provider",
      color: "#3366ff",
      env: { PRESET_ONLY: "preset", SHARED: "preset" },
      args: ["--provider", "blue"],
    });

    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentPresetId: "blue-provider",
      agentPresetColor: "#old",
      originalPresetId: "blue-provider",
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBe("claude");
    expect(payload.agentPresetId).toBe("blue-provider");
    expect(payload.originalAgentPresetId).toBe("blue-provider");
    expect(payload.agentLaunchFlags).toEqual(["--persisted-flag", "--provider", "blue"]);
    expect(payload.env).toEqual({
      PROJECT_ONLY: "p",
      AGENT_GLOBAL: "g",
      SHARED: "preset",
      PRESET_ONLY: "preset",
    });
    expect(
      (usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined)?.agentPresetColor
    ).toBe("#3366ff");
  });

  it("reapplies runtime settings env on demoted shell restart without relaunching the agent", async () => {
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: {
        claude: {
          globalEnv: { AGENT_GLOBAL: "g" },
        },
      },
    });
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      environmentVariables: { PROJECT_ONLY: "p" },
    });
    getMergedPresetMock.mockReturnValue({
      id: "blue-provider",
      name: "Blue Provider",
      color: "#3366ff",
      env: { PRESET_ONLY: "preset" },
    });

    const demoted = {
      ...agentPanelBase,
      agentState: "exited" as const,
      exitCode: 0,
      agentPresetId: "blue-provider",
      agentPresetColor: "#3366ff",
    };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBeUndefined();
    expect(payload.command).toBeUndefined();
    expect(payload.agentLaunchFlags).toBeUndefined();
    expect(payload.agentPresetId).toBe("blue-provider");
    expect(payload.env).toEqual({
      PROJECT_ONLY: "p",
      AGENT_GLOBAL: "g",
      PRESET_ONLY: "preset",
    });
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

    const afterFirst = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(afterFirst?.agentState).toBe("exited");

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const secondPayload = mockSpawn.mock.calls[1]![0];
    expect(secondPayload.kind).toBe("terminal");
    expect(secondPayload.launchAgentId).toBeUndefined();
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

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.command).toBeUndefined();
  });
});

describe("restartTerminal exit/demotion semantics (#5807)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  // Scenario 1: user ran `claude` inside a plain shell, then `/quit`ed. No
  // launch-intent agentId was ever set. Restart must spawn a plain shell.
  it("does not relaunch agent when quitting an agent in a plain shell", async () => {
    const plainShellWithDetectedAgent = {
      id: "test-1",
      kind: "terminal" as const,
      title: "Terminal",
      cwd: "/some/path",
      command: "/bin/zsh",
      cols: 80,
      rows: 24,
      location: "grid" as const,
      // Live detection fields cleared by onAgentExited listener; sticky flag
      // remains set. `agentId` was never sealed at spawn.
      everDetectedAgent: true,
      agentState: "exited" as const,
    };
    usePanelStore.setState({
      panelsById: { [plainShellWithDetectedAgent.id]: plainShellWithDetectedAgent },
      panelIds: [plainShellWithDetectedAgent.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.kind).toBe("terminal");
    expect(payload.launchAgentId).toBeUndefined();
    expect(payload.command).toBeUndefined();
  });

  // Scenario 2: cold-launched agent terminal (`launchAgentId: "claude"` sealed at
  // spawn). User typed `/quit` and the shell survived. onAgentExited must
  // preserve launchAgentId; the FSM-set `agentState: "exited"` drives the demoted
  // restart. Restart is a plain shell (user explicitly quit the agent), but
  // the panel's launch identity is preserved so that a subsequent deliberate
  // restart-as-agent is still possible.
  it("restarts cold-launched agent terminal as plain shell after subcommand exit, preserving launch identity", async () => {
    const coldLaunchedQuit = {
      id: "test-1",
      kind: "terminal" as const,
      launchAgentId: "claude",
      agentLaunchFlags: ["--persisted-flag"],
      title: "Claude",
      cwd: "/some/path",
      command: "claude",
      cols: 80,
      rows: 24,
      location: "grid" as const,
      // Demotion state: FSM saw the agent quit; PTY is still alive.
      agentState: "exited" as const,
      // `exitCode` is undefined — PTY did NOT exit, only the subcommand did.
    };
    usePanelStore.setState({
      panelsById: { [coldLaunchedQuit.id]: coldLaunchedQuit },
      panelIds: [coldLaunchedQuit.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBeUndefined();
    expect(payload.command).toBeUndefined();

    // Launch identity on the panel is preserved for future deliberate
    // restart-as-agent flows; agentState stays "exited" to keep demotion
    // sticky across repeat restarts (#5764).
    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.launchAgentId).toBe("claude");
    expect(after?.agentState).toBe("exited");
  });
});

describe("restartTerminal resume-latest fallback (#8787)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  it("uses resume-latest fallback when no session ID was captured", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --continue");
    // Active agent (working state) with NO session ID — graceful-shutdown
    // pattern match missed.
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: undefined,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeLatestCommand).toHaveBeenCalledWith("claude", ["--persisted-flag"]);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --continue");
  });

  it("prefers primary buildResumeCommand when session ID is present", async () => {
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --resume abc");
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --continue");
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: "abc",
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeCommand).toHaveBeenCalledWith("claude", "abc", ["--persisted-flag"]);
    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --resume abc");
  });

  it("does not call resume-latest when allowResumeLatest is false (worktree-move case)", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --continue");
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: undefined,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1", { allowResumeLatest: false });

    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    // Falls through to the existing fresh-launch path
    expect(payload.command).not.toBe("claude --continue");
  });

  it("falls through to fresh launch when no session ID and no resume-latest available", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: undefined,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeLatestCommand).toHaveBeenCalledOnce();
    const payload = mockSpawn.mock.calls[0]![0];
    // Existing fallback chain (persisted flags / generated command)
    expect(payload.command).toBeDefined();
    expect(payload.command).not.toBe("claude --continue");
  });
});

describe("restartTerminal and panes that run away from their conversation (#12434)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    mockGracefulKill.mockResolvedValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockResolvedValue({ agents: {} });
    vi.mocked(projectClient.getSettings).mockResolvedValue({ runCommands: [] });
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

  function ptyAfterRestart(): PtyPanelData {
    const panel = usePanelStore.getState().panelsById["test-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("restarted pane is gone");
    return panel;
  }

  const movedPane = {
    ...agentPanelBase,
    launchAgentId: "codex",
    cwd: "/worktrees/task-a",
    worktreeId: "/worktrees/task-a",
    conversationCwd: "/repo",
    agentState: "working" as const,
  };

  it("leaves a pane held for recovery untouched", async () => {
    const held: PtyPanelData = {
      ...movedPane,
      agentState: undefined,
      hasPty: false,
      restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
    };
    usePanelStore.setState({ panelsById: { [held.id]: held }, panelIds: [held.id] });
    // The store reset in `beforeEach` kills what the previous case left behind.
    mockKill.mockClear();

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
    expect(mockGracefulKill).not.toHaveBeenCalled();
    const after = ptyAfterRestart();
    expect(after.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    expect(after.isRestarting).toBeFalsy();
  });

  it("never runs resume-latest from a folder the conversation didn't begin in", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    vi.mocked(buildResumeLatestCommand).mockReturnValue("codex resume --last");
    usePanelStore.setState({
      panelsById: { [movedPane.id]: movedPane },
      panelIds: [movedPane.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    expect(mockSpawn.mock.calls[0]![0].command).not.toBe("codex resume --last");
    // A new conversation begins where the pane runs.
    const after = ptyAfterRestart();
    expect(after.conversationCwd).toBeUndefined();
  });

  it("forgets the conversation's folder when a fallback preset starts a new conversation", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    const pane = { ...movedPane, agentPresetId: "blue-provider" };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(mockSpawn).toHaveBeenCalled();
    expect(ptyAfterRestart().conversationCwd).toBeUndefined();
  });

  it("refuses a fallback hop for a pane held for recovery", async () => {
    // A resolvable preset, so only the hold can stop the hop.
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    const held: PtyPanelData = {
      ...movedPane,
      agentState: undefined,
      hasPty: false,
      restoreRecovery: { reason: "session-unresolved" },
    };
    usePanelStore.setState({ panelsById: { [held.id]: held }, panelIds: [held.id] });

    const result = await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(result).toEqual({ success: false, error: "panel is held for recovery" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(ptyAfterRestart().restoreRecovery).toEqual({ reason: "session-unresolved" });
    expect(ptyAfterRestart().isRestarting).toBeFalsy();
  });

  it("keeps pointing at the conversation's folder when it resumes that conversation", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("codex resume sess-a -C '.'");
    const pane = { ...movedPane, agentSessionId: "sess-a" };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("codex resume sess-a -C '.'");
    expect(payload.cwd).toBe("/worktrees/task-a");
    const after = ptyAfterRestart();
    expect(after.conversationCwd).toBe("/repo");
  });

  const restoredPane = {
    ...movedPane,
    restoreProvenance: {
      at: 5_000,
      disposition: "resume" as const,
      lastSeen: { agentState: "idle" as const, at: 4_000 },
    },
    launchedByPluginId: "acme.orchestrator",
    holdOnRestart: true as const,
  };

  it("drops restore's provenance on a restart, keeping the plugin's hold (#14017)", async () => {
    usePanelStore.setState({
      panelsById: { [restoredPane.id]: restoredPane },
      panelIds: [restoredPane.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = ptyAfterRestart();
    expect(after.restoreProvenance).toBeUndefined();
    expect(after.launchedByPluginId).toBe("acme.orchestrator");
    expect(after.holdOnRestart).toBe(true);
  });

  it("drops restore's provenance when a fallback preset relaunches the pane (#14017)", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    const pane = { ...restoredPane, agentPresetId: "blue-provider" };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(mockSpawn).toHaveBeenCalled();
    expect(ptyAfterRestart().restoreProvenance).toBeUndefined();
  });
});

describe("restartTerminal captured live-session resume", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    mockGracefulKill.mockResolvedValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
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

  it("resumes the exact session id captured by the graceful kill", async () => {
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("live-123");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --resume live-123");
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: undefined,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockGracefulKill).toHaveBeenCalledWith("test-1", { forRestart: true });
    expect(buildResumeCommand).toHaveBeenCalledWith("claude", "live-123", ["--persisted-flag"]);
    // Exact resume must preempt the resume-latest fallback — resume-latest
    // resolves to the most recently active session in scope, which with
    // several terminals of the same agent is often another pane's session.
    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --resume live-123");
    expect(payload.launchAgentId).toBe("claude");
  });

  it("keeps the pre-restart command durable when resuming a captured id", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("live-123");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --resume live-123");
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    // The resume command is transient: storing it durably would replay the
    // consumed session id on the next restart.
    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.command).toBe(agentPanelBase.command);
  });

  it("prefers the captured live id over a stale stored one", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("live-123");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockImplementation(
      (_agentId: string, sessionId: string) => `claude --resume ${sessionId}`
    );
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: "stale-abc",
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeCommand).toHaveBeenCalledWith("claude", "live-123", ["--persisted-flag"]);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --resume live-123");
  });

  it("discards the captured id when allowResumeLatest is false (worktree-move)", async () => {
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("live-123");
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: undefined,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1", { allowResumeLatest: false });

    // Fresh-launch intent: resuming would make the move flow's injected
    // history land in an already-loaded conversation.
    expect(buildResumeCommand).not.toHaveBeenCalled();
    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --flag");
  });

  it("falls back to bare kill and resume-latest when gracefulKill rejects", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    mockGracefulKill.mockRejectedValueOnce(new Error("ipc dead"));
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --continue");
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockKill).toHaveBeenCalledWith("test-1", { forRestart: true });
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --continue");
  });

  it("uses bare kill (not gracefulKill) for demoted terminals", async () => {
    const demoted = { ...agentPanelBase, agentState: "exited" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockGracefulKill).not.toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledWith("test-1", { forRestart: true });
  });

  it("bare-kills a failed-spawn retry the host has nothing for, after asking to capture", async () => {
    mockGracefulKill.mockResolvedValueOnce(null);
    const failedToStart = {
      ...agentPanelBase,
      agentState: "exited" as const,
      spawnStatus: "failed" as const,
    };
    usePanelStore.setState({
      panelsById: { [failedToStart.id]: failedToStart },
      panelIds: [failedToStart.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockGracefulKill).toHaveBeenCalledWith("test-1", { forRestart: true });
    // Nothing captured: the bare kill still runs the missing-terminal cleanup.
    expect(mockKill).toHaveBeenCalledWith("test-1", { forRestart: true });
    // The retry still relaunches as the agent (#10816).
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBe("claude");
  });

  it("resumes the session a failed-spawn pane's live agent was on, not the latest (#13915)", async () => {
    // A spawn whose answer was lost can be running on the host behind a failed
    // pane; Codex assigns no id at launch, so only the capture names its session.
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValueOnce("live-session-7");
    vi.mocked(buildResumeCommand).mockReturnValue("claude --resume live-session-7");
    vi.mocked(buildResumeLatestCommand).mockReturnValue("claude --continue");
    const failedButRunning = {
      ...agentPanelBase,
      agentState: "exited" as const,
      spawnStatus: "failed" as const,
    };
    usePanelStore.setState({
      panelsById: { [failedButRunning.id]: failedButRunning },
      panelIds: [failedButRunning.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockGracefulKill).toHaveBeenCalledWith("test-1", { forRestart: true });
    // Quit and captured: no second, bare kill of the restart.
    expect(mockKill).not.toHaveBeenCalledWith("test-1", { forRestart: true });
    expect(buildResumeCommand).toHaveBeenCalledWith("claude", "live-session-7", [
      "--persisted-flag",
    ]);
    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --resume live-session-7");
  });

  it("never degrades an exact candidate to resume-latest when its command is unbuildable", async () => {
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("live-123");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --continue");
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    // Resume-latest resolves to "most recent session in scope" — the safe
    // outcome for a known-but-unbuildable session is a fresh launch.
    expect(buildResumeCommand).toHaveBeenCalled();
    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --flag");
  });

  it("ignores the captured id when a different agent is live in the pane", async () => {
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("codex-session-9");
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --continue");
    // Claude-launched pane whose live detected identity is Codex: the
    // graceful shutdown quit (and captured a session from) Codex, so the id
    // must not be fed to `claude --resume`.
    const hijacked = {
      ...agentPanelBase,
      agentState: "working" as const,
      detectedAgentId: "codex" as const,
    };
    usePanelStore.setState({
      panelsById: { [hijacked.id]: hijacked },
      panelIds: [hijacked.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("claude --continue");
  });

  it("restores the captured session id for retry when the respawn fails", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    mockGracefulKill.mockResolvedValue("live-123");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue("claude --resume live-123");
    mockSpawn.mockRejectedValueOnce(new Error("spawn failed"));
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentSessionId: "stale-abc",
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.restartError).toBeDefined();
    // The consumed live id — not the stale stored one — must survive for the
    // retry to resume the same conversation.
    expect(after?.agentSessionId).toBe("live-123");
  });

  it("shows a refusal from main by its user message and keeps the spawn phase", async () => {
    mockGracefulKill.mockResolvedValue(null);
    mockSpawn.mockRejectedValueOnce(
      new Error(
        `[AppError|DRIVEN_ELSEWHERE|${encodeURIComponent(
          "This project is being driven from studio-01. Take it over to make changes."
        )}] terminal:spawn changes a project another window drives`
      )
    );
    usePanelStore.setState({
      panelsById: { [agentPanelBase.id]: { ...agentPanelBase, agentState: "exited" as const } },
      panelIds: [agentPanelBase.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.restartError?.message).toBe(
      "This project is being driven from studio-01. Take it over to make changes."
    );
    expect(after?.restartError?.message).not.toContain("[AppError");
    expect(after?.restartError?.context?.phase).toBe("pty-spawn");
  });
});

describe("restartTerminal stale flow state cleared (#9899)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    // clearAllMocks keeps implementations — undo any per-test overrides from
    // earlier suites.
    mockGracefulKill.mockResolvedValue(null);
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  it("clears flowStatus, flowStatusTimestamp, heldDurationMs, and re-derives runtimeStatus on restart", async () => {
    const paused = {
      ...agentPanelBase,
      agentState: "working" as const,
      isVisible: true,
      flowStatus: "paused-backpressure" as const,
      flowStatusTimestamp: 12345,
      heldDurationMs: 7000,
      runtimeStatus: "paused-backpressure" as const,
    };
    usePanelStore.setState({
      panelsById: { [paused.id]: paused },
      panelIds: [paused.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.flowStatus).toBeUndefined();
    expect(after?.flowStatusTimestamp).toBeUndefined();
    expect(after?.heldDurationMs).toBeUndefined();
    // Dock pills / tab labels read runtimeStatus directly — it must not keep
    // folding the now-cleared paused flow status.
    expect(after?.runtimeStatus).not.toBe("paused-backpressure");
  });

  it("brings an exited terminal back to running once it respawns", async () => {
    const exited = {
      ...agentPanelBase,
      agentState: "exited" as const,
      isVisible: true,
      exitCode: 1,
      runtimeStatus: "exited" as const,
    };
    usePanelStore.setState({
      panelsById: { [exited.id]: exited },
      panelIds: [exited.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.exitCode).toBeUndefined();
    expect(after?.runtimeStatus).toBe("running");
  });

  it("keeps a terminal whose respawn failed reading as exited", async () => {
    const exited = {
      ...agentPanelBase,
      agentState: "exited" as const,
      isVisible: true,
      exitCode: 1,
      runtimeStatus: "exited" as const,
    };
    usePanelStore.setState({
      panelsById: { [exited.id]: exited },
      panelIds: [exited.id],
    });
    mockSpawn.mockRejectedValueOnce(new Error("spawn failed: ENOENT"));

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.restartError).toBeDefined();
    expect(after?.runtimeStatus).toBe("exited");
  });

  it("relaunches an agent its host lost as the agent, not a demoted shell", async () => {
    // What hostTerminalResync leaves behind: exited, but no exit code was seen.
    const lost = {
      ...agentPanelBase,
      agentState: "working" as const,
      isVisible: true,
      runtimeStatus: "exited" as const,
    };
    usePanelStore.setState({
      panelsById: { [lost.id]: lost },
      panelIds: [lost.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls.at(-1)![0];
    expect(payload.launchAgentId).toBe("claude");
    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.runtimeStatus).toBe("running");
  });

  // Restarting is itself an acknowledgement of the lost session (#9802), and
  // dismissal now consumes the same flag (#11589) — so this clear is the other
  // half of that contract and must keep working.
  it("consumes the session-lost signal on restart (#9802)", async () => {
    const lost = {
      ...agentPanelBase,
      sessionLostOnRestore: "no-resume-command" as const,
    };
    usePanelStore.setState({
      panelsById: { [lost.id]: lost },
      panelIds: [lost.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    // Assert survival first — `after?.x` would read undefined for a panel that
    // vanished, which is not what this test is about.
    expect(after).toBeDefined();
    expect(after?.sessionLostOnRestore).toBeUndefined();
  });
});

describe("restartTerminal input lock + parallel IPC (#9164)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    // clearAllMocks keeps implementations — undo any per-test overrides from
    // earlier suites.
    mockGracefulKill.mockResolvedValue(null);
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  it("locks input before destroy and unlocks on successful restart", async () => {
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const setInputLocked = terminalInstanceService.setInputLocked as ReturnType<typeof vi.fn>;
    const destroy = terminalInstanceService.destroy as ReturnType<typeof vi.fn>;

    const calls: string[] = [];
    setInputLocked.mockImplementation((_id: string, locked: boolean) => {
      calls.push(locked ? "lock" : "unlock");
    });
    destroy.mockImplementation(() => {
      calls.push("destroy");
    });

    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    // First lock fires before destroy; re-lock fires after waitForInstance;
    // final unlock on success.
    expect(calls[0]).toBe("lock");
    expect(calls[1]).toBe("destroy");
    expect(calls).toContain("unlock");
    expect(calls[calls.length - 1]).toBe("unlock");

    // Exactly two lock(true) calls (pre-destroy + post-waitForInstance) and
    // one lock(false) on success.
    const lockTrueCalls = setInputLocked.mock.calls.filter((c) => c[1] === true);
    const lockFalseCalls = setInputLocked.mock.calls.filter((c) => c[1] === false);
    expect(lockTrueCalls).toHaveLength(2);
    expect(lockFalseCalls).toHaveLength(1);
  });

  it("unlocks input on failed restart so the instance is not permanently locked", async () => {
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const setInputLocked = terminalInstanceService.setInputLocked as ReturnType<typeof vi.fn>;

    // Make the spawn fail to drive the catch path.
    mockSpawn.mockRejectedValueOnce(new Error("spawn failed"));

    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    // The catch branch must unlock so the user can keep using the terminal.
    const lockFalseCalls = setInputLocked.mock.calls.filter((c) => c[1] === false);
    expect(lockFalseCalls.length).toBeGreaterThanOrEqual(1);
    expect(setInputLocked.mock.calls[setInputLocked.mock.calls.length - 1]?.[1]).toBe(false);
  });

  it("does not call the store setInputLocked action during restart (avoids persisting transient lock)", async () => {
    // The transient input lock during restart must go through the service
    // directly, NOT through the store action which persists to disk.
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    // isInputLocked must not be true on the persisted panel after a
    // successful restart.
    expect(after?.isInputLocked).not.toBe(true);
  });

  it("starts the kill IPC before awaiting buildRestartEnv IPCs (parallelization)", async () => {
    const { projectClient, globalEnvClient } = await import("@/clients");
    const projectSettings = projectClient.getSettings as ReturnType<typeof vi.fn>;
    const globalEnvGet = globalEnvClient.get as ReturnType<typeof vi.fn>;

    const order: string[] = [];
    // Agent restarts kill via gracefulKill (session-id capture). Hold the
    // kill promise open: if the env IPCs still start, they were launched in
    // parallel with the kill, not awaited after it.
    let resolveKill: (value: string | null) => void = () => {};
    mockGracefulKill.mockImplementationOnce(() => {
      order.push("kill-start");
      return new Promise<string | null>((resolve) => {
        resolveKill = resolve;
      });
    });
    projectSettings.mockImplementation(() => {
      order.push("project-settings-start");
      return Promise.resolve(null);
    });
    globalEnvGet.mockImplementation(() => {
      order.push("global-env-start");
      return Promise.resolve({});
    });

    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    const restartPromise = usePanelStore.getState().restartTerminal("test-1");

    await vi.waitFor(() => {
      expect(order).toContain("global-env-start");
    });
    expect(order).toContain("kill-start");
    // The kill is still pending, so nothing downstream of the Promise.all —
    // including spawn — may have run yet.
    expect(mockSpawn).not.toHaveBeenCalled();

    resolveKill(null);
    await restartPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

/**
 * A restart captures the panel, then awaits settings, presets and a kill before
 * it respawns. Renaming stays enabled throughout, and the kill drops the cached
 * spawn options, so the respawn payload is the only thing that can carry a
 * rename made in that window (#11830).
 */
describe("restartTerminal carries a rename that lands mid-restart", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    // Restored explicitly: `clearAllMocks` drops recorded calls but keeps an
    // implementation, so a rename hook set by one case would otherwise fire in
    // the next and quietly make the control case assert the wrong thing.
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockReset();
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  /** Rename at an await point the restart passes after capturing the panel. */
  async function renameDuringRestart(title: string, source?: "user" | "automation") {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      usePanelStore.getState().updateTitle("test-1", title, source);
      return {};
    });
  }

  it("respawns under the new name, not the one captured before the awaits", async () => {
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });
    await renameDuringRestart("Renamed mid-restart");

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.title).toBe("Renamed mid-restart");
    expect(payload.titleMode).toBe("user");
  });

  it("keeps the captured title when nothing renamed the panel", async () => {
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.title).toBe(agentPanelBase.title);
  });

  it("carries the automation rung across the restart too", async () => {
    const active = { ...agentPanelBase, agentState: "working" as const };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });
    await renameDuringRestart("Renamed by MCP", "automation");

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.title).toBe("Renamed by MCP");
    expect(payload.titleMode).toBe("custom");
  });
});

/**
 * A restart and a preset-fallback hop each respawn the id, and the pty-host
 * record they create is what the fleet palette groups by. Both used to omit
 * `worktreeId` from the spawn payload while the ledger write right above them
 * read it off the panel — so a restarted run lost its worktree for the rest of
 * its life and the palette filed it under "No worktree" (#12060).
 */
describe("restartTerminal carries the run's worktree onto the new pty record", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockReset();
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  it("respawns under the worktree the panel is filed in", async () => {
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      worktreeId: "/repo/.worktrees/feature",
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBe("/repo/.worktrees/feature");
  });

  it("respawns under a worktree adopted while the restart was awaiting", async () => {
    // Same window the mid-restart rename exploits: the panel is captured before
    // settings, presets and the kill are awaited, so a drag landing in that gap
    // has to be read at spawn time or the respawn undoes it.
    const active = { ...agentPanelBase, agentState: "working" as const, worktreeId: "wt-a" };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      usePanelStore.setState((state) => ({
        panelsById: {
          ...state.panelsById,
          "test-1": { ...state.panelsById["test-1"]!, worktreeId: "wt-b" },
        },
      }));
      return {};
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBe("wt-b");
  });

  it("does not resurrect the old worktree when the move mid-restart was a clear", async () => {
    // Pins the shape of the live read: `livePanel?.worktreeId ?? captured` would
    // pass every other case here and still restore "wt-1" for a panel the user
    // has just taken out of its worktree — the exact silent fallback the issue
    // bans, in the direction that is easiest to miss.
    const active = { ...agentPanelBase, agentState: "working" as const, worktreeId: "wt-1" };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      usePanelStore.setState((state) => {
        const next = { ...state.panelsById["test-1"]! };
        delete (next as { worktreeId?: string }).worktreeId;
        return { panelsById: { ...state.panelsById, "test-1": next } };
      });
      return {};
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBeUndefined();
  });

  it("carries the worktree across a preset fallback hop too", async () => {
    // The fallback hop is a second, independent respawn of the same id. It had
    // the identical omission, so a fix that only covers `restartTerminal` still
    // strands a fallen-back agent under "No worktree".
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      worktreeId: "/repo/.worktrees/feature",
      agentPresetId: "blue-provider",
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBe("/repo/.worktrees/feature");
  });

  it("leaves a genuinely worktree-less run without one rather than inventing a root", async () => {
    // The palette's "No worktree" bucket is for runs that really have none.
    // Back-filling a project root here would move them out of it and claim a
    // filing the run never had.
    const active = { ...agentPanelBase, agentState: "working" as const };
    delete (active as { worktreeId?: string }).worktreeId;
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBeUndefined();
  });
});

/**
 * A standing instruction comes from the launch caller, not from settings, so
 * the respawns that rebuild flags from settings have to carry it over (#12431).
 */
describe("restartTerminal keeps the launch's standing instruction", () => {
  const pair = ["--append-system-prompt", "Infer the best option"];

  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockImplementation(
      (_entry: unknown, _agentId: unknown, options?: { systemPromptArgs?: string[] }) => [
        "--rebuilt",
        ...(options?.systemPromptArgs ?? []),
      ]
    );
    // No saved settings: every rebuilt flag comes from the mock above.
    const { agentSettingsClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockReset();
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

  afterAll(() => {
    buildAgentLaunchFlagsMock.mockReset();
    buildAgentLaunchFlagsMock.mockReturnValue([]);
  });

  it("replays persisted flags unchanged on an ordinary restart", async () => {
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentLaunchFlags: ["--persisted-flag", ...pair],
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].agentLaunchFlags).toEqual(["--persisted-flag", ...pair]);
  });

  it("carries it through the rebuild when the panel's preset has gone stale", async () => {
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentPresetId: "deleted-preset",
      agentLaunchFlags: ["--provider", "gone", ...pair],
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.agentLaunchFlags).toEqual(["--rebuilt", ...pair]);
    expect(payload.agentLaunchFlags).not.toContain("gone");
    expect(usePanelStore.getState().panelsById["test-1"]).toMatchObject({
      agentLaunchFlags: ["--rebuilt", ...pair],
    });
  });

  it("carries it across a preset fallback hop", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentPresetId: "blue-provider",
      agentLaunchFlags: ["--provider", "blue", ...pair],
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    const { generateAgentCommand } = await import("@shared/types");
    expect(vi.mocked(generateAgentCommand)).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      "claude",
      expect.objectContaining({ systemPromptArgs: pair, presetArgs: ["--provider", "amber"] })
    );
    expect(mockSpawn.mock.calls[0]![0].agentLaunchFlags).toEqual(["--rebuilt", ...pair]);
  });
});

/**
 * Flags the `agent.launch` caller passed verbatim have no setting to be rebuilt
 * from, so every restart path re-appends them after the settings-derived part
 * (#13046).
 */
describe("restartTerminal keeps the caller's own launch flags", () => {
  const caller = ["--effort", "high"];

  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockImplementation(
      (_entry: unknown, _agentId: unknown, options?: { systemPromptArgs?: string[] }) => [
        "--rebuilt",
        ...(options?.systemPromptArgs ?? []),
      ]
    );
    const { agentSettingsClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockReset();
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

  afterAll(() => {
    buildAgentLaunchFlagsMock.mockReset();
    buildAgentLaunchFlagsMock.mockReturnValue([]);
  });

  it("re-appends them after the rebuild when the panel's preset has gone stale", async () => {
    const pair = ["--append-system-prompt", "Be terse"];
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentPresetId: "deleted-preset",
      agentLaunchFlags: ["--provider", "gone", ...pair, ...caller],
      callerLaunchFlags: caller,
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.agentLaunchFlags).toEqual(["--rebuilt", ...pair, ...caller]);
    expect(usePanelStore.getState().panelsById["test-1"]).toMatchObject({
      agentLaunchFlags: ["--rebuilt", ...pair, ...caller],
      callerLaunchFlags: caller,
    });
  });

  it("keeps them last when newly-added preset args are merged in", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      args: ["--provider", "amber"],
    });
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentPresetId: "amber-provider",
      agentLaunchFlags: ["--persisted-flag", ...caller],
      callerLaunchFlags: caller,
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].agentLaunchFlags).toEqual([
      "--persisted-flag",
      "--provider",
      "amber",
      ...caller,
    ]);
  });

  it("carries them into both the command and the flags across a preset fallback hop", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentPresetId: "blue-provider",
      agentLaunchFlags: ["--provider", "blue", ...caller],
      callerLaunchFlags: caller,
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.agentLaunchFlags).toEqual(["--rebuilt", ...caller]);
    expect(payload.command).toBe("claude --effort high");
  });

  // A caller-only snapshot is still a captured configuration: its (empty)
  // settings-derived part is reconciled, so a now-wanted bypass is injected
  // into the fresh launch rather than skipped.
  it("reconciles the empty settings-derived part of a caller-only snapshot", async () => {
    reconcileBypassFlagsMock.mockImplementationOnce((flags: readonly string[]) => [
      ...flags,
      "--bypass",
    ]);
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentLaunchFlags: caller,
      callerLaunchFlags: caller,
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith([]);
    expect(mockSpawn.mock.calls[0]![0].agentLaunchFlags).toEqual(["--bypass", ...caller]);
  });

  it("clears caller ownership the stored flags no longer end with", async () => {
    const active = {
      ...agentPanelBase,
      agentState: "working" as const,
      agentLaunchFlags: ["--effort", "high", "--persisted-flag"],
      callerLaunchFlags: caller,
    };
    usePanelStore.setState({ panelsById: { [active.id]: active }, panelIds: [active.id] });

    await usePanelStore.getState().restartTerminal("test-1");

    const panel = usePanelStore.getState().panelsById["test-1"];
    expect(panel).toMatchObject({ agentLaunchFlags: ["--effort", "high", "--persisted-flag"] });
    expect(
      panel && "callerLaunchFlags" in panel ? panel.callerLaunchFlags : undefined
    ).toBeUndefined();
  });
});

describe("restartTerminal forced resume of an ended launch (#13226)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  const demotedCodex = {
    ...agentPanelBase,
    launchAgentId: "codex",
    title: "Codex",
    agentLaunchFlags: ["--persisted-flag"],
    // A demoted shell has its agent command cleared (#5764).
    command: undefined,
    agentState: "exited" as const,
    agentSessionId: "launch-id",
    agentResumeOffer: { agentId: "codex", sessionId: "launch-id" },
  };

  it("relaunches a demoted pane as its agent, into exactly the named conversation", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockImplementation(
      (_agent: string, sessionId: string) => `codex resume ${sessionId} -C .`
    );
    usePanelStore.setState({
      panelsById: { [demotedCodex.id]: demotedCodex },
      panelIds: [demotedCodex.id],
    });

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: "launch-id" });

    // The agent already quit: there is nothing live to quit and capture.
    expect(mockGracefulKill).not.toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledWith("test-1", { forRestart: true });
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBe("codex");
    expect(payload.command).toBe("codex resume launch-id -C .");
    expect(payload.agentSessionId).toBe("launch-id");

    const after = usePanelStore.getState().panelsById["test-1"];
    expect(after && isPtyPanel(after) ? after.agentState : null).toBe("working");
    expect(after && isPtyPanel(after) ? after.agentSessionId : null).toBe("launch-id");
    expect(after && isPtyPanel(after) ? after.agentResumeOffer : null).toBeUndefined();
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  it("keeps the pane's launch profile, so the conversation is found where it was filed", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue("codex resume launch-id -C .");
    const pane = { ...demotedCodex, env: { CODEX_HOME: "/profiles/work" } };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: "launch-id" });

    expect(mockSpawn.mock.calls[0]![0].env).toMatchObject({ CODEX_HOME: "/profiles/work" });
    (buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  it("abandons the resume when something new runs in the shell", async () => {
    const pane = { ...demotedCodex, detectedProcessId: "npm" };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: "launch-id" });

    // `reset()` in beforeEach kills the previous test's pane; only a restart
    // kill would mean the shell was torn down.
    expect(mockKill).not.toHaveBeenCalledWith("test-1", { forRestart: true });
    expect(mockSpawn).not.toHaveBeenCalled();
    const after = usePanelStore.getState().panelsById["test-1"];
    expect(after && isPtyPanel(after) ? after.isRestarting : null).toBeFalsy();
    // Still on offer, since nothing was relaunched.
    expect(after && isPtyPanel(after) ? after.agentResumeOffer : null).toEqual(
      demotedCodex.agentResumeOffer
    );
  });

  it("refuses up front, leaving live state alone, when a job is busy in the shell", async () => {
    const pane = {
      ...demotedCodex,
      activityType: "background" as const,
      flowStatus: "paused-backpressure" as const,
    };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: "launch-id" });

    expect(mockSpawn).not.toHaveBeenCalled();
    const after = usePanelStore.getState().panelsById["test-1"];
    expect(after && isPtyPanel(after) ? after.flowStatus : null).toBe("paused-backpressure");
    expect(after && isPtyPanel(after) ? after.isRestarting : null).toBeFalsy();
  });

  it("still restarts a demoted pane as a plain shell without the option", async () => {
    usePanelStore.setState({
      panelsById: { [demotedCodex.id]: demotedCodex },
      panelIds: [demotedCodex.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBeUndefined();
    expect(payload.command).toBeUndefined();
  });
});

/**
 * Moving a running pane to another preset (#13746): the hop the fallback chain
 * makes, but chosen by the user, so the pane takes the preset as its own.
 */
describe("restartTerminalOnPreset", () => {
  const presets: Record<
    string,
    { id: string; name: string; color?: string; env?: Record<string, string> }
  > = {
    personal: { id: "personal", name: "Personal", env: { CODEX_HOME: "/home/me/.codex" } },
    work: { id: "work", name: "Work", color: "#3366ff", env: { CODEX_HOME: "/home/me/.codex-2" } },
    backup: { id: "backup", name: "Backup" },
  };

  beforeEach(async () => {
    // Reset first: it tears down the previous test's pane through the mocks.
    await usePanelStore.getState().reset();
    vi.clearAllMocks();
    getMergedPresetMock.mockImplementation((_agentId: string, presetId: string) =>
      presetId ? presets[presetId] : undefined
    );
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    const { agentSettingsClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockResolvedValue({ agents: {} });
  });

  function seed(overrides: Partial<PtyPanelData> = {}): void {
    const pane: PtyPanelData = {
      ...agentPanelBase,
      agentState: "waiting",
      title: "Claude [Personal]",
      titleMode: "custom",
      agentPresetId: "personal",
      originalPresetId: "personal",
      agentSessionId: "sess-personal",
      env: { CODEX_HOME: "/home/me/.codex", STALE_ONLY_ON_OLD: "1" },
      ...overrides,
    };
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });
  }

  function pane(): PtyPanelData {
    const panel = usePanelStore.getState().panelsById["test-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("pane missing");
    return panel;
  }

  it("respawns on the chosen preset's env and saves it as the launch layer", async () => {
    seed();

    const result = await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(result).toEqual({ success: true });
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.env.CODEX_HOME).toBe("/home/me/.codex-2");
    expect(payload.agentPresetId).toBe("work");
    // Replaced, never merged: a key only the old preset set must not come back
    // on a cold restore, which prefers this saved layer (#10922).
    expect(pane().env).toEqual({ CODEX_HOME: "/home/me/.codex-2" });
    expect(pane().agentPresetId).toBe("work");
    expect(pane().agentPresetColor).toBe("#3366ff");
  });

  it("starts a new conversation: no session id survives into the new home", async () => {
    seed();

    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().agentSessionId).toBeUndefined();
    expect(mockSpawn.mock.calls[0]![0].agentSessionId).toBeUndefined();
    // Neither an exact resume nor resume-latest is ever built for this respawn.
    expect(vi.mocked(buildResumeCommand)).not.toHaveBeenCalled();
    expect(vi.mocked(buildResumeLatestCommand)).not.toHaveBeenCalled();
  });

  it("drops a caller's own resume selector, keeping the rest of its flags", async () => {
    // `--continue` would reopen whatever conversation the new home has last,
    // when the confirm promised a new one.
    seed({
      agentLaunchFlags: ["--persisted-flag", "--continue", "--verbose"],
      callerLaunchFlags: ["--continue", "--verbose"],
    });

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().callerLaunchFlags).toEqual(["--verbose"]);
    expect(pane().agentLaunchFlags).not.toContain("--continue");
    expect(mockSpawn.mock.calls[0]![0].command).not.toContain("--continue");
  });

  it("respawns a multi-word preset element as one argument in both the command and its launch flags (#15638)", async () => {
    const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
    const { generateAgentCommand } = await import("@shared/types");
    vi.mocked(generateAgentCommand).mockImplementationOnce(actual.generateAgentCommand);
    buildAgentLaunchFlagsMock.mockImplementationOnce(actual.buildAgentLaunchFlags);
    getMergedPresetMock.mockImplementation((_agentId: string, presetId: string) =>
      presetId === "prompted"
        ? { id: "prompted", name: "Prompted", args: ["--system-prompt", "two words"] }
        : presets[presetId]
    );
    seed();

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "prompted");

    const payload = mockSpawn.mock.calls[0]![0];
    const baseCommand = vi.mocked(generateAgentCommand).mock.calls[0]![0];
    expect(payload.command).toContain("--system-prompt 'two words'");
    expect(payload.agentLaunchFlags).toEqual(["--system-prompt", "two words"]);
    expect(pane().agentLaunchFlags).toEqual(["--system-prompt", "two words"]);
    expect(payload.command).toBe(
      actual.buildLaunchCommandFromFlags(baseCommand, "claude", payload.agentLaunchFlags)
    );
  });

  it("leaves a fallback hop's caller flags exactly as they were", async () => {
    seed({
      agentLaunchFlags: ["--persisted-flag", "--continue"],
      callerLaunchFlags: ["--continue"],
    });

    await usePanelStore.getState().activateFallbackPreset("test-1", "work", "personal");

    expect(pane().callerLaunchFlags).toEqual(["--continue"]);
  });

  it("makes the chosen preset the pane's own when it was on a fallback", async () => {
    seed({
      agentPresetId: "backup",
      originalPresetId: "personal",
      isUsingFallback: true,
      fallbackChainIndex: 1,
    });

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().isUsingFallback).toBeFalsy();
    expect(pane().fallbackChainIndex).toBeUndefined();
    expect(pane().originalPresetId).toBe("work");
    expect(mockSpawn.mock.calls[0]![0].originalAgentPresetId).toBe("work");
  });

  it("moves a title that is still the launch stamp to the new preset", async () => {
    seed();

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().title).toBe("Claude [Work]");
    expect(pane().titleMode).toBe("custom");
    expect(mockSpawn.mock.calls[0]![0].title).toBe("Claude [Work]");
  });

  it("recognises the original preset's stamp on a pane that fell back", async () => {
    seed({
      agentPresetId: "backup",
      originalPresetId: "personal",
      isUsingFallback: true,
      fallbackChainIndex: 1,
    });

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().title).toBe("Claude [Work]");
  });

  it("keeps a user's rename", async () => {
    seed({ title: "Claude [Personal]", titleMode: "user" });

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().title).toBe("Claude [Personal]");
    expect(pane().titleMode).toBe("user");
  });

  it("keeps a caller-supplied name", async () => {
    seed({ title: "Review API", titleMode: "custom" });

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(pane().title).toBe("Review API");
  });

  it("puts the old preset back, persisted, when the respawn fails", async () => {
    seed();
    mockSpawn.mockRejectedValueOnce(new Error("spawn failed"));

    const result = await usePanelStore.getState().restartTerminalOnPreset("test-1", "work");

    expect(result.success).toBe(false);
    expect(pane().agentPresetId).toBe("personal");
    expect(pane().env).toEqual({ CODEX_HOME: "/home/me/.codex", STALE_ONLY_ON_OLD: "1" });
    expect(pane().title).toBe("Claude [Personal]");
    expect(pane().isRestarting).toBe(false);
    expect(pane().restartError?.context?.phase).toBe("preset-switch");
  });

  it("refuses an unknown preset without touching the process", async () => {
    seed();

    const result = await usePanelStore.getState().restartTerminalOnPreset("test-1", "gone");

    expect(result.success).toBe(false);
    expect(mockKill).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(pane().agentPresetId).toBe("personal");
  });

  it("saves the hopped preset's env on a fallback hop too", async () => {
    // Same gap as the switch: a hop that left the saved layer alone came back
    // on the failed preset's env after a relaunch.
    seed();

    await usePanelStore.getState().activateFallbackPreset("test-1", "work", "personal");

    expect(pane().env).toEqual({ CODEX_HOME: "/home/me/.codex-2" });
    expect(pane().isUsingFallback).toBe(true);
    expect(pane().originalPresetId).toBe("personal");
    // A hop keeps the title: the fallback indicator says what it's running on.
    expect(pane().title).toBe("Claude [Personal]");
  });
});

describe("restartTerminal and the run's first prompt (#14592)", () => {
  const firstPrompt = { text: "Fix the login bug", via: "launch" as const, at: 1_000 };
  const launched = {
    ...agentPanelBase,
    agentState: "working" as const,
    command: "claude 'Fix the login bug'",
    firstPrompt,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    mockGracefulKill.mockResolvedValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockResolvedValue({ agents: {} });
    vi.mocked(projectClient.getSettings).mockResolvedValue({ runCommands: [] });
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue(undefined);
    vi.mocked(buildResumeLatestCommand).mockReturnValue(undefined);
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

  function paneAfterRestart(): PtyPanelData {
    const panel = usePanelStore.getState().panelsById["test-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("restarted pane is gone");
    return panel;
  }

  function show(pane: PtyPanelData): void {
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });
  }

  it("keeps the record when the restart resumes the run's conversation", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("claude --resume abc");
    show({ ...launched, agentSessionId: "abc" });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --resume abc");
    expect(paneAfterRestart().firstPrompt).toEqual(firstPrompt);
    // The run keeps its record, so main offers none of its sends (#15521).
    expect(mockSpawn.mock.calls[0]![0].hasFirstPrompt).toBe(true);
  });

  it("keeps a sent record, and offers none of the resumed run's sends (#15521)", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("claude --resume abc");
    const sent = { ...firstPrompt, via: "send" as const };
    show({ ...launched, agentSessionId: "abc", firstPrompt: sent });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(paneAfterRestart().firstPrompt).toEqual(sent);
    expect(mockSpawn.mock.calls[0]![0].hasFirstPrompt).toBe(true);
  });

  it("keeps the record when the restart resumes the latest conversation", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    vi.mocked(buildResumeLatestCommand).mockReturnValue("claude --continue");
    show(launched);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --continue");
    expect(paneAfterRestart().firstPrompt).toEqual(firstPrompt);
  });

  it("drops the record when the restart starts a new conversation without the prompt", async () => {
    show(launched);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --flag");
    expect(paneAfterRestart().firstPrompt).toBeUndefined();
    // The new conversation's first send written becomes its record (#15521).
    expect(mockSpawn.mock.calls[0]![0]).not.toHaveProperty("hasFirstPrompt");
  });

  it("keeps the record when the stored launch command, prompt included, runs again", async () => {
    const { agentSettingsClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockRejectedValue(new Error("settings unavailable"));
    show({ ...launched, agentLaunchFlags: undefined });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe(launched.command);
    expect(paneAfterRestart().firstPrompt).toEqual(firstPrompt);
  });

  it.each([
    ["keeps", "the pane's own conversation", "abc", firstPrompt],
    ["drops", "another conversation", "other", undefined],
  ])("%s the record when a forced resume reopens %s", async (_verb, _which, target, expected) => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockImplementation(
      (_agent, sessionId) => `claude -r ${sessionId}`
    );
    show({ ...launched, agentSessionId: "abc" });

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: target });

    expect(mockSpawn.mock.calls[0]![0].command).toBe(`claude -r ${target}`);
    expect(paneAfterRestart().firstPrompt).toEqual(expected);
  });

  it("never keeps a sent prompt when the stored command runs again", async () => {
    const { agentSettingsClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockRejectedValue(new Error("settings unavailable"));
    show({
      ...launched,
      agentLaunchFlags: undefined,
      firstPrompt: { ...firstPrompt, via: "send" as const },
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe(launched.command);
    expect(paneAfterRestart().firstPrompt).toBeUndefined();
    expect(mockSpawn.mock.calls[0]![0]).not.toHaveProperty("hasFirstPrompt");
  });

  it("drops the record when a demoted pane restarts as a bare shell", async () => {
    show({ ...launched, agentState: "exited" as const });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBeUndefined();
    expect(paneAfterRestart().firstPrompt).toBeUndefined();
  });

  it("drops the record when a fallback preset starts a new conversation", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    show({ ...launched, agentPresetId: "blue-provider" });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(mockSpawn).toHaveBeenCalled();
    expect(paneAfterRestart().firstPrompt).toBeUndefined();
  });
});

/**
 * A live move refiles a pane without touching its process, so `cwd` keeps
 * naming the worktree it left. A restart is a new process, and it belongs in
 * the worktree the pane is filed under — the same rule Duplicate follows
 * (#11854) — unless the launch root is one the user chose (#14954).
 */
describe("restartTerminal starts a moved pane where it is filed (#14954)", () => {
  const worktreeA = "/repo/.worktrees/a";
  const worktreeB = "/repo/.worktrees/b";

  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    mockGracefulKill.mockResolvedValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    vi.mocked(agentSettingsClient.get).mockResolvedValue({ agents: {} });
    vi.mocked(projectClient.getSettings).mockResolvedValue({ runCommands: [] });
    const { buildResumeCommand, buildResumeLatestCommand, buildLaunchCommandFromFlags } =
      await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue(undefined);
    vi.mocked(buildResumeLatestCommand).mockReturnValue(undefined);
    // Echoes the flags, so a test can see which selectors reached the launch.
    vi.mocked(buildLaunchCommandFromFlags).mockImplementation(
      (_base: string, agentId: string, flags: readonly string[]) => [agentId, ...flags].join(" ")
    );
    const { setWorktreePathIndexAccessor } = await import("@/store/storeAccessors");
    setWorktreePathIndexAccessor(
      () =>
        new Map([
          ["wt-a", worktreeA],
          ["wt-b", worktreeB],
        ])
    );
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

  afterAll(async () => {
    const { setWorktreePathIndexAccessor } = await import("@/store/storeAccessors");
    setWorktreePathIndexAccessor(() => null);
  });

  function paneAfterRestart(): PtyPanelData {
    const panel = usePanelStore.getState().panelsById["test-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("restarted pane is gone");
    return panel;
  }

  function show(pane: PtyPanelData): void {
    usePanelStore.setState({ panelsById: { [pane.id]: pane }, panelIds: [pane.id] });
  }

  const movedShell: PtyPanelData = {
    id: "test-1",
    kind: "terminal",
    title: "Shell",
    cwd: worktreeA,
    cols: 80,
    rows: 24,
    location: "grid",
    worktreeId: "wt-b",
  };

  it("relaunches a moved shell in the worktree it is filed under", async () => {
    show(movedShell);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeB);
    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBe("wt-b");
    expect(paneAfterRestart().cwd).toBe(worktreeB);
  });

  it("keeps a subdirectory of the filed worktree", async () => {
    show({ ...movedShell, cwd: `${worktreeB}/packages/api` });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(`${worktreeB}/packages/api`);
    expect(paneAfterRestart().cwd).toBe(`${worktreeB}/packages/api`);
  });

  it("keeps a folder under no worktree", async () => {
    show({ ...movedShell, cwd: "/tmp/scratch" });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe("/tmp/scratch");
    expect(paneAfterRestart().cwd).toBe("/tmp/scratch");
  });

  it("records the launch where it actually starts", async () => {
    const { agentLifecycleLedger } = await import("@/services/terminal/lifecycleLedger");
    const recordLaunch = vi.spyOn(agentLifecycleLedger, "recordLaunch");
    show(movedShell);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(recordLaunch).toHaveBeenCalledWith(
      "test-1",
      expect.objectContaining({ cwd: worktreeB, worktreeId: "wt-b" })
    );
    recordLaunch.mockRestore();
  });

  it("validates the folder it will start in, not the one it left", async () => {
    const { validateTerminalConfig } = await import("@/utils/terminalValidation");
    show(movedShell);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(vi.mocked(validateTerminalConfig).mock.calls[0]![0]).toMatchObject({ cwd: worktreeB });
  });

  it("follows a move that lands while the restart is awaiting", async () => {
    show({ ...movedShell, cwd: worktreeA, worktreeId: "wt-a" });
    mockKill.mockImplementationOnce(async () => {
      usePanelStore.setState((state) => ({
        panelsById: {
          ...state.panelsById,
          "test-1": { ...state.panelsById["test-1"]!, worktreeId: "wt-b" },
        },
      }));
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeB);
    expect(mockSpawn.mock.calls[0]![0].worktreeId).toBe("wt-b");
    expect(paneAfterRestart().cwd).toBe(worktreeB);
  });

  it("keeps the folder the user just chose for the pane", async () => {
    show(movedShell);

    await usePanelStore
      .getState()
      .restartTerminal("test-1", { allowResumeLatest: false, keepCwd: true });

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeA);
    expect(paneAfterRestart().cwd).toBe(worktreeA);
  });

  const movedClaude: PtyPanelData = {
    ...agentPanelBase,
    cwd: worktreeA,
    worktreeId: "wt-b",
    agentState: "working",
  };

  it("starts a moved directory-bound agent over in its worktree", async () => {
    // Claude reopens a conversation only in the folder it began in, so carrying
    // it into B would fail; the restart journaled it, and it reopens from A.
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("claude --resume sess-live");
    vi.mocked(buildResumeLatestCommand).mockReturnValue("claude --continue");
    mockGracefulKill.mockResolvedValueOnce("sess-live");
    show({ ...movedClaude, agentSessionId: "sess-stored" });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.cwd).toBe(worktreeB);
    expect(payload.launchAgentId).toBe("claude");
    expect(payload.command).toBe("claude --persisted-flag");
    expect(payload.agentSessionId).toBeUndefined();
    const after = paneAfterRestart();
    expect(after.cwd).toBe(worktreeB);
    expect(after.agentSessionId).toBeUndefined();
    expect(after.conversationCwd).toBeUndefined();
  });

  it("still resumes a directory-bound agent that stays where its conversation began", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("claude --resume sess-live");
    mockGracefulKill.mockResolvedValueOnce("sess-live");
    show({ ...movedClaude, worktreeId: "wt-a" });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(vi.mocked(buildResumeCommand).mock.calls[0]?.slice(0, 2)).toEqual([
      "claude",
      "sess-live",
    ]);
    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --resume sess-live");
    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeA);
  });

  it("reopens an explicitly named conversation where a directory-bound agent began it", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("claude --resume sess-ended");
    show(movedClaude);

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: "sess-ended" });

    expect(vi.mocked(buildResumeCommand).mock.calls[0]?.slice(0, 2)).toEqual([
      "claude",
      "sess-ended",
    ]);
    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --resume sess-ended");
    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeA);
    expect(paneAfterRestart().cwd).toBe(worktreeA);
  });

  it("carries a cross-directory agent's conversation into its worktree", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("codex resume sess-a");
    show({ ...movedClaude, launchAgentId: "codex", agentSessionId: "sess-a" });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(vi.mocked(buildResumeCommand).mock.calls[0]?.slice(0, 2)).toEqual(["codex", "sess-a"]);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("codex resume sess-a");
    expect(payload.cwd).toBe(worktreeB);
    const after = paneAfterRestart();
    expect(after.cwd).toBe(worktreeB);
    // Where the conversation lives, so the next resume can still find it.
    expect(after.conversationCwd).toBe(worktreeA);
  });

  it("never runs resume-latest from the worktree a pane is about to move into", async () => {
    const { buildResumeLatestCommand } = await import("@shared/types");
    vi.mocked(buildResumeLatestCommand).mockReturnValue("codex resume --last");
    show({ ...movedClaude, launchAgentId: "codex" });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.cwd).toBe(worktreeB);
    expect(payload.launchAgentId).toBe("codex");
    // The fresh launch, with whatever display flags codex's reconcile adds.
    expect(payload.command).toMatch(/^codex --persisted-flag( |$)/);
    expect(paneAfterRestart().conversationCwd).toBeUndefined();
  });

  it("carries an explicitly named conversation into the worktree for a cross-directory agent", async () => {
    const { buildResumeCommand } = await import("@shared/types");
    vi.mocked(buildResumeCommand).mockReturnValue("codex resume sess-ended");
    show({ ...movedClaude, launchAgentId: "codex" });

    await usePanelStore.getState().restartTerminal("test-1", { resumeSessionId: "sess-ended" });

    expect(vi.mocked(buildResumeCommand).mock.calls[0]?.slice(0, 2)).toEqual([
      "codex",
      "sess-ended",
    ]);
    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeB);
    expect(paneAfterRestart().conversationCwd).toBe(worktreeA);
  });

  it("drops a caller's own conversation selector when the restart moves the pane", async () => {
    show({
      ...movedClaude,
      agentLaunchFlags: ["--persisted-flag", "--continue"],
      callerLaunchFlags: ["--continue"],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --persisted-flag");
    const after = paneAfterRestart();
    expect(after.agentLaunchFlags).toEqual(["--persisted-flag"]);
    expect(after.callerLaunchFlags).toBeUndefined();
  });

  it("keeps a caller's own conversation selector when the pane stays put", async () => {
    show({
      ...movedClaude,
      worktreeId: "wt-a",
      agentLaunchFlags: ["--persisted-flag", "--continue"],
      callerLaunchFlags: ["--continue"],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe("claude --persisted-flag --continue");
    expect(paneAfterRestart().callerLaunchFlags).toEqual(["--continue"]);
  });

  it("reports the folder it tried when the moved pane fails validation", async () => {
    const { validateTerminalConfig } = await import("@/utils/terminalValidation");
    vi.mocked(validateTerminalConfig).mockResolvedValueOnce({
      valid: false,
      errors: [{ type: "cwd", message: "missing", code: "ENOENT", recoverable: true }],
    });
    show(movedShell);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(paneAfterRestart().restartError?.context?.failedCwd).toBe(worktreeB);
  });

  it("reports the folder it tried when the moved pane fails to spawn", async () => {
    mockSpawn.mockRejectedValueOnce(new Error("spawn failed"));
    show(movedShell);

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeB);
    const after = paneAfterRestart();
    expect(after.cwd).toBe(worktreeB);
    expect(after.restartError?.context?.failedCwd).toBe(worktreeB);
  });

  it("starts a preset fallback hop in the pane's worktree", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    show({ ...movedClaude, agentPresetId: "blue-provider" });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeB);
    expect(paneAfterRestart().cwd).toBe(worktreeB);
  });

  it("starts a preset switch in the pane's worktree", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    show({ ...movedClaude, agentPresetId: "blue-provider" });

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "amber-provider");

    expect(mockSpawn.mock.calls[0]![0].cwd).toBe(worktreeB);
    expect(paneAfterRestart().cwd).toBe(worktreeB);
  });

  it("drops a caller's own conversation selector when a fallback hop moves the pane", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber-provider",
      name: "Amber Provider",
      color: "#ffbb33",
      args: ["--provider", "amber"],
    });
    show({
      ...movedClaude,
      agentPresetId: "blue-provider",
      agentLaunchFlags: ["--persisted-flag", "--continue"],
      callerLaunchFlags: ["--continue"],
    });

    await usePanelStore
      .getState()
      .activateFallbackPreset("test-1", "amber-provider", "blue-provider");

    expect(mockSpawn.mock.calls[0]![0].command).not.toContain("--continue");
    expect(paneAfterRestart().callerLaunchFlags).toBeUndefined();
  });
});

describe("restartTerminal with a retired Copilot model (#15652)", () => {
  const retiredCopilot = {
    ...agentPanelBase,
    launchAgentId: "copilot",
    title: "GitHub Copilot",
    agentState: "idle" as const,
    agentModelId: "claude-opus-4.6",
    agentLaunchFlags: ["--model", "claude-opus-4.6", "--allow-all-tools"],
    command: "copilot --model claude-opus-4.6 --allow-all-tools",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    getMergedPresetMock.mockReturnValue(undefined);
    buildAgentLaunchFlagsMock.mockReturnValue([]);
    mockGracefulKill.mockResolvedValue(null);
    const { agentSettingsClient, projectClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (projectClient.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { getAgentConfig } = await import("@/config/agents");
    vi.mocked(getAgentConfig).mockReturnValue({ command: "copilot" } as never);
    // The real builders, so the command under test is the one that would run.
    const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
    const shared = await import("@shared/types");
    vi.mocked(shared.buildLaunchCommandFromFlags).mockImplementation(
      actual.buildLaunchCommandFromFlags
    );
    vi.mocked(shared.buildResumeCommand).mockImplementation(actual.buildResumeCommand);
    vi.mocked(shared.buildResumeLatestCommand).mockReturnValue(null as never);
    vi.mocked(shared.generateAgentCommand).mockImplementation(actual.generateAgentCommand);
    buildAgentLaunchFlagsMock.mockImplementation(actual.buildAgentLaunchFlags as never);
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

  // `clearAllMocks` keeps implementations, so the file's stand-ins go back
  // before any other block runs.
  afterEach(async () => {
    const { getAgentConfig } = await import("@/config/agents");
    vi.mocked(getAgentConfig)
      .mockReset()
      .mockReturnValue({ command: "claude" } as never);
    const shared = await import("@shared/types");
    vi.mocked(shared.buildLaunchCommandFromFlags).mockReset().mockReturnValue("claude --flag");
    vi.mocked(shared.buildResumeCommand)
      .mockReset()
      .mockReturnValue(null as never);
    vi.mocked(shared.buildResumeLatestCommand)
      .mockReset()
      .mockReturnValue(null as never);
    vi.mocked(shared.generateAgentCommand).mockReset().mockReturnValue("claude");
    buildAgentLaunchFlagsMock.mockReset().mockReturnValue([]);
  });

  function show(panel: Record<string, unknown>) {
    usePanelStore.setState({
      panelsById: { [panel.id as string]: panel as unknown as PtyPanelData },
      panelIds: [panel.id as string],
    });
  }

  function paneAfterRestart(): PtyPanelData {
    const panel = usePanelStore.getState().panelsById["test-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("pane missing");
    return panel;
  }

  it("relaunches on the CLI default and saves the launch without the retired model", async () => {
    show(retiredCopilot);

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("copilot --allow-all-tools");
    expect(payload.agentLaunchFlags).toEqual(["--allow-all-tools"]);
    expect(payload.agentModelId).toBeUndefined();
    const pane = paneAfterRestart();
    expect(pane.agentModelId).toBeUndefined();
    expect(pane.agentLaunchFlags).toEqual(["--allow-all-tools"]);
    expect(pane.command).toBe("copilot --allow-all-tools");
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith("copilot", ["claude-opus-4.6"], {
      panelId: "test-1",
      worktreeId: "wt-1",
    });
  });

  describe("a pane saved with an interactive Vibe model (#15569)", () => {
    const vibeWithModel = {
      ...agentPanelBase,
      launchAgentId: "mistral",
      title: "Mistral Vibe (Small)",
      agentState: "idle" as const,
      agentModelId: "devstral-small",
      agentLaunchFlags: ["--trust", "--model", "devstral-small"],
      command: "vibe --trust --model devstral-small",
    };

    beforeEach(async () => {
      const { getAgentConfig } = await import("@/config/agents");
      vi.mocked(getAgentConfig).mockReturnValue({ command: "vibe" } as never);
    });

    it("resumes without it, which Vibe refuses on a resume, and claims no model", async () => {
      mockGracefulKill.mockResolvedValue("abc-1");
      show(vibeWithModel);

      await usePanelStore.getState().restartTerminal("test-1");

      const payload = mockSpawn.mock.calls[0]![0];
      expect(payload.command).toBe("vibe --trust --resume abc-1");
      expect(payload.agentModelId).toBeUndefined();
      const pane = paneAfterRestart();
      expect(pane.agentModelId).toBeUndefined();
      expect(pane.agentLaunchFlags).toEqual(["--trust"]);
      expect(pane.command).toBe("vibe --trust");
      expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
    });

    it("starts over without it, which an interactive session ignores or rejects", async () => {
      show(vibeWithModel);

      await usePanelStore.getState().restartTerminal("test-1");

      const payload = mockSpawn.mock.calls[0]![0];
      expect(payload.command).toBe("vibe --trust");
      expect(payload.agentLaunchFlags).toEqual(["--trust"]);
      expect(payload.title).toBe("Mistral Vibe");
      expect(paneAfterRestart().agentModelId).toBeUndefined();
      expect(paneAfterRestart().title).toBe("Mistral Vibe");
      expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
    });

    it("keeps a rename the pane got rather than resetting it", async () => {
      show({ ...vibeWithModel, title: "Vibe: docs", titleMode: "user" });

      await usePanelStore.getState().restartTerminal("test-1");

      expect(mockSpawn.mock.calls[0]![0].title).toBe("Vibe: docs");
      expect(paneAfterRestart().title).toBe("Vibe: docs");
    });
  });

  it("resumes the captured conversation without the retired model", async () => {
    mockGracefulKill.mockResolvedValue("live-7");
    show(retiredCopilot);

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("copilot --allow-all-tools --resume=live-7");
    expect(payload.agentModelId).toBeUndefined();
    // A resume keeps the saved command as the next fresh launch, so it too has
    // to be the cleaned one.
    expect(paneAfterRestart().command).toBe("copilot --allow-all-tools");
  });

  it("drops a retired model saved only in the caller's flags", async () => {
    show({
      ...retiredCopilot,
      agentModelId: undefined,
      agentLaunchFlags: ["--allow-all-tools", "--model=gpt-5.4"],
      callerLaunchFlags: ["--model=gpt-5.4"],
      command: "copilot --allow-all-tools --model=gpt-5.4",
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn.mock.calls[0]![0].command).toBe("copilot --allow-all-tools");
    expect(paneAfterRestart().callerLaunchFlags).toBeUndefined();
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith(
      "copilot",
      ["gpt-5.4"],
      expect.anything()
    );
  });

  it("relaunches a model Copilot still offers with the same --model", async () => {
    show({
      ...retiredCopilot,
      agentModelId: "claude-sonnet-5.5",
      agentLaunchFlags: ["--model", "claude-sonnet-5.5", "--allow-all-tools"],
      command: "copilot --model claude-sonnet-5.5 --allow-all-tools",
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("copilot --model 'claude-sonnet-5.5' --allow-all-tools");
    expect(payload.agentModelId).toBe("claude-sonnet-5.5");
    expect(paneAfterRestart().agentModelId).toBe("claude-sonnet-5.5");
    expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
  });

  it("rebuilds from settings when the retired model was the only saved flag", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { copilot: { customFlags: "--yolo" } },
    });
    show({
      ...retiredCopilot,
      agentLaunchFlags: ["--model", "claude-opus-4.6"],
      command: "copilot --model claude-opus-4.6",
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("copilot --yolo");
    expect(payload.agentLaunchFlags).toEqual(["--yolo"]);
    expect(paneAfterRestart().command).toBe("copilot --yolo");
  });

  it("drops a retired model the pane's preset adds back after the saved fields are cleaned", async () => {
    getMergedPresetMock.mockReturnValue({ id: "old", name: "Old", args: ["--model", "gpt-5.4"] });
    show({ ...retiredCopilot, agentPresetId: "old" });

    await usePanelStore.getState().restartTerminal("test-1");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("copilot --allow-all-tools");
    expect(payload.agentLaunchFlags).toEqual(["--allow-all-tools"]);
    expect(paneAfterRestart().agentLaunchFlags).toEqual(["--allow-all-tools"]);
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith(
      "copilot",
      ["claude-opus-4.6", "gpt-5.4"],
      expect.anything()
    );
  });

  it("moves to another preset carrying neither the pane's nor the preset's retired model", async () => {
    getMergedPresetMock.mockReturnValue({
      id: "amber",
      name: "Amber",
      args: ["--amber", "--model", "gpt-5.4"],
    });
    show(retiredCopilot);

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "amber");

    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.command).toBe("copilot --amber");
    expect(payload.agentLaunchFlags).toEqual(["--amber"]);
    expect(payload.agentModelId).toBeUndefined();
    const pane = paneAfterRestart();
    expect(pane.agentModelId).toBeUndefined();
    expect(pane.agentLaunchFlags).toEqual(["--amber"]);
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith(
      "copilot",
      ["claude-opus-4.6", "gpt-5.4"],
      expect.anything()
    );
  });

  it("keeps the cleaned launch when a preset move's spawn fails after it was saved", async () => {
    getMergedPresetMock.mockReturnValue({ id: "amber", name: "Amber", args: ["--amber"] });
    mockSpawn.mockRejectedValueOnce(new Error("spawn failed"));
    show(retiredCopilot);

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "amber");

    const pane = paneAfterRestart();
    expect(pane.agentModelId).toBeUndefined();
    expect(pane.agentLaunchFlags).toEqual(["--allow-all-tools"]);
    expect(pane.command).toBe("copilot --allow-all-tools");
    expect(pane.callerLaunchFlags).toBeUndefined();
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the saved launch alone when a preset move fails before it starts", async () => {
    getMergedPresetMock.mockReturnValue(undefined);
    show(retiredCopilot);

    await usePanelStore.getState().restartTerminalOnPreset("test-1", "missing");

    expect(mockSpawn).not.toHaveBeenCalled();
    const pane = paneAfterRestart();
    expect(pane.agentModelId).toBe("claude-opus-4.6");
    expect(pane.agentLaunchFlags).toEqual(retiredCopilot.agentLaunchFlags);
    expect(pane.command).toBe(retiredCopilot.command);
    expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
  });
});

describe("restartTerminal drops a saved exit (#15941)", () => {
  it("saves the restarting pane without its exit, so a reload starts it", async () => {
    const { panelPersistence } = await import("@/store/persistence/panelPersistence");
    const { serializePtyPanel } = await import("@/panels/terminal/serializer");
    const save = vi.spyOn(panelPersistence, "save").mockImplementation(() => {});
    let finishSpawn: (value: { id: string }) => void = () => {};
    mockSpawn.mockImplementationOnce(
      () => new Promise<{ id: string }>((resolve) => (finishSpawn = resolve))
    );
    try {
      const shell = {
        id: "test-1",
        kind: "terminal" as const,
        title: "Dev server",
        cwd: "/some/path",
        command: "npm run dev",
        cols: 80,
        rows: 24,
        location: "grid" as const,
        isVisible: true,
        exitCode: 3,
        runtimeStatus: "exited" as const,
      };
      usePanelStore.setState({ panelsById: { [shell.id]: shell }, panelIds: [shell.id] });
      expect(serializePtyPanel(shell).exitCode).toBe(3);

      const restart = usePanelStore.getState().restartTerminal("test-1");
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      // Saved while the new process is still on its way, the status still reads exited.
      const saved = (save.mock.lastCall?.[0] as PtyPanelData[] | undefined)?.find(
        (p) => p.id === "test-1"
      );
      expect(saved).toBeDefined();
      expect(serializePtyPanel(saved!)).not.toHaveProperty("exitCode");

      finishSpawn({ id: "test-1" });
      await restart;
      const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData;
      expect(after.runtimeStatus).toBe("running");
      expect(serializePtyPanel(after)).not.toHaveProperty("exitCode");
    } finally {
      save.mockRestore();
    }
  });
});
