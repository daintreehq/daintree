import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInstance } from "@shared/types/panel";
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
    trash: vi.fn().mockResolvedValue(undefined),
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
      hasFocus: vi.fn(() => true),
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

const { registerTerminalQueryActions } = await import("../definitions/terminalQueryActions");
const { registerTerminalSpawnActions } = await import("../definitions/terminalSpawnActions");
const { registerTerminalLifecycleActions } =
  await import("../definitions/terminalLifecycleActions");
const { registerTerminalLayoutActions } = await import("../definitions/terminalLayoutActions");

function registerTerminalActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  registerTerminalQueryActions(actions, callbacks);
  registerTerminalSpawnActions(actions, callbacks);
  registerTerminalLifecycleActions(actions, callbacks);
  registerTerminalLayoutActions(actions, callbacks);
}
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
    onFocusRegionNext: vi.fn(),
    onFocusRegionPrev: vi.fn(),
    onOpenWorktreePalette: vi.fn(),
    onOpenQuickCreatePalette: vi.fn(),
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
    getIsSettingsOpen: vi.fn(() => false),
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

function createTerminal(overrides: Record<string, unknown> = {}): TerminalInstance {
  return {
    id: "term-1",
    kind: "terminal",
    type: "terminal",
    title: "Terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    isVisible: true,
    ...overrides,
  } as TerminalInstance;
}

beforeEach(() => {
  vi.clearAllMocks();

  useTerminalStore.setState({
    terminals: [],
    trashedTerminals: new Map(),
    tabGroups: new Map(),
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
    createDialog: { isOpen: false, initialIssue: null, initialPR: null, initialRecipeId: null },
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

  it("quits the app only when closing the last remaining non-trashed terminal", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const closeTerminal = actions.get("terminal.close")!();

    useTerminalStore.setState({
      terminals: [
        createTerminal({ id: "term-1", location: "grid" }),
        createTerminal({ id: "term-2", location: "trash" }),
      ],
      focusedId: "term-1",
    });

    await closeTerminal.run(undefined, {} as never);
    expect(mocks.appClient.quit).toHaveBeenCalledTimes(1);

    mocks.appClient.quit.mockClear();
    useTerminalStore.setState({
      terminals: [
        createTerminal({ id: "term-a", location: "grid" }),
        createTerminal({ id: "term-b", location: "grid" }),
      ],
      focusedId: "term-a",
    });

    await closeTerminal.run(undefined, {} as never);
    expect(mocks.appClient.quit).not.toHaveBeenCalled();
  });

  it("duplicates trashed terminals back into the grid with a copied title", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addTerminal = vi.fn().mockResolvedValue("copy-id");

    useTerminalStore.setState({
      terminals: [
        createTerminal({
          id: "term-trash",
          location: "trash",
          title: "Broken Session",
          command: "npm test",
          isInputLocked: true,
        }),
      ],
      addTerminal,
    } as never);

    await duplicate.run({ terminalId: "term-trash" }, {} as never);

    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        location: "grid",
        title: "Broken Session (copy)",
        command: "npm test",
        isInputLocked: true,
      })
    );
  });

  it("duplicates focused panel when called with undefined args (keybinding path)", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addTerminal = vi.fn().mockResolvedValue("copy-id");

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "term-a", title: "My Shell" })],
      focusedId: "term-a",
      addTerminal,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal",
        title: "My Shell (copy)",
      })
    );
  });

  it("duplicates the lone non-trashed panel when focusedId is null", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addTerminal = vi.fn().mockResolvedValue("copy-id");

    useTerminalStore.setState({
      terminals: [
        createTerminal({ id: "term-only", title: "Lonely" }),
        createTerminal({ id: "term-trash", location: "trash" }),
      ],
      focusedId: null,
      addTerminal,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Lonely (copy)",
      })
    );
  });

  it("falls back to creating a new terminal when no panels exist", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addTerminal = vi.fn().mockResolvedValue("new-id");

    useTerminalStore.setState({
      terminals: [],
      focusedId: null,
      addTerminal,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal",
        cwd: "/repo",
        location: "grid",
      })
    );
  });

  it("does nothing when multiple panels exist but none is focused", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addTerminal = vi.fn().mockResolvedValue("copy-id");

    useTerminalStore.setState({
      terminals: [createTerminal({ id: "term-a" }), createTerminal({ id: "term-b" })],
      focusedId: null,
      addTerminal,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addTerminal).not.toHaveBeenCalled();
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

  it("reuses the active blank tab when opening a foreground URL", async () => {
    const actions = buildRegistry(registerPanelActions);
    const openUrl = actions.get("sidecar.openUrl")!();

    vi.mocked(document.getElementById).mockReturnValue({
      getBoundingClientRect: () => ({
        x: 10,
        y: 20,
        width: 300,
        height: 400,
      }),
    } as never);

    useSidecarStore.setState({
      isOpen: false,
      activeTabId: "blank-1",
      tabs: [{ id: "blank-1", title: "New Tab", url: null }],
      createdTabs: new Set<string>(),
    });

    await openUrl.run({ url: "https://example.com/reused", title: "Reused" }, {} as never);

    const state = useSidecarStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: "blank-1",
      title: "Reused",
      url: "https://example.com/reused",
    });
    expect(state.isOpen).toBe(true);
    expect(mocks.sidecar.create).toHaveBeenCalledWith({
      tabId: "blank-1",
      url: "https://example.com/reused",
    });
    expect(mocks.sidecar.show).toHaveBeenCalled();
  });

  it("throws for focus requests targeting trashed or missing panels", async () => {
    const setActiveWorktree = vi.fn();
    const activateTerminal = vi.fn();
    useWorktreeSelectionStore.setState({ setActiveWorktree } as never);
    useTerminalStore.setState({
      terminals: [createTerminal({ id: "trashed", location: "trash" })],
      activateTerminal,
    } as never);

    const actions = buildRegistry(registerPanelActions);
    const focusPanel = actions.get("panel.focus")!();

    await expect(
      focusPanel.run({ panelId: "trashed", worktreeId: "wt-2" }, {} as never)
    ).rejects.toThrow("Terminal panel no longer exists");
    await expect(focusPanel.run({ panelId: "missing" }, {} as never)).rejects.toThrow(
      "Terminal panel no longer exists"
    );

    expect(setActiveWorktree).not.toHaveBeenCalled();
    expect(activateTerminal).not.toHaveBeenCalled();
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

  it("propagates alias dispatch failures for worktree.copyContext", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyContext = actions.get("worktree.copyContext")!();
    mocks.actionService.dispatch.mockResolvedValueOnce({
      ok: false,
      error: { message: "copyTree exploded" },
    });

    await expect(copyContext.run({ format: "markdown" }, {} as never)).rejects.toThrow(
      "copyTree exploded"
    );
  });

  it("returns the dispatched alias result for worktree.copyContext", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyContext = actions.get("worktree.copyContext")!();
    mocks.actionService.dispatch.mockResolvedValueOnce({
      ok: true,
      result: { worktreeId: "wt-9", fileCount: 2 },
    });

    await expect(copyContext.run({ format: "markdown" }, {} as never)).resolves.toEqual({
      worktreeId: "wt-9",
      fileCount: 2,
    });
  });

  it("reports missing terminal or worktree context for worktree.inject", async () => {
    const onInject = vi.fn();
    const actions = buildRegistry(registerWorktreeActions, { onInject });
    const inject = actions.get("worktree.inject")!();

    expect(inject.isEnabled?.({} as never)).toBe(false);
    expect(inject.disabledReason?.({} as never)).toBe("No focused terminal to inject into");

    await expect(inject.run(undefined, {} as never)).rejects.toThrow(
      "No focused terminal to inject into"
    );
    await expect(inject.run(undefined, { focusedTerminalId: "term-1" } as never)).rejects.toThrow(
      "No worktree selected"
    );

    expect(onInject).not.toHaveBeenCalled();
  });
});
