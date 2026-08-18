import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

const mockSubmit = vi.fn().mockResolvedValue(undefined);
const mockGracefulKill = vi.fn().mockResolvedValue(null);
const mockCaptureBufferText = vi.fn().mockReturnValue("");
const mockAddAgentStateListener = vi.fn().mockReturnValue(vi.fn());
const mockMoveAndFollowRescue = vi.fn();

let openCreateDialogCallback: ((worktreeId: string) => void) | null = null;

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
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getTmpDir: vi.fn().mockResolvedValue("/tmp") },
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
      openCreateDialog: (_: unknown, opts: { onCreated: (id: string) => void }) => {
        openCreateDialogCallback = opts.onCreated;
      },
    }),
  },
}));

// The choke point itself has its own suite; here it is a spy, so these tests
// assert the *routing* — that the create path does not grow its own move.
vi.mock("@/services/terminal/crossWorktreeMove", () => ({
  moveTerminalToWorktreeAndFollowRescue: mockMoveAndFollowRescue,
}));

vi.mock("@/store/restartExitSuppression", () => ({
  markTerminalRestarting: vi.fn(),
  unmarkTerminalRestarting: vi.fn(),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: "proj-1" } }) },
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
  useCcrPresetsStore: { getState: () => ({ ccrPresetsByAgent: {} }) },
}));

const { usePanelStore } = await import("../../../panelStore");

const agentTerminal: PtyPanelData = {
  id: "test-1",
  kind: "terminal",
  launchAgentId: "claude",
  title: "Claude",
  cwd: "/old/path",
  cols: 80,
  rows: 24,
  location: "grid",
  agentState: "working",
  worktreeId: "wt-old",
};

/**
 * #11853 replaced the create-and-transfer path with create-and-move: the
 * worktree is still created and the panel is still filed under it, but the
 * running process is never touched. These tests are mostly about what must
 * *not* happen — #11840's transfer killed a live session to relabel a panel.
 */
describe("moveToNewWorktree (#11853)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    openCreateDialogCallback = null;

    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: { [agentTerminal.id]: agentTerminal },
      panelIds: [agentTerminal.id],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  it("opens the create-worktree dialog", async () => {
    usePanelStore.getState().moveToNewWorktree("test-1");
    await vi.dynamicImportSettled();

    expect(openCreateDialogCallback).toBeTypeOf("function");
  });

  it("routes the created worktree through the shared move choke point", async () => {
    usePanelStore.getState().moveToNewWorktree("test-1");
    await vi.dynamicImportSettled();
    openCreateDialogCallback?.("wt-new");

    // Not its own move: going through the choke point is what raises the
    // pane's banner and keeps this path from drifting from the drag paths.
    expect(mockMoveAndFollowRescue).toHaveBeenCalledWith("test-1", "wt-new");
  });

  it("never captures the terminal buffer", async () => {
    usePanelStore.getState().moveToNewWorktree("test-1");
    await vi.dynamicImportSettled();
    openCreateDialogCallback?.("wt-new");

    expect(mockCaptureBufferText).not.toHaveBeenCalled();
  });

  it("never kills, restarts, or clears the agent session", async () => {
    usePanelStore.getState().moveToNewWorktree("test-1");
    await vi.dynamicImportSettled();
    openCreateDialogCallback?.("wt-new");
    await vi.dynamicImportSettled();

    expect(mockGracefulKill).not.toHaveBeenCalled();
    expect(usePanelStore.getState().panelsById["test-1"]).toBe(agentTerminal);
  });

  it("never submits anything into the live session", async () => {
    // The whole reason the transfer path came out: nothing may be written into
    // a running conversation without an explicit click on the pane's banner.
    usePanelStore.getState().moveToNewWorktree("test-1");
    await vi.dynamicImportSettled();
    openCreateDialogCallback?.("wt-new");
    await vi.dynamicImportSettled();

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockAddAgentStateListener).not.toHaveBeenCalled();
  });

  it("ignores a panel that is missing or in the trash", async () => {
    usePanelStore.getState().moveToNewWorktree("ghost");
    usePanelStore.setState({
      panelsById: { [agentTerminal.id]: { ...agentTerminal, location: "trash" } },
    });
    usePanelStore.getState().moveToNewWorktree("test-1");
    await vi.dynamicImportSettled();

    expect(openCreateDialogCallback).toBeNull();
  });
});
