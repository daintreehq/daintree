// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { escapeShellArg } from "@shared/utils/shellEscape";

const appClientMock = {
  hydrate: vi.fn(),
};

const terminalClientMock = {
  getForProject: vi.fn(),
  reconnect: vi.fn(),
  getSerializedStates: vi.fn(),
};

const worktreeClientMock = {
  getAll: vi.fn(),
};

const projectClientMock = {
  getTabGroups: vi.fn(),
  getTerminalSizes: vi.fn(),
};

const terminalConfigClientMock = {
  setScrollback: vi.fn(),
};

const layoutConfigState = {
  setLayoutConfig: vi.fn(),
};

const scrollbackState = {
  setScrollbackLines: vi.fn(),
};

const performanceState = {
  setPerformanceMode: vi.fn(),
};

const terminalInputState = {
  setHybridInputEnabled: vi.fn(),
  setHybridInputAutoFocus: vi.fn(),
};

const setSpawnErrorMock = vi.fn();
const terminalStoreState = {
  setSpawnError: setSpawnErrorMock,
};

const initializeMock = vi.fn().mockResolvedValue(undefined);
const loadOverridesMock = vi.fn().mockResolvedValue(undefined);
const fetchAndRestoreMock = vi.fn().mockResolvedValue(undefined);
const restoreFetchedStateMock = vi.fn().mockResolvedValue(undefined);
const getManagedTerminalMock = vi.fn().mockReturnValue(null);
const isTerminalWarmInProjectSwitchCacheMock = vi.fn().mockReturnValue(false);

vi.mock("@/clients", () => ({
  appClient: appClientMock,
  terminalClient: terminalClientMock,
  worktreeClient: worktreeClientMock,
  projectClient: projectClientMock,
  systemClient: { getTmpDir: vi.fn().mockResolvedValue("/tmp") },
}));

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: terminalConfigClientMock,
}));

vi.mock("@/store", () => ({
  useLayoutConfigStore: {
    getState: () => layoutConfigState,
  },
  useScrollbackStore: {
    getState: () => scrollbackState,
  },
  usePerformanceModeStore: {
    getState: () => performanceState,
  },
  useTerminalInputStore: {
    getState: () => terminalInputState,
  },
  useTerminalStore: {
    getState: () => terminalStoreState,
  },
}));

vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: {
    getState: () => ({
      initialize: initializeMock,
    }),
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    loadOverrides: loadOverridesMock,
  },
}));

const initializeBackendTierMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fetchAndRestore: fetchAndRestoreMock,
    restoreFetchedState: restoreFetchedStateMock,
    initializeBackendTier: initializeBackendTierMock,
    get: getManagedTerminalMock,
  },
}));

vi.mock("@/services/projectSwitchRendererCache", () => ({
  isTerminalWarmInProjectSwitchCache: isTerminalWarmInProjectSwitchCacheMock,
}));

const { hydrateAppState } = await import("../stateHydration");

describe("hydrateAppState", () => {
  const project = { id: "project-1", path: "/project" };
  const terminalConfig = { scrollbackLines: 1000, performanceMode: false };
  const agentSettings = { agents: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    getManagedTerminalMock.mockReturnValue(null);
    isTerminalWarmInProjectSwitchCacheMock.mockReturnValue(false);
    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    terminalClientMock.getSerializedStates.mockRejectedValue(
      new Error("Batch serialized state endpoint unavailable")
    );
    worktreeClientMock.getAll.mockResolvedValue([]);
    projectClientMock.getTabGroups.mockResolvedValue([]);
    projectClientMock.getTerminalSizes.mockResolvedValue({});
  });

  it("rehydrates dev-preview panels without backend terminals", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "dev-preview-1",
            kind: "dev-preview",
            title: "Dev Preview",
            cwd: "/project",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
            devServerStatus: "running",
            devServerUrl: "http://localhost:5173",
            devServerError: { type: "unknown", message: "Previous boot warning" },
            devServerTerminalId: "dev-preview-pty-1",
            devPreviewConsoleOpen: true,
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addTerminal = vi.fn().mockResolvedValue("dev-preview-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dev-preview",
        requestedId: "dev-preview-1",
        cwd: "/project",
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        devPreviewConsoleOpen: true,
      })
    );

    const addTerminalArg = addTerminal.mock.calls[0][0] as Record<string, unknown>;
    expect(addTerminalArg.devServerStatus).toBeUndefined();
    expect(addTerminalArg.devServerUrl).toBeUndefined();
    expect(addTerminalArg.devServerError).toBeUndefined();
    expect(addTerminalArg.devServerTerminalId).toBeUndefined();
  });

  it("rehydrates multiple dev-preview panels in one worktree without leaking runtime state", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "dev-preview-a",
            kind: "dev-preview",
            title: "Dev Preview A",
            cwd: "/project/worktrees/feature",
            worktreeId: "wt-feature",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
            devServerStatus: "running",
            devServerUrl: "http://localhost:5173",
            devServerError: null,
            devServerTerminalId: "dev-preview-pty-a",
            devPreviewConsoleOpen: true,
          },
          {
            id: "dev-preview-b",
            kind: "dev-preview",
            title: "Dev Preview B",
            cwd: "/project/worktrees/feature",
            worktreeId: "wt-feature",
            location: "grid",
            command: "pnpm dev",
            browserUrl: "http://localhost:5174",
            devServerStatus: "error",
            devServerUrl: null,
            devServerError: { type: "unknown", message: "Previous crash" },
            devServerTerminalId: "dev-preview-pty-b",
            devPreviewConsoleOpen: false,
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addTerminal = vi.fn().mockResolvedValue("panel-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(2);
    expect(addTerminal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "dev-preview",
        requestedId: "dev-preview-a",
        worktreeId: "wt-feature",
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        devPreviewConsoleOpen: true,
      })
    );
    expect(addTerminal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "dev-preview",
        requestedId: "dev-preview-b",
        worktreeId: "wt-feature",
        devCommand: "pnpm dev",
        browserUrl: "http://localhost:5174",
        devPreviewConsoleOpen: false,
      })
    );

    const firstAddArg = addTerminal.mock.calls[0][0] as Record<string, unknown>;
    const secondAddArg = addTerminal.mock.calls[1][0] as Record<string, unknown>;

    expect(firstAddArg.devServerStatus).toBeUndefined();
    expect(firstAddArg.devServerUrl).toBeUndefined();
    expect(firstAddArg.devServerError).toBeUndefined();
    expect(firstAddArg.devServerTerminalId).toBeUndefined();

    expect(secondAddArg.devServerStatus).toBeUndefined();
    expect(secondAddArg.devServerUrl).toBeUndefined();
    expect(secondAddArg.devServerError).toBeUndefined();
    expect(secondAddArg.devServerTerminalId).toBeUndefined();
  });

  it("rehydrates non-terminal panels like browser and notes", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:5173",
          },
          {
            id: "notes-1",
            kind: "notes",
            title: "Notes",
            cwd: "/project",
            location: "dock",
            notePath: "notes/today.md",
            noteId: "note-1",
            scope: "project",
            createdAt: 123,
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addTerminal = vi.fn().mockResolvedValue("panel-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(2);
    expect(addTerminal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "browser",
        requestedId: "browser-1",
        browserUrl: "http://localhost:5173",
      })
    );
    expect(addTerminal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "notes",
        requestedId: "notes-1",
        notePath: "notes/today.md",
        noteId: "note-1",
        scope: "project",
        createdAt: 123,
      })
    );
  });

  it("rehydrates terminal panels when no backend process exists", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            type: "terminal",
            title: "Terminal",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addTerminal = vi.fn().mockResolvedValue("terminal-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        requestedId: "terminal-1",
        cwd: "/project",
        location: "grid",
      })
    );
  });

  it("silently respawns agent panels when not found in backend", async () => {
    // When an agent terminal can't be reconnected (not found in backend),
    // we silently respawn it with a fresh session instead of showing errors.
    // The command is regenerated from current agent settings (no old prompt).
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "agent",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude -p 'Old prompt'",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: {
            customFlags: "--model sonnet-4",
          },
        },
      },
    });

    const addTerminal = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    // Agent terminals respawn with requestedId (fresh session)
    expect(addTerminal).toHaveBeenCalledTimes(1);
    const callArgs = addTerminal.mock.calls[0][0];

    // Assert requestedId is used (respawn mode)
    expect(callArgs).toHaveProperty("requestedId", "agent-1");
    // Assert existingId is NOT used (not reconnecting)
    expect(callArgs).not.toHaveProperty("existingId");

    // Verify command is regenerated from settings (doesn't include old prompt)
    // Non-flag values are shell-escaped by generateAgentCommand (platform-dependent quoting)
    expect(callArgs.command).toBe(`claude --model ${escapeShellArg("sonnet-4")}`);
    expect(callArgs.command).not.toContain("-p");
    expect(callArgs.command).not.toContain("Old prompt");

    // Verify NO DISCONNECTED error was set (silent respawn)
    expect(setSpawnErrorMock).not.toHaveBeenCalled();
  });

  it("reconnects via fallback when getForProject misses the terminal but reconnect finds it", async () => {
    // This test verifies the reconnect fallback path - when getForProject doesn't
    // return a terminal (e.g., due to project ID mismatch), but the terminal
    // still exists in the backend and can be reconnected via direct ID lookup.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "agent",
            type: "claude",
            agentId: "claude",
            title: "Claude Agent",
            cwd: "/project",
            location: "grid",
            command: "claude",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // getForProject returns empty (simulating project ID mismatch)
    terminalClientMock.getForProject.mockResolvedValue([]);

    // But reconnect finds the terminal in the backend
    terminalClientMock.reconnect.mockResolvedValue({
      exists: true,
      id: "agent-1",
      projectId: "project-1",
      kind: "agent",
      type: "claude",
      agentId: "claude",
      title: "Claude Agent",
      cwd: "/project",
      worktreeId: undefined,
      agentState: "waiting",
      lastStateChange: 123456789,
      spawnedAt: 123456000,
      activityTier: "background",
      hasPty: true,
    });

    const addTerminal = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    // Should have called reconnect for the agent panel
    expect(terminalClientMock.reconnect).toHaveBeenCalledWith("agent-1");

    // Should reconnect with existingId, not respawn with requestedId
    expect(addTerminal).toHaveBeenCalledTimes(1);
    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agent",
        agentId: "claude",
        existingId: "agent-1", // reconnect path uses existingId
        agentState: "waiting",
        lastStateChange: 123456789,
      })
    );

    // Should NOT have requestedId (that's the respawn path)
    expect(addTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({
        requestedId: "agent-1",
      })
    );

    // Should initialize backend tier from reconnect result
    expect(initializeBackendTierMock).toHaveBeenCalledWith("agent-1", "background");

    // Should restore terminal content
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("agent-1");
  });

  it("restores backend terminal snapshots concurrently during hydration", async () => {
    let releaseFirstRestore!: () => void;
    const firstRestore = new Promise<void>((resolve) => {
      releaseFirstRestore = resolve;
    });
    fetchAndRestoreMock.mockImplementation((terminalId: string) => {
      if (terminalId === "terminal-1") {
        return firstRestore;
      }
      return Promise.resolve();
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            type: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "terminal-2",
            kind: "terminal",
            type: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 1",
      },
      {
        id: "terminal-2",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 2",
      },
    ]);

    const addTerminal = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    const hydrationPromise = hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    for (let i = 0; i < 30; i += 1) {
      if (fetchAndRestoreMock.mock.calls.length >= 2) {
        break;
      }
      await Promise.resolve();
    }

    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-1");
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-2");

    releaseFirstRestore();
    await hydrationPromise;
  });

  it("uses batch serialized state restore when available", async () => {
    terminalClientMock.getSerializedStates.mockResolvedValue({
      "terminal-1": "serialized-1",
      "terminal-2": "serialized-2",
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "terminal-2",
            kind: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 1",
      },
      {
        id: "terminal-2",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 2",
      },
    ]);

    const addTerminal = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    await hydrateAppState({
      addTerminal,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    expect(terminalClientMock.getSerializedStates).toHaveBeenCalledWith([
      "terminal-1",
      "terminal-2",
    ]);
    expect(restoreFetchedStateMock).toHaveBeenCalledWith("terminal-1", "serialized-1");
    expect(restoreFetchedStateMock).toHaveBeenCalledWith("terminal-2", "serialized-2");
    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("prefetches worktrees and tab groups while snapshot restoration is in progress", async () => {
    let releaseRestore!: () => void;
    fetchAndRestoreMock.mockImplementation((terminalId: string) => {
      if (terminalId === "terminal-1") {
        return new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
      }
      return Promise.resolve();
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
            worktreeId: "wt-active",
          },
        ],
        activeWorktreeId: "wt-active",
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 1",
        worktreeId: "wt-active",
      },
    ]);

    const addTerminal = vi.fn(async (options: { existingId?: string }) => {
      return options.existingId ?? "terminal-id";
    });

    const hydrationPromise = hydrateAppState({
      addTerminal,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
      hydrateTabGroups: vi.fn(),
    });

    for (let i = 0; i < 30; i += 1) {
      if (fetchAndRestoreMock.mock.calls.length > 0) {
        break;
      }
      await Promise.resolve();
    }

    expect(worktreeClientMock.getAll).toHaveBeenCalledTimes(1);
    expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");

    releaseRestore();
    await hydrationPromise;
  });

  it("defers non-critical snapshot restoration during project-switch hydration", async () => {
    vi.useFakeTimers();
    try {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "terminal-active",
              kind: "terminal",
              title: "Active",
              cwd: "/project",
              location: "grid",
              worktreeId: "wt-active",
            },
            {
              id: "terminal-background",
              kind: "terminal",
              title: "Background",
              cwd: "/project",
              location: "grid",
              worktreeId: "wt-background",
            },
            {
              id: "terminal-dock",
              kind: "terminal",
              title: "Dock",
              cwd: "/project",
              location: "dock",
              worktreeId: "wt-background",
            },
          ],
          activeWorktreeId: "wt-active",
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "terminal-active",
          hasPty: true,
          cwd: "/project",
          kind: "terminal",
          title: "Active",
          worktreeId: "wt-active",
        },
        {
          id: "terminal-background",
          hasPty: true,
          cwd: "/project",
          kind: "terminal",
          title: "Background",
          worktreeId: "wt-background",
        },
        {
          id: "terminal-dock",
          hasPty: true,
          cwd: "/project",
          kind: "terminal",
          title: "Dock",
          worktreeId: "wt-background",
        },
      ]);

      const addTerminal = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
        return options.existingId ?? options.requestedId ?? "terminal-id";
      });

      await hydrateAppState(
        {
          addTerminal,
          setActiveWorktree: vi.fn(),
          loadRecipes: vi.fn().mockResolvedValue(undefined),
          openDiagnosticsDock: vi.fn(),
        },
        "switch-1",
        () => true
      );

      expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-active");
      expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-dock");
      expect(fetchAndRestoreMock).not.toHaveBeenCalledWith("terminal-background");

      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();

      expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-background");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips snapshot fetch for warm cached terminal instances during switch-back hydration", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-cached",
            kind: "terminal",
            title: "Cached Terminal",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-cached",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Cached Terminal",
      },
    ]);

    isTerminalWarmInProjectSwitchCacheMock.mockReturnValue(true);
    getManagedTerminalMock.mockReturnValue({ id: "terminal-cached" });

    const addTerminal = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    await hydrateAppState(
      {
        addTerminal,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-cached",
      () => true
    );

    expect(addTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        existingId: "terminal-cached",
      })
    );
    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    expect(terminalClientMock.getSerializedStates).not.toHaveBeenCalled();
  });

  it("does not block project-switch hydration on recipe loading", async () => {
    let resolveRecipes!: () => void;
    const pendingRecipes = new Promise<void>((resolve) => {
      resolveRecipes = resolve;
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const hydratePromise = hydrateAppState(
      {
        addTerminal: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockReturnValue(pendingRecipes),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-2",
      () => true
    );

    await expect(hydratePromise).resolves.toBeUndefined();
    resolveRecipes();
    await pendingRecipes;
  });

  it("waits for recipe loading during initial hydration", async () => {
    let resolveRecipes!: () => void;
    const pendingRecipes = new Promise<void>((resolve) => {
      resolveRecipes = resolve;
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    let hydrationComplete = false;
    const hydratePromise = hydrateAppState({
      addTerminal: vi.fn().mockResolvedValue("terminal-id"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockReturnValue(pendingRecipes),
      openDiagnosticsDock: vi.fn(),
    }).then(() => {
      hydrationComplete = true;
    });

    await Promise.resolve();
    expect(hydrationComplete).toBe(false);

    resolveRecipes();
    await hydratePromise;
    expect(hydrationComplete).toBe(true);
  });

  it("loads and hydrates persisted tab groups after terminal restore", async () => {
    // This test verifies that tab groups are loaded from project storage
    // and passed to the hydrateTabGroups callback after terminals are restored.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "terminal-2",
            kind: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // Set up persisted tab groups
    const persistedTabGroups = [
      {
        id: "group-1",
        location: "grid",
        worktreeId: undefined,
        activeTabId: "terminal-1",
        panelIds: ["terminal-1", "terminal-2"],
      },
    ];
    projectClientMock.getTabGroups.mockResolvedValue(persistedTabGroups);

    const addTerminal = vi.fn().mockResolvedValue("terminal-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // Verify tab groups were fetched for the current project
    expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");

    // Verify hydrateTabGroups was called with the persisted groups
    expect(hydrateTabGroups).toHaveBeenCalledTimes(1);
    expect(hydrateTabGroups).toHaveBeenCalledWith(persistedTabGroups);
  });

  it("clears tab groups when no persisted groups exist", async () => {
    // When there are no persisted tab groups, hydrateTabGroups should be
    // called with an empty array to clear any stale state.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    projectClientMock.getTabGroups.mockResolvedValue([]);

    const addTerminal = vi.fn().mockResolvedValue("terminal-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // Should still call hydrateTabGroups with empty array to clear stale groups
    expect(hydrateTabGroups).toHaveBeenCalledWith([]);
  });

  it("clears tab groups on error fetching persisted groups", async () => {
    // When fetching tab groups fails, hydrateTabGroups should be called
    // with an empty array to prevent stale state.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    projectClientMock.getTabGroups.mockRejectedValue(new Error("Storage error"));

    const addTerminal = vi.fn().mockResolvedValue("terminal-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // Should call hydrateTabGroups with empty array and skipPersist on error
    expect(hydrateTabGroups).toHaveBeenCalledWith([], { skipPersist: true });
  });

  it("uses resume command when agent panel has agentSessionId and no backend process", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "agent",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude --model sonnet-4",
            agentSessionId: "session-uuid-123",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: { customFlags: "--model sonnet-4" },
        },
      },
    });

    const addTerminal = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    const callArgs = addTerminal.mock.calls[0][0];

    // Should use resume command instead of regenerated command
    expect(callArgs.command).toBe("claude --resume session-uuid-123");
    expect(callArgs.command).not.toContain("--model");
    expect(callArgs.command).not.toContain("sonnet-4");

    // agentSessionId should NOT be forwarded (cleared on respawn)
    expect(callArgs.agentSessionId).toBeUndefined();
  });

  it("uses fresh command when agent panel has no agentSessionId", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "agent",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: { customFlags: "--model sonnet-4" },
        },
      },
    });

    const addTerminal = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    const callArgs = addTerminal.mock.calls[0][0];

    // Should use fresh generated command (no resume)
    expect(callArgs.command).toContain("--model");
    expect(callArgs.command).not.toContain("--resume");
  });

  it("preserves agentSessionId on successful reconnect to live backend", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "agent",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude",
            agentSessionId: "session-uuid-456",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // Backend has the terminal running
    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "agent-1",
        hasPty: true,
        cwd: "/project",
        kind: "agent",
        type: "claude",
        agentId: "claude",
        title: "Claude",
        agentState: "waiting",
        lastStateChange: 123456789,
      },
    ]);

    const addTerminal = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    const callArgs = addTerminal.mock.calls[0][0];

    // On reconnect, agentSessionId should be preserved
    expect(callArgs.existingId).toBe("agent-1");
    expect(callArgs.agentSessionId).toBe("session-uuid-456");
  });

  it("restores active worktree panels before background worktree panels", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "bg-1",
            title: "BG Terminal 1",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
          {
            id: "bg-2",
            title: "BG Terminal 2",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
          {
            id: "active-1",
            title: "Active Terminal",
            cwd: "/project",
            worktreeId: "wt-active",
            location: "grid",
            type: "terminal",
          },
          {
            id: "bg-3",
            title: "BG Terminal 3",
            cwd: "/project",
            worktreeId: "wt-bg2",
            location: "grid",
            type: "terminal",
          },
        ],
        activeWorktreeId: "wt-active",
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "bg-1",
        cwd: "/project",
        worktreeId: "wt-bg",
        title: "BG Terminal 1",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "bg-2",
        cwd: "/project",
        worktreeId: "wt-bg",
        title: "BG Terminal 2",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "active-1",
        cwd: "/project",
        worktreeId: "wt-active",
        title: "Active Terminal",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "bg-3",
        cwd: "/project",
        worktreeId: "wt-bg2",
        title: "BG Terminal 3",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addTerminal = vi.fn().mockImplementation((opts: { existingId?: string }) => {
      callOrder.push(opts.existingId ?? "unknown");
      return Promise.resolve(opts.existingId ?? "id");
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(4);

    // Active worktree panel should be restored first
    expect(callOrder[0]).toBe("active-1");

    // Background panels should come after
    expect(callOrder.slice(1).sort()).toEqual(["bg-1", "bg-2", "bg-3"]);
  });

  it("passes restore: true on respawned terminals", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-1",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
            type: "terminal",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // No backend terminal → will attempt reconnect fallback → respawn
    terminalClientMock.getForProject.mockResolvedValue([]);

    const addTerminal = vi.fn().mockResolvedValue("term-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    const callArgs = addTerminal.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.restore).toBe(true);
  });

  it("does not pass restore on reconnected terminals", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-1",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
            type: "terminal",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "term-1",
        cwd: "/project",
        title: "Terminal 1",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addTerminal = vi.fn().mockResolvedValue("term-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(1);
    const callArgs = addTerminal.mock.calls[0][0] as Record<string, unknown>;
    // Reconnects should not have restore flag
    expect(callArgs.restore).toBeUndefined();
  });

  it("isolates failures within a batch using Promise.allSettled semantics", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "fail-1",
            title: "Fail Terminal",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
          {
            id: "success-1",
            title: "Success Terminal",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
        ],
        activeWorktreeId: "wt-active",
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // No backend terminals → respawn path
    terminalClientMock.getForProject.mockResolvedValue([]);

    let callCount = 0;
    const addTerminal = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Spawn failed"));
      }
      return Promise.resolve("success-1");
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    // Should not throw despite first panel failing
    await expect(
      hydrateAppState({
        addTerminal,
        setActiveWorktree,
        loadRecipes,
        openDiagnosticsDock,
      })
    ).resolves.toBeUndefined();

    // Both should have been attempted
    expect(addTerminal).toHaveBeenCalledTimes(2);
  });

  it("restores non-PTY panels before PTY panels are added", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-1",
            kind: "terminal",
            title: "Terminal",
            cwd: "/project",
            location: "grid",
            type: "terminal",
          },
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "notes-1",
            kind: "notes",
            title: "Notes",
            cwd: "/project",
            location: "grid",
            noteId: "note-abc",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "term-1",
        cwd: "/project",
        title: "Terminal",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addTerminal = vi
      .fn()
      .mockImplementation((opts: { kind?: string; requestedId?: string; existingId?: string }) => {
        callOrder.push(opts.kind ?? "unknown");
        return Promise.resolve(opts.requestedId ?? opts.existingId ?? "id");
      });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(3);

    // Non-PTY panels (browser, notes) should be restored before PTY panel (terminal)
    const terminalIndex = callOrder.indexOf("terminal");
    const browserIndex = callOrder.indexOf("browser");
    const notesIndex = callOrder.indexOf("notes");

    expect(browserIndex).toBeLessThan(terminalIndex);
    expect(notesIndex).toBeLessThan(terminalIndex);
  });

  it("preserves order for all-non-PTY panel workspace", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser 1",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "notes-1",
            kind: "notes",
            title: "Notes 1",
            cwd: "/project",
            location: "grid",
            noteId: "note-1",
          },
          {
            id: "dev-preview-1",
            kind: "dev-preview",
            title: "Dev Preview",
            cwd: "/project",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addTerminal = vi.fn().mockImplementation((opts: { requestedId?: string }) => {
      return Promise.resolve(opts.requestedId ?? "id");
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(3);

    // All three non-PTY panels should be restored with correct kinds in order
    expect(addTerminal.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: "browser", requestedId: "browser-1" })
    );
    expect(addTerminal.mock.calls[1][0]).toEqual(
      expect.objectContaining({ kind: "notes", requestedId: "notes-1" })
    );
    expect(addTerminal.mock.calls[2][0]).toEqual(
      expect.objectContaining({ kind: "dev-preview", requestedId: "dev-preview-1" })
    );
  });

  it("restores non-PTY panels from mixed worktrees concurrently before PTY panels", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-active",
            kind: "terminal",
            title: "Active Terminal",
            cwd: "/project",
            worktreeId: "wt-active",
            location: "grid",
            type: "terminal",
          },
          {
            id: "browser-bg",
            kind: "browser",
            title: "BG Browser",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "notes-active",
            kind: "notes",
            title: "Active Notes",
            cwd: "/project",
            worktreeId: "wt-active",
            location: "grid",
            noteId: "note-1",
          },
          {
            id: "term-bg",
            kind: "terminal",
            title: "BG Terminal",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
        ],
        activeWorktreeId: "wt-active",
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "term-active",
        cwd: "/project",
        worktreeId: "wt-active",
        title: "Active Terminal",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "term-bg",
        cwd: "/project",
        worktreeId: "wt-bg",
        title: "BG Terminal",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addTerminal = vi
      .fn()
      .mockImplementation((opts: { kind?: string; requestedId?: string; existingId?: string }) => {
        callOrder.push(`${opts.kind}:${opts.requestedId ?? opts.existingId}`);
        return Promise.resolve(opts.requestedId ?? opts.existingId ?? "id");
      });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(4);

    // Both non-PTY panels (from different worktrees) should come before either PTY panel
    const browserIdx = callOrder.findIndex((c) => c.startsWith("browser:"));
    const notesIdx = callOrder.findIndex((c) => c.startsWith("notes:"));
    const firstPtyIdx = callOrder.findIndex((c) => c.startsWith("terminal:"));

    expect(browserIdx).toBeLessThan(firstPtyIdx);
    expect(notesIdx).toBeLessThan(firstPtyIdx);
  });

  it("treats dev-preview with backend terminal as PTY-grouped", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "dev-preview-1",
            kind: "dev-preview",
            title: "Dev Preview",
            cwd: "/project",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // dev-preview-1 has a live backend terminal — should be treated as PTY
    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "dev-preview-1",
        cwd: "/project",
        title: "Dev Preview",
        type: "dev-preview",
        kind: "dev-preview",
      },
    ]);

    const addTerminal = vi
      .fn()
      .mockImplementation((opts: { kind?: string; requestedId?: string; existingId?: string }) => {
        callOrder.push(opts.kind ?? "unknown");
        return Promise.resolve(opts.requestedId ?? opts.existingId ?? "id");
      });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addTerminal).toHaveBeenCalledTimes(2);

    // Browser (non-PTY, no backend) should come before dev-preview (has backend terminal)
    const browserIdx = callOrder.indexOf("browser");
    const devPreviewIdx = callOrder.indexOf("dev-preview");

    expect(browserIdx).toBeLessThan(devPreviewIdx);
  });
});
