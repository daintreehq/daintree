import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
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

  const portal = {
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

  const forgeClient = {
    openIssue: vi.fn(),
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
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn(),
    prewarmTerminal: vi.fn(),
    sendPtyResize: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    detachForProjectSwitch: vi.fn(),
  };

  const windowMock = {
    electron: {
      portal,
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

  // Minimal zustand-like store for getCurrentViewStore() mock
  let worktreeViewState: Record<string, unknown> = {
    worktrees: new Map(),
    isLoading: false,
    error: null,
    isInitialized: false,
  };
  const worktreeViewStore = {
    getState: () => worktreeViewState,
    setState: (partial: Record<string, unknown>) => {
      worktreeViewState = { ...worktreeViewState, ...partial };
    },
  };

  return {
    appClient,
    terminalClient,
    systemClient,
    worktreeClient,
    copyTreeClient,
    forgeClient,
    actionService,
    terminalInstanceService,
    portal,
    terminal,
    notification,
    worktreeViewStore,
  };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => mocks.worktreeViewStore,
}));

vi.mock("@/clients", () => ({
  appClient: mocks.appClient,
  terminalClient: mocks.terminalClient,
  systemClient: mocks.systemClient,
  worktreeClient: mocks.worktreeClient,
  copyTreeClient: mocks.copyTreeClient,
  forgeClient: mocks.forgeClient,
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: mocks.terminalInstanceService,
}));

vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: mocks.terminalInstanceService,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: mocks.actionService,
}));

vi.mock("../../../store/persistence/panelPersistence", () => ({
  panelPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
    saveTabGroups: vi.fn(),
    setProjectIdGetter: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(() => "mock-notification-id"),
}));

// Run the optimistic-close commit synchronously so these tests assert the
// canonical trash outcome directly; the deferral itself is covered by
// optimisticPanelClose.test.ts.
vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  requestPanelClose: vi.fn((req: { commit: () => void }) => req.commit()),
  flushOptimisticCloses: vi.fn(),
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
const { usePanelStore } = await import("../../../store/panelStore");
const { useLayoutUndoStore } = await import("../../../store/layoutUndoStore");
const { usePortalStore } = await import("../../../store/portalStore");
const { useUIStore } = await import("../../../store/uiStore");
const { useWorktreeSelectionStore } = await import("../../../store/worktreeStore");
const { useWorktreeFilterStore } = await import("../../../store/worktreeFilterStore");
const worktreeViewStore = mocks.worktreeViewStore;

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
    onOpenResumeSessionsPalette: vi.fn(),
    onOpenProjectSwitcherPalette: vi.fn(),
    onConfirmCloseActiveProject: vi.fn(),
    onOpenActionPalette: vi.fn(),
    onOpenQuickSwitcher: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onLaunchAgent: vi.fn(async () => null),
    onInject: vi.fn(),
    onAddTerminal: vi.fn(async () => {}),
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

function createTerminal(overrides: Record<string, unknown> = {}): PtyPanelData {
  return {
    id: "term-1",
    kind: "terminal",
    title: "Terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    isVisible: true,
    ...overrides,
  } as PtyPanelData;
}

beforeEach(() => {
  vi.clearAllMocks();

  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    trashedTerminals: new Map(),
    tabGroups: new Map(),
    focusedId: null,
    maximizedId: null,
    activeDockTerminalId: null,
    commandQueue: [],
  });

  usePortalStore.setState({
    isOpen: false,
    activeTabId: null,
    tabs: [],
    createdTabs: new Set<string>(),
    links: [],
    defaultNewTabUrl: null,
  });

  useUIStore.setState({ overlayStack: [] });

  useWorktreeSelectionStore.setState({
    activeWorktreeId: null,
    focusedWorktreeId: null,
    pendingWorktreeId: null,
    expandedWorktrees: new Set<string>(),
    expandedTerminals: new Set<string>(),
    createDialog: {
      isOpen: false,
      initialIssue: null,
      initialPR: null,
      initialRecipeId: null,
      initialBranchInput: null,
    },
    crossDiffDialog: { isOpen: false, initialWorktreeId: null },
    _policyGeneration: 0,
    lastFocusedTerminalByWorktree: new Map<string, string>(),
  });

  worktreeViewStore.setState({
    worktrees: new Map(),
    isLoading: false,
    error: null,
    isInitialized: false,
  });

  useWorktreeFilterStore.setState({
    query: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    prIssueFilters: new Set(),
    sessionFilters: new Set(),
    activityFilters: new Set(),
    devServerFilters: new Set(),
    alwaysShowActive: true,
    alwaysShowWaiting: true,
    hideMainWorktree: false,
    pinnedWorktrees: [],
    collapsedWorktrees: [],
    manualOrder: [],
    quickStateFilter: "all",
  });
});

describe("terminal action hardening", () => {
  it("rejects command submission to missing, trashed, non-PTY, and PTY-less targets", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const sendCommand = actions.get("terminal.sendCommand")!();

    await expect(
      sendCommand.run({ terminalId: "missing", command: "ls" }, {} as never)
    ).rejects.toThrow("Terminal not found");

    usePanelStore.setState({
      panelsById: { trash: createTerminal({ id: "trash", location: "trash" }) },
      panelIds: ["trash"],
    });
    await expect(
      sendCommand.run({ terminalId: "trash", command: "ls" }, {} as never)
    ).rejects.toThrow("Cannot send commands to trashed terminals");

    usePanelStore.setState({
      panelsById: {
        browser: createTerminal({ id: "browser", kind: "browser", type: "browser" }),
      },
      panelIds: ["browser"],
    });
    await expect(
      sendCommand.run({ terminalId: "browser", command: "ls" }, {} as never)
    ).rejects.toThrow('Terminal kind "browser" does not support command execution');

    usePanelStore.setState({
      panelsById: { "n-opty": createTerminal({ id: "n-opty", hasPty: false }) },
      panelIds: ["n-opty"],
    });
    await expect(
      sendCommand.run({ terminalId: "n-opty", command: "ls" }, {} as never)
    ).rejects.toThrow("Terminal does not have PTY capability");
  });

  it("submits valid commands exactly once", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const sendCommand = actions.get("terminal.sendCommand")!();

    usePanelStore.setState({
      panelsById: { "term-ok": createTerminal({ id: "term-ok" }) },
      panelIds: ["term-ok"],
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

    usePanelStore.setState({
      panelsById: { existing: createTerminal({ id: "existing" }) },
      panelIds: ["existing"],
      focusedId: "existing",
      activeDockTerminalId: null,
    });

    await moveToDock.run({ terminalId: "missing" }, {} as never);

    expect(usePanelStore.getState().focusedId).toBe("existing");
    expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
    expect(mocks.terminalInstanceService.wake).not.toHaveBeenCalled();
  });

  // moveToDock, moveToGrid and toggleDock are reachable from the in-app
  // assistant's action tier, so an unbound agent call would rearrange whatever
  // the user was looking at (#11532); toggleDock previously had no terminalId
  // at all. toggleMaximize is dormant and guarded as defense in depth.
  describe("terminal layout target binding (#11532)", () => {
    function seedGridPair() {
      usePanelStore.setState({
        panelsById: {
          focused: createTerminal({ id: "focused" }),
          named: createTerminal({ id: "named" }),
        },
        // "named" leads so terminal.close-style "first visible panel" fallbacks
        // cannot land on the focused panel by coincidence.
        panelIds: ["named", "focused"],
        focusedId: "focused",
        maximizedId: null,
        activeDockTerminalId: null,
      });
    }

    it.each([
      "terminal.moveToDock",
      "terminal.moveToGrid",
      "terminal.toggleDock",
      "terminal.toggleMaximize",
    ])(
      "%s rejects agent dispatch that names no terminal, leaving the focused panel put",
      async (id) => {
        const actions = buildRegistry(registerTerminalActions);
        const action = actions.get(id)!();
        seedGridPair();
        const before = usePanelStore.getState().panelsById.focused?.location;

        // Matched in full so an unguarded-args TypeError (which also names
        // terminalId) cannot pass for a guard rejection.
        await expect(action.run({} as never, { dispatchSource: "agent" } as never)).rejects.toThrow(
          /requires an explicit `terminalId` when dispatched by an agent or MCP client/
        );

        expect(usePanelStore.getState().panelsById.focused?.location).toBe(before);
        // toggleMaximize moves maximizedId rather than location, so checking
        // location alone would pass even if it had already run.
        expect(usePanelStore.getState().maximizedId).toBeNull();
      }
    );

    // moveToWorktree is reachable from the assistant's action tier (#11877), and
    // its side effect is a worktreeId change rather than a location change, so
    // the table above could not prove it stayed put — these assert the mutation
    // each action actually performs.
    it("moveToWorktree rejects agent dispatch that names no terminal, leaving the focused panel in its worktree", async () => {
      const actions = buildRegistry(registerTerminalActions);
      const moveToWorktree = actions.get("terminal.moveToWorktree")!();

      usePanelStore.setState({
        panelsById: { focused: createTerminal({ id: "focused", worktreeId: "wt-1" }) },
        panelIds: ["focused"],
        focusedId: "focused",
      });

      await expect(
        moveToWorktree.run({ worktreeId: "wt-2" } as never, { dispatchSource: "agent" } as never)
      ).rejects.toThrow(
        /requires an explicit `terminalId` when dispatched by an agent or MCP client/
      );

      // The move mutates worktreeId, not location, so this is the only
      // assertion that would fail if the guard let the action through.
      expect(usePanelStore.getState().panelsById.focused?.worktreeId).toBe("wt-1");
    });

    it("moveToNewWorktree refuses agent dispatch outright rather than hanging its dialog at a headless caller", async () => {
      const actions = buildRegistry(registerTerminalActions);
      const moveToNewWorktree = actions.get("terminal.moveToNewWorktree")!();

      const openCreateFlow = vi.fn();
      // Swapped back in `finally`: the suite's beforeEach resets store DATA but
      // not store METHODS, so leaving the stub in place would silently poison
      // every later test that reaches the real one.
      const realMoveToNewWorktree = usePanelStore.getState().moveToNewWorktree;
      usePanelStore.setState({
        panelsById: { focused: createTerminal({ id: "focused", worktreeId: "wt-1" }) },
        panelIds: ["focused"],
        focusedId: "focused",
        moveToNewWorktree: openCreateFlow,
      } as never);

      try {
        // Named target too: the objection is the interactive dialog, so naming
        // a terminal must not buy a way past it the way it does for siblings
        // whose only worry is which panel an unbound call would land on.
        await expect(
          moveToNewWorktree.run(
            { terminalId: "focused" } as never,
            {
              dispatchSource: "agent",
            } as never
          )
        ).rejects.toThrow(
          /opens the new-worktree dialog, which a headless caller can never answer/
        );

        expect(openCreateFlow).not.toHaveBeenCalled();
      } finally {
        usePanelStore.setState({ moveToNewWorktree: realMoveToNewWorktree } as never);
      }
    });

    it("toggleDock moves the terminal the agent named, not the focused one", async () => {
      const actions = buildRegistry(registerTerminalActions);
      const toggleDock = actions.get("terminal.toggleDock")!();
      seedGridPair();

      await toggleDock.run({ terminalId: "named" } as never, { dispatchSource: "agent" } as never);

      expect(usePanelStore.getState().panelsById.named?.location).toBe("dock");
      expect(usePanelStore.getState().panelsById.focused?.location).not.toBe("dock");
    });

    it("toggleDock keeps the focus fallback for interactive dispatch", async () => {
      const actions = buildRegistry(registerTerminalActions);
      const toggleDock = actions.get("terminal.toggleDock")!();
      seedGridPair();

      await toggleDock.run({} as never, { dispatchSource: "keybinding" } as never);

      expect(usePanelStore.getState().panelsById.focused?.location).toBe("dock");
    });

    it("toggleDock leaves redo history alone when the named terminal is gone", async () => {
      // pushLayoutSnapshot clears the redo stack, so taking it before the
      // existence check would let a stale UUID wipe the user's redo history
      // and then move nothing.
      const actions = buildRegistry(registerTerminalActions);
      const toggleDock = actions.get("terminal.toggleDock")!();
      seedGridPair();
      const pendingRedo = {
        terminals: [],
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
      };
      useLayoutUndoStore.setState({ undoStack: [], redoStack: [pendingRedo] });

      try {
        await toggleDock.run({ terminalId: "gone" } as never, { dispatchSource: "agent" } as never);

        expect(useLayoutUndoStore.getState().redoStack).toEqual([pendingRedo]);
        expect(useLayoutUndoStore.getState().undoStack).toHaveLength(0);
      } finally {
        useLayoutUndoStore.setState({ undoStack: [], redoStack: [] });
      }
    });
  });

  it("preserves focus when moving a missing or already-aligned terminal to a worktree", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const moveToWorktree = actions.get("terminal.moveToWorktree")!();

    usePanelStore.setState({
      panelsById: { "term-a": createTerminal({ id: "term-a", worktreeId: "wt-1" }) },
      panelIds: ["term-a"],
      focusedId: "term-a",
    });

    await moveToWorktree.run({ terminalId: "missing", worktreeId: "wt-2" }, {} as never);
    expect(usePanelStore.getState().focusedId).toBe("term-a");

    await moveToWorktree.run({ terminalId: "term-a", worktreeId: "wt-1" }, {} as never);
    expect(usePanelStore.getState().focusedId).toBe("term-a");
  });

  it("does not quit the app when closing the last remaining non-trashed terminal", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const closeTerminal = actions.get("terminal.close")!();

    usePanelStore.setState({
      panelsById: {
        "term-1": createTerminal({ id: "term-1", location: "grid" }),
        "term-2": createTerminal({ id: "term-2", location: "trash" }),
      },
      panelIds: ["term-1", "term-2"],
      focusedId: "term-1",
    });

    await closeTerminal.run(undefined, {} as never);
    expect(mocks.appClient.quit).not.toHaveBeenCalled();
  });

  // #6920: terminal.close trashes immediately for every agent state — the
  // close-confirm dialog and CustomEvent dispatch were retired in favour of
  // an undo toast emitted by panelStore.trashPanel.
  it.each(["idle", "working", "waiting", "directing", "completed", "exited"] as const)(
    "trashes a %s agent terminal immediately on terminal.close (no confirm event)",
    async (state) => {
      const actions = buildRegistry(registerTerminalActions);
      const closeTerminal = actions.get("terminal.close")!();

      const dispatchSpy = vi.spyOn(window, "dispatchEvent");

      usePanelStore.setState({
        panelsById: {
          "term-1": createTerminal({
            id: "term-1",
            location: "grid",
            agentState: state,
          }),
        },
        panelIds: ["term-1"],
        focusedId: "term-1",
      });

      await closeTerminal.run(undefined, {} as never);

      expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");
      const confirmEvents = dispatchSpy.mock.calls
        .map(([event]) => event)
        .filter(
          (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:close-confirm"
        );
      expect(confirmEvents).toHaveLength(0);

      dispatchSpy.mockRestore();
    }
  );

  it("duplicates trashed terminals back into the grid with a copied title", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: {
        "term-trash": createTerminal({
          id: "term-trash",
          location: "trash",
          title: "Broken Session",
          command: "npm test",
          isInputLocked: true,
        }),
      },
      panelIds: ["term-trash"],
      addPanel,
    } as never);

    await duplicate.run({ terminalId: "term-trash" }, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
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
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: { "term-a": createTerminal({ id: "term-a", title: "My Shell" }) },
      panelIds: ["term-a"],
      focusedId: "term-a",
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        title: "My Shell (copy)",
      })
    );
  });

  it("duplicates the lone non-trashed panel when focusedId is null", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: {
        "term-only": createTerminal({ id: "term-only", title: "Lonely" }),
        "term-trash": createTerminal({ id: "term-trash", location: "trash" }),
      },
      panelIds: ["term-only", "term-trash"],
      focusedId: null,
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Lonely (copy)",
      })
    );
  });

  it("falls back to creating a new terminal when no panels exist and no snapshot", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("new-id");

    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      lastClosedConfig: null,
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        cwd: "/repo",
        location: "grid",
      })
    );
  });

  it("uses lastClosedConfig snapshot when no panels exist", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("new-id");

    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      lastClosedConfig: {
        kind: "terminal",
        type: "claude",
        agentId: "claude",
        cwd: "/projects/app",
        worktreeId: "wt-1",
        command: "claude --interactive",
        agentModelId: "opus",
        agentLaunchFlags: ["--verbose"],
      },
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "claude",
        cwd: "/projects/app",
        worktreeId: "wt-1",
        command: "claude --interactive",
        agentModelId: "opus",
        location: "grid",
      })
    );
  });

  it("uses active worktree when lastClosedConfig has no worktreeId", async () => {
    const actions = buildRegistry(registerTerminalActions, {
      getActiveWorktreeId: () => "active-wt",
    });
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("new-id");

    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      lastClosedConfig: {
        kind: "terminal",
        type: "terminal",
        cwd: "/home/user",
      },
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        location: "grid",
        worktreeId: "active-wt",
      })
    );
  });

  it("does nothing when multiple panels exist but none is focused", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: {
        "term-a": createTerminal({ id: "term-a" }),
        "term-b": createTerminal({ id: "term-b" }),
      },
      panelIds: ["term-a", "term-b"],
      focusedId: null,
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).not.toHaveBeenCalled();
  });

  // #7477: focusedId can lag behind a trash op (e.g. cross-process IPC race).
  // The duplicate handler must treat a focusedId pointing at a trashed panel
  // as if there were no implicit focus, falling through to the same paths as
  // focusedId === null.
  it("ignores stale focusedId that points at a trashed panel and creates a fresh terminal", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("new-id");

    usePanelStore.setState({
      panelsById: {
        "term-trash": createTerminal({
          id: "term-trash",
          location: "trash",
          title: "Stale Focus",
          command: "npm test",
        }),
      },
      panelIds: ["term-trash"],
      focusedId: "term-trash",
      lastClosedConfig: null,
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        cwd: "/repo",
        location: "grid",
      })
    );
    expect(addPanel).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Stale Focus") })
    );
    expect(addPanel).not.toHaveBeenCalledWith(expect.objectContaining({ command: "npm test" }));
  });

  it("duplicates the lone live terminal when focusedId is stale-trashed", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: {
        "term-trash": createTerminal({
          id: "term-trash",
          location: "trash",
          title: "Stale Focus",
        }),
        "term-live": createTerminal({ id: "term-live", title: "Live One" }),
      },
      panelIds: ["term-trash", "term-live"],
      focusedId: "term-trash",
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ title: "Live One (copy)" }));
  });

  it("ignores dangling focusedId pointing at a missing panel and falls back to the lone live terminal", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: { "term-live": createTerminal({ id: "term-live", title: "Live One" }) },
      panelIds: ["term-live"],
      focusedId: "gone",
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ title: "Live One (copy)" }));
  });

  it("falls through to lastClosedConfig snapshot when focusedId is stale-trashed and no live panels exist", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("new-id");

    usePanelStore.setState({
      panelsById: {
        "term-trash": createTerminal({ id: "term-trash", location: "trash" }),
      },
      panelIds: ["term-trash"],
      focusedId: "term-trash",
      lastClosedConfig: {
        kind: "terminal",
        type: "terminal",
        cwd: "/projects/app",
        worktreeId: "wt-1",
      },
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/projects/app",
        worktreeId: "wt-1",
        location: "grid",
      })
    );
  });

  it("does not duplicate trashed panel when focusedId is stale-trashed and multiple live panels exist", async () => {
    const actions = buildRegistry(registerTerminalActions);
    const duplicate = actions.get("terminal.duplicate")!();
    const addPanel = vi.fn().mockResolvedValue("copy-id");

    usePanelStore.setState({
      panelsById: {
        "term-trash": createTerminal({
          id: "term-trash",
          location: "trash",
          title: "Stale Focus",
          command: "npm test",
        }),
        "term-a": createTerminal({ id: "term-a" }),
        "term-b": createTerminal({ id: "term-b" }),
      },
      panelIds: ["term-trash", "term-a", "term-b"],
      focusedId: "term-trash",
      addPanel,
    } as never);

    await duplicate.run(undefined, {} as never);

    expect(addPanel).not.toHaveBeenCalled();
  });
});

describe("panel action hardening", () => {
  it("ignores activation requests for unknown portal tabs", async () => {
    const actions = buildRegistry(registerPanelActions);
    const activateTab = actions.get("portal.activateTab")!();

    usePortalStore.setState({
      isOpen: true,
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com" }],
      createdTabs: new Set<string>(["tab-1"]),
    });

    await activateTab.run({ tabId: "missing" }, {} as never);

    expect(usePortalStore.getState().activeTabId).toBe("tab-1");
    expect(mocks.portal.hide).not.toHaveBeenCalled();
    expect(mocks.portal.show).not.toHaveBeenCalled();
    expect(mocks.portal.create).not.toHaveBeenCalled();
  });

  it("removes background tabs again if portal creation fails", async () => {
    const actions = buildRegistry(registerPanelActions);
    const openUrl = actions.get("portal.openUrl")!();
    mocks.portal.create.mockRejectedValueOnce(new Error("boom"));

    await openUrl.run(
      {
        url: "https://example.com/background",
        title: "Background",
        background: true,
      },
      {} as never
    );

    expect(usePortalStore.getState().tabs).toEqual([]);
    expect(usePortalStore.getState().createdTabs.size).toBe(0);
  });

  it("portal.openUrl is a no-op while an overlay claim is active", async () => {
    const actions = buildRegistry(registerPanelActions);
    const openUrl = actions.get("portal.openUrl")!();

    useUIStore.setState({ overlayStack: ["theme-browser"] });
    usePortalStore.setState({
      isOpen: false,
      activeTabId: null,
      tabs: [],
      createdTabs: new Set<string>(),
    });

    await openUrl.run({ url: "https://example.com/blocked", title: "Blocked" }, {} as never);

    const state = usePortalStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.tabs).toEqual([]);
    expect(mocks.portal.create).not.toHaveBeenCalled();
    expect(mocks.portal.show).not.toHaveBeenCalled();
  });

  it("reuses the active blank tab when opening a foreground URL", async () => {
    const actions = buildRegistry(registerPanelActions);
    const openUrl = actions.get("portal.openUrl")!();

    vi.mocked(document.getElementById).mockReturnValue({
      getBoundingClientRect: () => ({
        x: 10,
        y: 20,
        width: 300,
        height: 400,
      }),
    } as never);

    usePortalStore.setState({
      isOpen: false,
      activeTabId: "blank-1",
      tabs: [{ id: "blank-1", title: "New Tab", url: null }],
      createdTabs: new Set<string>(),
    });

    await openUrl.run({ url: "https://example.com/reused", title: "Reused" }, {} as never);

    const state = usePortalStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: "blank-1",
      title: "Reused",
      url: "https://example.com/reused",
    });
    expect(state.isOpen).toBe(true);
    expect(mocks.portal.create).toHaveBeenCalledWith({
      tabId: "blank-1",
      url: "https://example.com/reused",
    });
    expect(mocks.portal.show).toHaveBeenCalled();
  });

  it("throws for focus requests targeting trashed or missing panels", async () => {
    const activateTerminal = vi.fn();
    usePanelStore.setState({
      panelsById: { trashed: createTerminal({ id: "trashed", location: "trash" }) },
      panelIds: ["trashed"],
      activateTerminal,
    } as never);

    const actions = buildRegistry(registerPanelActions);
    const focusPanel = actions.get("panel.focus")!();

    await expect(focusPanel.run({ panelId: "trashed" }, {} as never)).rejects.toThrow(
      "Terminal panel no longer exists"
    );
    await expect(focusPanel.run({ panelId: "missing" }, {} as never)).rejects.toThrow(
      "Terminal panel no longer exists"
    );

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

  it.each([
    ["worktree.getDefaultPath", { branchName: "feature/login" }],
    [
      "worktree.create",
      { options: { baseBranch: "main", newBranch: "feature/login", path: "/repo-wt/login" } },
    ],
  ])("%s refuses to fall back to the active worktree", (id, args) => {
    const actions = buildRegistry(registerWorktreeActions);
    const schema = actions.get(id)!().argsSchema!;

    // Both anchor on the REPO ROOT, and the active worktree is usually a LINKED
    // worktree — a silent fallback misses the project's configured
    // worktreePathPattern and answers about the wrong directory instead of
    // erroring. The dialog dispatching worktree.create always passes rootPath.
    expect(schema.safeParse(args).success).toBe(false);
    expect(schema.safeParse({ ...args, rootPath: "/repo" }).success).toBe(true);
    expect(schema.safeParse({ ...args, worktreeId: "wt-1" }).success).toBe(true);
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
      expect.objectContaining({ modified: true }),
      "unknown"
    );
  });

  it("forwards scoped folder paths and glob patterns as independent options", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyTree = actions.get("worktree.copyTree")!();
    mocks.copyTreeClient.generateAndCopyFile.mockResolvedValueOnce({ fileCount: 2 });

    await copyTree.run({ scopePaths: ["src/panels"], includePaths: ["**/*.ts"] }, {
      activeWorktreeId: "wt-1",
    } as never);

    const options = mocks.copyTreeClient.generateAndCopyFile.mock.calls[0]?.[1];
    // Scope is a literal walk root, filter is a pattern — folding one into the
    // other is what made folder copies ignore the project's ignore rules.
    expect(options.scopePaths).toEqual(["src/panels"]);
    expect(options.includePaths).toEqual(["**/*.ts"]);
  });

  it.each([
    ["an empty list", []],
    ["a blank entry", [""]],
  ])("rejects %s instead of copying the whole worktree", async (_label, scopePaths) => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyTree = actions.get("worktree.copyTree")!();

    // Both would resolve to the worktree root. Silently widening a folder copy
    // to the entire worktree is worse than refusing the request.
    expect(() => copyTree.argsSchema!.parse({ scopePaths })).toThrow();
    expect(mocks.copyTreeClient.generateAndCopyFile).not.toHaveBeenCalled();
  });

  it("returns structured metadata for successful copy-tree requests", async () => {
    const actions = buildRegistry(registerWorktreeActions);
    const copyTree = actions.get("worktree.copyTree")!();
    mocks.copyTreeClient.generateAndCopyFile.mockResolvedValueOnce({
      fileCount: 4,
      stats: { bytes: 1024 },
    });

    const result = await copyTree.run({ format: "json" }, { focusedWorktreeId: "wt-2" } as never);

    expect(mocks.copyTreeClient.generateAndCopyFile).toHaveBeenCalledWith(
      "wt-2",
      { format: "json", modified: undefined },
      // No dispatch source on this bare context, and the surface is not
      // inferable from one — recorded as unknown rather than guessed (#11732).
      "unknown"
    );
    expect(result).toEqual({
      worktreeId: "wt-2",
      fileCount: 4,
      stats: { bytes: 1024 },
      format: "json",
    });
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

describe("worktree cycling respects sidebar order", () => {
  function installWorktrees(entries: Array<Record<string, unknown>>): void {
    const map = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      const id = entry.id as string;
      map.set(id, {
        worktreeId: id,
        isCurrent: false,
        isMainWorktree: false,
        ...entry,
      });
    }
    worktreeViewStore.setState({
      worktrees: map as Map<string, never>,
      isLoading: false,
      error: null,
      isInitialized: true,
    });
  }

  function spySelectWorktree(): ReturnType<typeof vi.fn> {
    const spy = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree: spy } as never);
    return spy;
  }

  it("cycles forward through sidebar-ordered list, not a stale callback list", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-a", name: "alpha", branch: "feature/alpha", path: "/repo/a" },
      { id: "wt-b", name: "bravo", branch: "feature/bravo", path: "/repo/b" },
      { id: "wt-c", name: "charlie", branch: "feature/charlie", path: "/repo/c" },
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "wt-a",
      // Deliberately stale/wrong list — should be ignored by the cycle action.
      getWorktrees: () => [{ id: "stale", name: "stale" }] as never,
    });
    await actions.get("worktree.next")!().run(undefined, {} as never);

    expect(select).toHaveBeenCalledWith("wt-b");
  });

  it("cycles backward honoring sidebar order", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-a", name: "alpha", branch: "feature/alpha", path: "/repo/a" },
      { id: "wt-b", name: "bravo", branch: "feature/bravo", path: "/repo/b" },
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "wt-a",
    });
    await actions.get("worktree.previous")!().run(undefined, {} as never);

    // Visible order: [main, wt-a, wt-b]; wt-a is at index 1, previous goes to main.
    expect(select).toHaveBeenCalledWith("main");
  });

  it("switchIndex selects by sidebar position", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-a", name: "alpha", branch: "feature/alpha", path: "/repo/a" },
      { id: "wt-b", name: "bravo", branch: "feature/bravo", path: "/repo/b" },
      { id: "wt-c", name: "charlie", branch: "feature/charlie", path: "/repo/c" },
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions);
    await actions.get("worktree.switchIndex")!().run({ index: 3 }, {} as never);

    // Sidebar order: [main, wt-a, wt-b, wt-c]; index 3 => wt-b.
    expect(select).toHaveBeenCalledWith("wt-b");
  });

  it("home and end jump to first and last sidebar entries", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-a", name: "alpha", branch: "feature/alpha", path: "/repo/a" },
      { id: "wt-b", name: "bravo", branch: "feature/bravo", path: "/repo/b" },
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "wt-a",
    });
    await actions.get("worktree.home")!().run(undefined, {} as never);
    await actions.get("worktree.end")!().run(undefined, {} as never);

    expect(select).toHaveBeenNthCalledWith(1, "main");
    expect(select).toHaveBeenNthCalledWith(2, "wt-b");
  });

  it("down navigates by offset within the visible list", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-a", name: "alpha", branch: "feature/alpha", path: "/repo/a" },
      { id: "wt-b", name: "bravo", branch: "feature/bravo", path: "/repo/b" },
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "wt-a",
    });
    await actions.get("worktree.down")!().run(undefined, {} as never);

    expect(select).toHaveBeenCalledWith("wt-b");
  });

  it("no-ops when the visible list is empty", async () => {
    const select = spySelectWorktree();
    const actions = buildRegistry(registerWorktreeActions);

    await actions.get("worktree.next")!().run(undefined, {} as never);
    await actions.get("worktree.switch1")!().run(undefined, {} as never);
    await actions.get("worktree.end")!().run(undefined, {} as never);

    expect(select).not.toHaveBeenCalled();
  });

  it("previous and up agree when the active worktree is filtered out", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-idle", name: "idle", branch: "feature/idle", path: "/repo/idle" },
      { id: "wt-working", name: "working", branch: "feature/working", path: "/repo/working" },
    ]);
    usePanelStore.setState({
      panelsById: {
        "term-working": createTerminal({
          id: "term-working",
          worktreeId: "wt-working",
          agentState: "working",
          detectedAgentId: "claude",
        }),
      },
      panelIds: ["term-working"],
      panelIdsByWorktreeId: { "wt-working": ["term-working"] },
    });
    useWorktreeFilterStore.setState({
      orderBy: "alpha",
      quickStateFilter: "working",
      alwaysShowActive: false,
    });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "wt-idle",
    });

    await actions.get("worktree.previous")!().run(undefined, {} as never);
    await actions.get("worktree.up")!().run(undefined, {} as never);

    // Visible list: [main, wt-working]. Both actions must pick the same entry
    // (last visible → wt-working) so cycle and directional navigation agree.
    expect(select.mock.calls[0]![0]).toBe("wt-working");
    expect(select.mock.calls[1]![0]).toBe("wt-working");
  });

  it("up/down use first/last visible when active is filtered out", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-idle", name: "idle", branch: "feature/idle", path: "/repo/idle" },
      { id: "wt-working", name: "working", branch: "feature/working", path: "/repo/working" },
    ]);
    usePanelStore.setState({
      panelsById: {
        "term-working": createTerminal({
          id: "term-working",
          worktreeId: "wt-working",
          agentState: "working",
          detectedAgentId: "claude",
        }),
      },
      panelIds: ["term-working"],
      panelIdsByWorktreeId: { "wt-working": ["term-working"] },
    });
    useWorktreeFilterStore.setState({
      orderBy: "alpha",
      quickStateFilter: "working",
      alwaysShowActive: false,
    });
    const select = spySelectWorktree();

    // wt-idle is the active worktree but is filtered out (quickStateFilter=working,
    // alwaysShowActive=false). Visible list is [main, wt-working].
    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "wt-idle",
    });

    await actions.get("worktree.down")!().run(undefined, {} as never);
    await actions.get("worktree.up")!().run(undefined, {} as never);

    expect(select).toHaveBeenNthCalledWith(1, "main"); // down → first visible
    expect(select).toHaveBeenNthCalledWith(2, "wt-working"); // up → last visible
  });

  it("quickStateFilter hides non-matching worktrees from cycling", async () => {
    installWorktrees([
      { id: "main", name: "main", branch: "main", path: "/repo", isMainWorktree: true },
      { id: "wt-idle", name: "idle", branch: "feature/idle", path: "/repo/idle" },
      { id: "wt-working", name: "working", branch: "feature/working", path: "/repo/working" },
    ]);

    // Mark wt-working with a working agent terminal
    usePanelStore.setState({
      panelsById: {
        "term-working": createTerminal({
          id: "term-working",
          worktreeId: "wt-working",
          agentState: "working",
          detectedAgentId: "claude",
        }),
      },
      panelIds: ["term-working"],
      panelIdsByWorktreeId: { "wt-working": ["term-working"] },
    });

    useWorktreeFilterStore.setState({
      orderBy: "alpha",
      quickStateFilter: "working",
    });
    const select = spySelectWorktree();

    const actions = buildRegistry(registerWorktreeActions, {
      getActiveWorktreeId: () => "main",
    });
    // Visible list with quickStateFilter=working: [main, wt-working] (main always shown,
    // wt-idle filtered out). Forward from main selects wt-working.
    await actions.get("worktree.next")!().run(undefined, {} as never);

    expect(select).toHaveBeenCalledWith("wt-working");
    expect(select).not.toHaveBeenCalledWith("wt-idle");
  });
});
