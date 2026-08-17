import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";

const mockSubmit = vi.fn().mockResolvedValue(undefined);
const mockGracefulKill = vi.fn().mockResolvedValue(null);
const mockCaptureBufferText = vi.fn().mockReturnValue("");
const mockAddAgentStateListener = vi.fn().mockReturnValue(vi.fn());
const mockRestartTerminal = vi.fn().mockResolvedValue(undefined);

let openCreateDialogCallback: ((worktreeId: string) => Promise<void>) | null = null;

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue({ id: "test-1" }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    gracefulKill: mockGracefulKill,
    submit: mockSubmit,
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
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  worktreeClient: {
    getAll: vi.fn().mockResolvedValue([{ id: "wt-new", path: "/new/worktree" }]),
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
    captureBufferText: mockCaptureBufferText,
    addAgentStateListener: mockAddAgentStateListener,
    setInputLocked: vi.fn(),
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      openCreateDialog: (_: unknown, opts: { onCreated: (id: string) => Promise<void> }) => {
        openCreateDialogCallback = opts.onCreated;
      },
    }),
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
  getMergedPreset: vi.fn().mockReturnValue(undefined),
  sanitizeAgentEnv: (env: Record<string, string> | undefined) => env,
}));

vi.mock("@shared/types", async () => {
  const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
  return {
    ...actual,
    generateAgentCommand: vi.fn().mockReturnValue("claude --fresh"),
    buildAgentLaunchFlags: vi.fn().mockReturnValue([]),
    buildResumeCommand: vi.fn().mockReturnValue(null),
    buildResumeLatestCommand: vi.fn().mockReturnValue(null),
    buildLaunchCommandFromFlags: vi.fn().mockReturnValue("claude"),
  };
});

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: {
    getState: () => ({ ccrPresetsByAgent: {} }),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

/** Narrow the panel union — every fixture here is a PTY panel. */
function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

const agentTerminal = {
  id: "test-1",
  kind: "terminal" as const,
  launchAgentId: "claude",
  title: "Claude",
  cwd: "/old/path",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  agentState: "working" as const,
  worktreeId: "wt-old",
};

const plainTerminal = {
  id: "test-2",
  kind: "terminal" as const,
  title: "Terminal",
  cwd: "/old/path",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  worktreeId: "wt-old",
};

describe("moveToNewWorktreeAndTransfer (#4773)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    openCreateDialogCallback = null;

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

    mockRestartTerminal.mockClear();
  });

  it("captures buffer text for agent terminals before restart", async () => {
    mockCaptureBufferText.mockReturnValue("Previous conversation content");
    usePanelStore.setState({
      panelsById: { [agentTerminal.id]: agentTerminal },
      panelIds: [agentTerminal.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    // Wait for dynamic import
    await vi.dynamicImportSettled();

    expect(mockCaptureBufferText).toHaveBeenCalledWith("test-1", 20000);
  });

  it("does not capture buffer text for non-agent terminals", async () => {
    usePanelStore.setState({
      panelsById: { [plainTerminal.id]: plainTerminal },
      panelIds: [plainTerminal.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-2");

    await vi.dynamicImportSettled();

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("discards the session id captured by the restart's graceful kill (fresh session)", async () => {
    const { buildResumeCommand, buildResumeLatestCommand } = await import("@shared/types");
    // The restart kills the agent via gracefulKill, which captures the live
    // session id — but the move flow re-seeds context by injecting the old
    // buffer, so the capture must be discarded, not resumed.
    mockGracefulKill.mockResolvedValueOnce("live-session-42");
    mockCaptureBufferText.mockReturnValue("some history");
    usePanelStore.setState({
      panelsById: { [agentTerminal.id]: agentTerminal },
      panelIds: [agentTerminal.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    expect(openCreateDialogCallback).not.toBeNull();
    await openCreateDialogCallback!("wt-new");

    expect(mockGracefulKill).toHaveBeenCalledWith("test-1");
    expect(buildResumeCommand).not.toHaveBeenCalled();
    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
    const restarted = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(restarted?.restartError).toBeUndefined();
    expect(restarted?.agentSessionId).toBeUndefined();
  });

  it("clears agentSessionId in state before restart", async () => {
    const terminalWithSession = {
      ...agentTerminal,
      agentSessionId: "old-session-123",
    };
    mockCaptureBufferText.mockReturnValue("some history");
    usePanelStore.setState({
      panelsById: { [terminalWithSession.id]: terminalWithSession },
      panelIds: [terminalWithSession.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    // After the function runs, simulate the worktree callback
    if (openCreateDialogCallback) {
      await openCreateDialogCallback("wt-new").catch(() => {});
    }

    // Check that agentSessionId was cleared
    const terminal = usePanelStore.getState().panelsById["test-1"] as PtyPanelData | undefined;
    expect(terminal?.agentSessionId).toBeUndefined();
  });

  it("does not proceed for trashed terminals", () => {
    const trashedTerminal = { ...agentTerminal, location: "trash" as const };
    usePanelStore.setState({
      panelsById: { [trashedTerminal.id]: trashedTerminal },
      panelIds: [trashedTerminal.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("does not proceed for terminals already restarting", () => {
    const restartingTerminal = { ...agentTerminal, isRestarting: true };
    usePanelStore.setState({
      panelsById: { [restartingTerminal.id]: restartingTerminal },
      panelIds: [restartingTerminal.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("does not schedule injection when captured history is empty", async () => {
    mockCaptureBufferText.mockReturnValue("");
    usePanelStore.setState({
      panelsById: { [agentTerminal.id]: agentTerminal },
      panelIds: [agentTerminal.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    // Even after callback, addAgentStateListener should not be called for injection
    expect(mockAddAgentStateListener).not.toHaveBeenCalled();
  });

  it("does not invoke resume-latest fallback when restarting after worktree move (#8787)", async () => {
    // The new-CWD restart must NOT pick up an unrelated session in the new
    // worktree directory via resume-latest. moveToNewWorktreeAndTransfer
    // passes { allowResumeLatest: false } so buffer injection remains the
    // sole context-transfer mechanism (lesson #4781).
    const { buildResumeLatestCommand } = await import("@shared/types");
    (buildResumeLatestCommand as ReturnType<typeof vi.fn>).mockClear();
    mockCaptureBufferText.mockReturnValue("some history");
    const terminalWithoutSession = {
      ...agentTerminal,
      agentSessionId: undefined,
    };
    usePanelStore.setState({
      panelsById: { [terminalWithoutSession.id]: terminalWithoutSession },
      panelIds: [terminalWithoutSession.id],
    });

    usePanelStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    if (openCreateDialogCallback) {
      await openCreateDialogCallback("wt-new").catch(() => {});
    }

    expect(buildResumeLatestCommand).not.toHaveBeenCalled();
  });

  it("fails closed instead of restarting in the old cwd when the destination cannot be resolved", async () => {
    // The pre-#11840 code fell back to the panel's existing cwd here and carried
    // on, which restarted the agent in exactly the directory the transfer
    // existed to leave. A silent fallback default on a destructive path (#7880).
    const { worktreeClient } = await import("@/clients");
    (worktreeClient.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "wt-somewhere-else", path: "/other" },
    ]);
    usePanelStore.setState({
      panelsById: { [agentTerminal.id]: agentTerminal },
      panelIds: [agentTerminal.id],
    });

    const ok = await usePanelStore.getState().transferPanelToWorktree("test-1", "wt-missing");

    expect(ok).toBe(false);
    expect(mockRestartTerminal).not.toHaveBeenCalled();
    const panel = ptyPanel("test-1");
    expect(panel?.cwd).toBe("/old/path");
    expect(panel?.worktreeId).toBe("wt-old");
    expect(panel?.restartError?.recoverable).toBe(false);
  });

  it("clears recorded divergence consent once the process is re-anchored", async () => {
    usePanelStore.setState({
      panelsById: {
        [agentTerminal.id]: {
          ...agentTerminal,
          worktreeMoveOptOut: {
            acknowledgedCwd: "/old/path",
            acknowledgedWorktreeId: "wt-old",
            at: 1,
          },
        },
      },
      panelIds: [agentTerminal.id],
    });

    await usePanelStore.getState().transferPanelToWorktree("test-1", "wt-new");

    const panel = ptyPanel("test-1");
    expect(panel?.cwd).toBe("/new/worktree");
    expect(panel?.worktreeMoveOptOut).toBeUndefined();
  });
});
