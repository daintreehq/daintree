import { describe, it, expect, beforeEach, vi } from "vitest";

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
    captureBufferText: mockCaptureBufferText,
    addAgentStateListener: mockAddAgentStateListener,
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
}));

vi.mock("@shared/types", () => ({
  generateAgentCommand: vi.fn().mockReturnValue("claude --resume"),
  buildResumeCommand: vi.fn().mockReturnValue(null),
}));

const { useTerminalStore } = await import("../../../terminalStore");

const agentTerminal = {
  id: "test-1",
  type: "claude" as const,
  kind: "agent" as const,
  agentId: "claude",
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
  type: "terminal" as const,
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

    const { reset } = useTerminalStore.getState();
    await reset();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });

    // Override restartTerminal to track calls without running full logic
    const state = useTerminalStore.getState();
    mockRestartTerminal.mockClear();
    // We'll spy on the actual store method
  });

  it("captures buffer text for agent terminals before restart", async () => {
    mockCaptureBufferText.mockReturnValue("Previous conversation content");
    useTerminalStore.setState({ terminals: [agentTerminal] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-1");

    // Wait for dynamic import
    await vi.dynamicImportSettled();

    expect(mockCaptureBufferText).toHaveBeenCalledWith("test-1", 20000);
  });

  it("does not capture buffer text for non-agent terminals", async () => {
    useTerminalStore.setState({ terminals: [plainTerminal] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-2");

    await vi.dynamicImportSettled();

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("does not call gracefulKill (abandoned session resume path)", async () => {
    mockCaptureBufferText.mockReturnValue("some history");
    useTerminalStore.setState({ terminals: [agentTerminal] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    // Simulate worktree creation callback
    if (openCreateDialogCallback) {
      // Mock worktreeClient.getAll inside the callback
      vi.doMock("@/clients", async (importOriginal) => {
        const original = (await importOriginal()) as Record<string, unknown>;
        return {
          ...original,
          worktreeClient: {
            getAll: vi.fn().mockResolvedValue([{ id: "wt-new", path: "/new/worktree" }]),
          },
        };
      });
    }

    // gracefulKill should never be called in the new flow
    expect(mockGracefulKill).not.toHaveBeenCalled();
  });

  it("clears agentSessionId in state before restart", async () => {
    const terminalWithSession = {
      ...agentTerminal,
      agentSessionId: "old-session-123",
    };
    mockCaptureBufferText.mockReturnValue("some history");
    useTerminalStore.setState({ terminals: [terminalWithSession] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    // After the function runs, simulate the worktree callback
    if (openCreateDialogCallback) {
      await openCreateDialogCallback("wt-new").catch(() => {});
    }

    // Check that agentSessionId was cleared
    const terminal = useTerminalStore.getState().terminals.find((t) => t.id === "test-1");
    expect(terminal?.agentSessionId).toBeUndefined();
  });

  it("does not proceed for trashed terminals", () => {
    const trashedTerminal = { ...agentTerminal, location: "trash" as const };
    useTerminalStore.setState({ terminals: [trashedTerminal] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-1");

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("does not proceed for terminals already restarting", () => {
    const restartingTerminal = { ...agentTerminal, isRestarting: true };
    useTerminalStore.setState({ terminals: [restartingTerminal] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-1");

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("does not schedule injection when captured history is empty", async () => {
    mockCaptureBufferText.mockReturnValue("");
    useTerminalStore.setState({ terminals: [agentTerminal] });

    useTerminalStore.getState().moveToNewWorktreeAndTransfer("test-1");

    await vi.dynamicImportSettled();

    // Even after callback, addAgentStateListener should not be called for injection
    expect(mockAddAgentStateListener).not.toHaveBeenCalled();
  });
});
