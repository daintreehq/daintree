// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const appClientMock = {
  hydrate: vi.fn(),
};

const terminalClientMock = {
  getForProject: vi.fn(),
  reconnect: vi.fn(),
};

const worktreeClientMock = {
  getAll: vi.fn(),
};

const projectClientMock = {
  getTabGroups: vi.fn(),
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

vi.mock("@/clients", () => ({
  appClient: appClientMock,
  terminalClient: terminalClientMock,
  worktreeClient: worktreeClientMock,
  projectClient: projectClientMock,
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
    initializeBackendTier: initializeBackendTierMock,
  },
}));

const { hydrateAppState } = await import("../stateHydration");

describe("hydrateAppState", () => {
  const project = { id: "project-1", path: "/project" };
  const terminalConfig = { scrollbackLines: 1000, performanceMode: false };
  const agentSettings = { agents: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    worktreeClientMock.getAll.mockResolvedValue([]);
    projectClientMock.getTabGroups.mockResolvedValue([]);
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
      })
    );
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
    expect(callArgs.command).toBe("claude --model sonnet-4");
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
});
