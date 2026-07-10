import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

const mockSpawn = vi.fn().mockResolvedValue({ id: "test-1" });
const mockKill = vi.fn().mockResolvedValue(undefined);
const mockGracefulKill = vi.fn().mockResolvedValue(null);
const getMergedPresetMock = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
const buildAgentLaunchFlagsMock = vi.hoisted(() => vi.fn().mockReturnValue([]));

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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    suppressNextExit: vi.fn(),
    get: vi.fn().mockReturnValue({ terminal: { cols: 80, rows: 24 } }),
    waitForInstance: vi.fn().mockResolvedValue(undefined),
    fit: vi.fn(),
    captureBufferText: vi.fn().mockReturnValue(""),
    addAgentStateListener: vi.fn().mockReturnValue(vi.fn()),
    setInputLocked: vi.fn(),
  },
}));

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
    reconcileBypassFlags: (flags: readonly string[]) => [...flags],
    resolveEffectiveBypass: () => false,
  };
});

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

  it("preserves launchAgentId on the panel after demoted restart (launch identity)", async () => {
    const demoted = { ...agentPanelBase, agentState: "exited" as const, exitCode: 0 };
    usePanelStore.setState({
      panelsById: { [demoted.id]: demoted },
      panelIds: [demoted.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    const after = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(after?.launchAgentId).toBe("claude");
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

  // Scenario 3: "shell survives agent exit" remains holds — a cold-launched
  // agent terminal whose agent is still actively working (no demotion signal)
  // relaunches as the agent on restart.
  it("relaunches cold-launched agent terminal as agent when still active (shell-survives invariant)", async () => {
    const active = {
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
      agentState: "working" as const,
      // No exitCode, no "exited" state — the invariant from #5807 (iii):
      // shell survives agent exit means demotion state is respected; while
      // the agent is live, restart still relaunches it.
    };
    usePanelStore.setState({
      panelsById: { [active.id]: active },
      panelIds: [active.id],
    });

    await usePanelStore.getState().restartTerminal("test-1");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBe("claude");
    expect(payload.command).toBeDefined();
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

    expect(mockGracefulKill).toHaveBeenCalledWith("test-1");
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

    expect(mockKill).toHaveBeenCalledWith("test-1");
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
    expect(mockKill).toHaveBeenCalledWith("test-1");
  });

  it("uses bare kill for failed-spawn retries (no live process to quit)", async () => {
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

    expect(mockGracefulKill).not.toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledWith("test-1");
    // The retry still relaunches as the agent (#10816).
    const payload = mockSpawn.mock.calls[0]![0];
    expect(payload.launchAgentId).toBe("claude");
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
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
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
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
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
