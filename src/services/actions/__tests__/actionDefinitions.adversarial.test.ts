import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    clear: vi.fn(() => {
      storage.clear();
    }),
  };

  const sidecar = {
    create: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    closeTab: vi.fn(),
  };

  const terminal = {
    getSerializedState: vi.fn(),
    getInfo: vi.fn(),
  };

  const notification = {
    acknowledgeWaiting: vi.fn(),
  };

  const appClient = {
    quit: vi.fn(),
    setState: vi.fn(),
  };

  const terminalClient = {
    submit: vi.fn(),
    forceResume: vi.fn(),
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    flush: vi.fn(),
  };

  const systemClient = {
    openExternal: vi.fn(),
    openPath: vi.fn(),
  };

  const worktreeClient = {
    refreshPullRequests: vi.fn(),
    setActive: vi.fn(),
    create: vi.fn(),
    listBranches: vi.fn(),
    getDefaultPath: vi.fn(),
    delete: vi.fn(),
    getAvailableBranch: vi.fn(),
  };

  const copyTreeClient = {
    generateAndCopyFile: vi.fn(),
  };

  const githubClient = {
    openIssue: vi.fn(),
    openPR: vi.fn(),
    getIssueUrl: vi.fn(),
  };

  const actionService = {
    dispatch: vi.fn(),
  };

  const terminalInstanceService = {
    wake: vi.fn(),
    resetRenderer: vi.fn(),
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    resize: vi.fn(),
    prewarmTerminal: vi.fn(),
    sendPtyResize: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    detachForProjectSwitch: vi.fn(),
  };

  const windowMock = {
    electron: {
      sidecar,
      terminal,
      notification,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: {
      origin: "http://localhost:5173",
      protocol: "http:",
      href: "http://localhost:5173/",
    },
    top: null as unknown,
    localStorage: localStorageMock as unknown as Storage,
  };

  windowMock.top = windowMock;

  class CustomEventMock<T = unknown> extends Event {
    detail: T | undefined;

    constructor(type: string, init?: CustomEventInit<T>) {
      super(type);
      this.detail = init?.detail;
    }
  }

  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: windowMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "self", {
    value: globalThis,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      getElementById: vi.fn(() => null),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: vi.fn(),
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    value: CustomEventMock,
    configurable: true,
    writable: true,
  });

  return {
    appClient,
    terminalClient,
    systemClient,
    worktreeClient,
    copyTreeClient,
    githubClient,
    actionService,
    terminalInstanceService,
    sidecar,
    terminal,
    notification,
  };
});

vi.mock("@/clients", () => ({
  appClient: mocks.appClient,
  terminalClient: mocks.terminalClient,
  systemClient: mocks.systemClient,
  worktreeClient: mocks.worktreeClient,
  copyTreeClient: mocks.copyTreeClient,
  githubClient: mocks.githubClient,
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: mocks.terminalInstanceService,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: mocks.actionService,
}));

vi.mock("../../../store/persistence/terminalPersistence", () => ({
  terminalPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
    saveTabGroups: vi.fn(),
  },
}));

const { registerTerminalActions } = await import("../definitions/terminalActions");
const { registerPanelActions } = await import("../definitions/panelActions");
const { registerWorktreeActions } = await import("../definitions/worktreeActions");
const { useTerminalStore } = await import("../../../store/terminalStore");
const { useSidecarStore } = await import("../../../store/sidecarStore");
const { useWorktreeSelectionStore } = await import("../../../store/worktreeStore");
const { useWorktreeDataStore } = await import("../../../store/worktreeDataStore");

function createCallbacks(overrides: Partial<ActionCallbacks> = {}): ActionCallbacks {
  return {
    onOpenSettings: vi.fn(),
    onOpenSettingsTab: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onOpenWorktreePalette: vi.fn(),
    onToggleWorktreeOverview: vi.fn(),
    onOpenWorktreeOverview: vi.fn(),
    onCloseWorktreeOverview: vi.fn(),
    onOpenPanelPalette: vi.fn(),
    onOpenProjectSwitcherPalette: vi.fn(),
    onOpenActionPalette: vi.fn(),
    onOpenQuickSwitcher: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onLaunchAgent: vi.fn(async () => null),
    onInject: vi.fn(),
    getDefaultCwd: () => "/repo",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
    ...overrides,
  };
}

function buildRegistry(
  register: (actions: ActionRegistry, callbacks: ActionCallbacks) => void,
  callbacks: Partial<ActionCallbacks> = {}
): ActionRegistry {
  const actions: ActionRegistry = new Map();
  register(actions, createCallbacks(callbacks));
  return actions;
}

function createTerminal(overrides: Record<string, unknown> = {}) {
  return {
    id: "term-1",
    kind: "terminal",
    type: "terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    isVisible: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  useTerminalStore.setState({
    terminals: [],
    trashedTerminals: new Map(),
    tabGroups: new Map(),
    activeTabByGroup: new Map(),
    focusedId: null,
    maximizedId: null,
    activeDockTerminalId: null,
    commandQueue: [],
  });

  useSidecarStore.setState({
    isOpen: false,
    activeTabId: null,
    tabs: [],
    createdTabs: new Set<string>(),
    links: [],
    defaultNewTabUrl: null,
  });

  useWorktreeSelectionStore.setState({
    activeWorktreeId: null,
    focusedWorktreeId: null,
    pendingWorktreeId: null,
    expandedWorktrees: new Set<string>(),
    expandedTerminals: new Set<string>(),
    createDialog: { isOpen: false, initialIssue: null, initialPR: null },
    crossDiffDialog: { isOpen: false, initialWorktreeId: null },
    _policyGeneration: 0,
    lastFocusedTerminalByWorktree: new Map<string, string>(),
  });

  useWorktreeDataStore.setState({
    worktrees: new Map(),
    projectId: null,
    isLoading: false,
    error: null,
    isInitialized: false,
  });
});

describe("terminal action hardening", () => {
  it("rejects command submission to missing, trashed, non-PTY, and PTY-less targets", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const sendCommand = actions.get("terminal.sendCommand")!();

    await expect(
      sendCommand.run({ terminalId: "missing", command: "ls" }, {} as never)
    ).rejects.toThrow("Terminal not found");

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "trash", location: "trash" })],
    });
    await expect(
      sendCommand.run({ terminalId: "trash", command: "ls" }, {} as never)
    ).rejects.toThrow("Cannot send commands to trashed terminals");

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "browser", kind: "browser", type: "browser" })],
    });
    await expect(
      sendCommand.run({ terminalId: "browser", command: "ls" }, {} as never)
    ).rejects.toThrow('Terminal kind "browser" does not support command execution');

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "n-opty", hasPty: false })],
    });
    await expect(
      sendCommand.run({ terminalId: "n-opty", command: "ls" }, {} as never)
    ).rejects.toThrow("Terminal does not have PTY capability");
  });

  it("submits valid commands exactly once", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const sendCommand = actions.get("terminal.sendCommand")!();

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "term-ok" })],
    });

    const result = await sendCommand.run(
      { terminalId: "term-ok", command: "git status" },
      {} as never
    );

    expect(mocks.terminalClient.submit).toHaveBeenCalledWith("term-ok", "git status");
    expect(result).toMatchObject({
      sent: true,
      terminalId: "term-ok",
      command: "git status",
    });
  });

  it("does not corrupt dock focus when asked to dock a missing terminal", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const moveToDock = actions.get("terminal.moveToDock")!();

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "existing" })],
      focusedId: "existing",
      activeDockTerminalId: null,
    });

    await moveToDock.run({ terminalId: "missing" }, {} as never);

    expect(useTerminalStore.getState().focusedId).toBe("existing");
    expect(useTerminalStore.getState().activeDockTerminalId).toBeNull();
    expect(mocks.terminalInstanceService.wake).not.toHaveBeenCalled();
  });

  it("preserves focus when moving a missing or already-aligned terminal to a worktree", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const moveToWorktree = actions.get("terminal.moveToWorktree")!();

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "term-a", worktreeId: "wt-1" })],
      focusedId: "term-a",
    });

    await moveToWorktree.run({ terminalId: "missing", worktreeId: "wt-2" }, {} as never);
    expect(useTerminalStore.getState().focusedId).toBe("term-a");

    await moveToWorktree.run({ terminalId: "term-a", worktreeId: "wt-1" }, {} as never);
    expect(useTerminalStore.getState().focusedId).toBe("term-a");
  });
});

describe("panel action hardening", () => {
  it("ignores activation requests for unknown sidecar tabs", async () => {
    const actions = buildRegistry(registerPanelActions);
    const activateTab = actions.get("sidecar.activateTab")!();

    useSidecarStore.setState({
      isOpen: true,
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com" }],
      createdTabs: new Set<string>(["tab-1"]),
    });

    await activateTab.run({ tabId: "missing" }, {} as never);

    expect(useSidecarStore.getState().activeTabId).toBe("tab-1");
    expect(mocks.sidecar.hide).not.toHaveBeenCalled();
    expect(mocks.sidecar.show).not.toHaveBeenCalled();
    expect(mocks.sidecar.create).not.toHaveBeenCalled();
  });

  it("removes background tabs again if sidecar creation fails", async () => {
    const actions = buildRegistry(registerPanelActions);
    const openUrl = actions.get("sidecar.openUrl")!();
    mocks.sidecar.create.mockRejectedValueOnce(new Error("boom"));

    await openUrl.run(
      {
        url: "https://example.com/background",
        title: "Background",
        background: true,
      },
      {} as never
    );

    expect(useSidecarStore.getState().tabs).toEqual([]);
    expect(useSidecarStore.getState().createdTabs.size).toBe(0);
  });
});

describe("worktree action hardening", () => {
  it("selects the focused worktree from context and fails loudly when none is available", async () => {
    const selectWorktree = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree } as never);

    const actions = buildRegistry(registerWorktreeActions);
    const select = actions.get("worktree.select")!();

    await select.run(undefined, { focusedWorktreeId: "wt-focused" } as never);
    expect(selectWorktree).toHaveBeenCalledWith("wt-focused");

    await expect(select.run(undefined, {} as never)).rejects.toThrow("No worktree selected");
  });

  it("maps empty modified-copy results to a user-facing error", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyTree = actions.get("worktree.copyTree")!();
    mocks.copyTreeClient.generateAndCopyFile.mockResolvedValueOnce({
      error: "No valid files were found in this worktree",
    });

    await expect(
      copyTree.run({ modified: true }, { activeWorktreeId: "wt-1" } as never)
    ).rejects.toThrow("No modified files to copy. Make some changes first.");

    expect(mocks.copyTreeClient.generateAndCopyFile).toHaveBeenCalledWith(
      "wt-1",
      expect.objectContaining({ modified: true })
    );
  });

  it("returns structured metadata for successful copy-tree requests", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyTree = actions.get("worktree.copyTree")!();
    mocks.copyTreeClient.generateAndCopyFile.mockResolvedValueOnce({
      fileCount: 4,
      stats: { bytes: 1024 },
    });

    const result = await copyTree.run({ format: "json" }, { focusedWorktreeId: "wt-2" } as never);

    expect(mocks.copyTreeClient.generateAndCopyFile).toHaveBeenCalledWith("wt-2", {
      format: "json",
      modified: undefined,
    });
    expect(result).toEqual({
      worktreeId: "wt-2",
      fileCount: 4,
      stats: { bytes: 1024 },
      format: "json",
    });
  });

  it("does not dispatch sidecar open for malformed or unsafe PR URLs", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const openPRInSidecar = actions.get("worktree.openPRInSidecar")!();

    useWorktreeDataStore.setState({
      worktrees: new Map([
        [
          "wt-1",
          {
            id: "wt-1",
            path: "/repo",
            branch: "feature/test",
            prUrl: "javascript:alert(1)",
            prTitle: "Unsafe",
            prNumber: 12,
          },
        ],
        [
          "wt-2",
          {
            id: "wt-2",
            path: "/repo",
            branch: "feature/bad",
            prUrl: "not a url",
            prTitle: "Broken",
            prNumber: 13,
          },
        ],
      ]),
    } as never);

    await openPRInSidecar.run(undefined, { activeWorktreeId: "wt-1" } as never);
    await openPRInSidecar.run(undefined, { activeWorktreeId: "wt-2" } as never);

    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch sidecar open when issue URL lookup returns nothing", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const openIssueInSidecar = actions.get("worktree.openIssueInSidecar")!();

    useWorktreeDataStore.setState({
      worktrees: new Map([
        [
          "wt-3",
          {
            id: "wt-3",
            path: "/repo",
            branch: "feature/no-issue-url",
            issueNumber: 44,
            issueTitle: "Missing URL",
          },
        ],
      ]),
    } as never);
    mocks.githubClient.getIssueUrl.mockResolvedValueOnce(null);

    await openIssueInSidecar.run(undefined, { activeWorktreeId: "wt-3" } as never);

    expect(mocks.githubClient.getIssueUrl).toHaveBeenCalledWith("/repo", 44);
    expect(mocks.actionService.dispatch).not.toHaveBeenCalled();
  });
});
