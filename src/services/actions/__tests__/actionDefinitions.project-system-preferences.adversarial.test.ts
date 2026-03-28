import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

const mocks = vi.hoisted(() => ({
  projectClient: {
    openDialog: vi.fn(),
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    detectRunners: vi.fn(),
    getStats: vi.fn(),
  },
  systemClient: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    checkCommand: vi.fn(),
    checkDirectory: vi.fn(),
    getHomeDir: vi.fn(),
  },
  cliAvailabilityClient: {
    get: vi.fn(),
    refresh: vi.fn(),
  },
  filesClient: {
    search: vi.fn(),
  },
  slashCommandsClient: {
    list: vi.fn(),
  },
  artifactClient: {
    saveToFile: vi.fn(),
    applyPatch: vi.fn(),
  },
  copyTreeClient: {
    isAvailable: vi.fn(),
    generate: vi.fn(),
    generateAndCopyFile: vi.fn(),
    injectToTerminal: vi.fn(),
    cancel: vi.fn(),
    getFileTree: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn(),
    set: vi.fn(),
    reset: vi.fn(),
  },
  appClient: {
    quit: vi.fn(),
    forceQuit: vi.fn(),
  },
  hibernationClient: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
  },
  terminalConfigClient: {
    get: vi.fn(),
    setScrollback: vi.fn(),
    setPerformanceMode: vi.fn(),
    setFontSize: vi.fn(),
    setFontFamily: vi.fn(),
    setHybridInputEnabled: vi.fn(),
    setHybridInputAutoFocus: vi.fn(),
    setScreenReaderMode: vi.fn(),
  },
  worktreeConfigClient: {
    get: vi.fn(),
    setPattern: vi.fn(),
  },
  keybindingService: {
    loadOverrides: vi.fn(),
    getOverridesSnapshot: vi.fn(),
    setOverride: vi.fn(),
    removeOverride: vi.fn(),
    resetAllOverrides: vi.fn(),
  },
  electronWindow: {
    toggleFullscreen: vi.fn(),
    reload: vi.fn(),
    forceReload: vi.fn(),
    toggleDevTools: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    close: vi.fn(),
  },
  events: {
    emit: vi.fn(),
  },
}));

vi.hoisted(() => {
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

  class EventMock {
    type: string;

    constructor(type: string) {
      this.type = type;
    }
  }

  class CustomEventMock<T = unknown> extends EventMock {
    detail: T | undefined;

    constructor(type: string, init?: CustomEventInit<T>) {
      super(type);
      this.detail = init?.detail;
    }
  }

  class KeyboardEventMock extends EventMock {
    key: string | undefined;

    constructor(type: string, init?: KeyboardEventInit) {
      super(type);
      this.key = init?.key;
    }
  }

  const windowMock = {
    electron: {
      events: mocks.events,
      window: mocks.electronWindow,
    },
    localStorage: localStorageMock,
    dispatchEvent: vi.fn(() => true),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  Object.defineProperty(globalThis, "window", {
    value: windowMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    value: CustomEventMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "KeyboardEvent", {
    value: KeyboardEventMock,
    configurable: true,
    writable: true,
  });
});

vi.mock("@/clients", () => ({
  projectClient: mocks.projectClient,
  systemClient: mocks.systemClient,
  cliAvailabilityClient: mocks.cliAvailabilityClient,
  filesClient: mocks.filesClient,
  slashCommandsClient: mocks.slashCommandsClient,
  artifactClient: mocks.artifactClient,
  copyTreeClient: mocks.copyTreeClient,
  agentSettingsClient: mocks.agentSettingsClient,
  appClient: mocks.appClient,
  hibernationClient: mocks.hibernationClient,
  terminalConfigClient: mocks.terminalConfigClient,
  worktreeConfigClient: mocks.worktreeConfigClient,
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: mocks.keybindingService,
}));

const { registerProjectActions } = await import("../definitions/projectActions");
const { registerSystemActions } = await import("../definitions/systemActions");
const { registerPreferencesActions } = await import("../definitions/preferencesActions");
const { useProjectStore } = await import("@/store/projectStore");
const { usePreferencesStore } = await import("@/store/preferencesStore");
const { useAgentSettingsStore } = await import("@/store/agentSettingsStore");
const { useScrollbackStore } = await import("@/store/scrollbackStore");
const { useTerminalFontStore } = await import("@/store/terminalFontStore");
const { useTerminalInputStore } = await import("@/store/terminalInputStore");
const { usePerformanceModeStore } = await import("@/store/performanceModeStore");
const { useScreenReaderStore } = await import("@/store/screenReaderStore");

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

function buildService(
  register: (actions: ActionRegistry, callbacks: ActionCallbacks) => void,
  callbacks: Partial<ActionCallbacks> = {}
): { actions: ActionRegistry; service: ActionService; callbacks: ActionCallbacks } {
  const resolvedCallbacks = createCallbacks(callbacks);
  const actions: ActionRegistry = new Map();
  register(actions, resolvedCallbacks);
  const service = new ActionService();

  for (const factory of actions.values()) {
    service.register(factory());
  }

  return { actions, service, callbacks: resolvedCallbacks };
}

function expectRegistryToMatchIds(actions: ActionRegistry, expectedIds: ActionId[]): void {
  expect(Array.from(actions.keys()).sort()).toEqual([...expectedIds].sort());

  for (const [id, factory] of actions.entries()) {
    expect(factory().id).toBe(id);
  }
}

beforeEach(() => {
  vi.clearAllMocks();

  Object.defineProperty(window, "electron", {
    value: {
      events: mocks.events,
      window: mocks.electronWindow,
    },
    configurable: true,
    writable: true,
  });

  useProjectStore.setState({
    addProject: vi.fn().mockResolvedValue(undefined),
    addProjectByPath: vi.fn().mockResolvedValue(undefined),
    switchProject: vi.fn().mockResolvedValue(undefined),
    updateProject: vi.fn().mockResolvedValue(undefined),
    removeProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue({ success: true }),
  });

  usePreferencesStore.setState({
    showProjectPulse: true,
    showDeveloperTools: false,
  });

  useAgentSettingsStore.setState({
    settings: { agents: { codex: { selected: true } } },
    isLoading: true,
    error: "stale",
    isInitialized: false,
  });

  useScrollbackStore.setState({ scrollbackLines: 1000 });
  usePerformanceModeStore.setState({ performanceMode: false });
  useTerminalFontStore.setState({ fontSize: 14, fontFamily: "JetBrains Mono" });
  useTerminalInputStore.setState({
    hybridInputEnabled: true,
    hybridInputAutoFocus: true,
  });
  useScreenReaderStore.setState({ screenReaderMode: "auto", osAccessibilityEnabled: false });
});

describe("project action hardening", () => {
  it("registers the full project action surface without stale IDs", () => {
    const actions = buildRegistry(registerProjectActions);

    expectRegistryToMatchIds(actions, [
      "project.switcherPalette",
      "project.add",
      "project.openDialog",
      "project.switch",
      "project.update",
      "project.remove",
      "project.close",
      "project.getAll",
      "project.getCurrent",
      "project.getSettings",
      "project.saveSettings",
      "project.detectRunners",
      "project.getStats",
      "project.cloneRepo",
      "project.settings.open",
    ]);
  });

  it("routes blank and trimmed project.add paths to the correct store methods", async () => {
    const { service } = buildService(registerProjectActions);
    const state = useProjectStore.getState();

    const blankResult = await service.dispatch("project.add");
    expect(blankResult).toEqual({ ok: true, result: undefined });
    expect(state.addProject).toHaveBeenCalledTimes(1);
    expect(state.addProjectByPath).not.toHaveBeenCalled();

    const trimmedResult = await service.dispatch("project.add", { path: "   /tmp/repo   " });
    expect(trimmedResult).toEqual({ ok: true, result: undefined });
    expect(state.addProjectByPath).toHaveBeenCalledWith("/tmp/repo");
  });

  it("rejects unconfirmed agent project switches before mutating store state", async () => {
    const { service } = buildService(registerProjectActions);
    const state = useProjectStore.getState();

    const result = await service.dispatch(
      "project.switch",
      { projectId: "project-1" },
      { source: "agent" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
    }
    expect(state.switchProject).not.toHaveBeenCalled();
  });

  it("wraps project store failures as execution errors", async () => {
    const switchProject = vi.fn().mockRejectedValue(new Error("missing project"));
    useProjectStore.setState({ switchProject });
    const { service } = buildService(registerProjectActions);

    const result = await service.dispatch("project.switch", { projectId: "missing" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      expect(result.error.message).toBe("missing project");
    }
  });

  it("passes through project client queries and dispatches settings events", async () => {
    mocks.projectClient.getSettings.mockResolvedValueOnce({ theme: "dark" });
    mocks.projectClient.detectRunners.mockResolvedValueOnce(["dev"]);
    mocks.projectClient.getStats.mockResolvedValueOnce({ files: 12 });
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const { service } = buildService(registerProjectActions);

    await expect(
      service.dispatch("project.getSettings", { projectId: "project-1" })
    ).resolves.toEqual({ ok: true, result: { theme: "dark" } });
    await expect(
      service.dispatch("project.detectRunners", { projectId: "project-1" })
    ).resolves.toEqual({ ok: true, result: ["dev"] });
    await expect(service.dispatch("project.getStats", { projectId: "project-1" })).resolves.toEqual(
      { ok: true, result: { files: 12 } }
    );

    const openSettings = await service.dispatch("project.settings.open");
    expect(openSettings).toEqual({ ok: true, result: undefined });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect(dispatchEvent.mock.calls.at(-1)?.[0].type).toBe("canopy:open-project-settings");
  });
});

describe("system action hardening", () => {
  it("registers the full system action surface and fixes stale description IDs", () => {
    const actions = buildRegistry(registerSystemActions);

    expectRegistryToMatchIds(actions, [
      "system.openExternal",
      "system.openPath",
      "system.checkCommand",
      "system.checkDirectory",
      "system.getHomeDir",
      "cliAvailability.get",
      "cliAvailability.refresh",
      "files.search",
      "slashCommands.list",
      "artifact.saveToFile",
      "artifact.applyPatch",
      "copyTree.isAvailable",
      "copyTree.generate",
      "copyTree.generateAndCopyFile",
      "copyTree.injectToTerminal",
      "copyTree.cancel",
      "copyTree.getFileTree",
    ]);

    const filesSearch = actions.get("files.search")!();
    expect(filesSearch.description).toContain("project.getCurrent");
    expect(filesSearch.description).not.toContain("project_getCurrent");
  });

  it("passes through system and copyTree client arguments/results", async () => {
    mocks.systemClient.checkCommand.mockResolvedValueOnce(true);
    mocks.filesClient.search.mockResolvedValueOnce(["src/main.ts"]);
    mocks.slashCommandsClient.list.mockResolvedValueOnce(["/review"]);
    mocks.copyTreeClient.generate.mockResolvedValueOnce("tree");
    mocks.copyTreeClient.injectToTerminal.mockResolvedValueOnce({ injected: true });
    mocks.copyTreeClient.getFileTree.mockResolvedValueOnce([{ path: "src", type: "directory" }]);
    const { service } = buildService(registerSystemActions);

    await expect(service.dispatch("system.checkCommand", { command: "git" })).resolves.toEqual({
      ok: true,
      result: true,
    });
    await expect(
      service.dispatch("files.search", { cwd: "/repo", query: "main", limit: 5 })
    ).resolves.toEqual({ ok: true, result: ["src/main.ts"] });
    await expect(
      service.dispatch("slashCommands.list", { agentId: "codex", projectPath: "/repo" })
    ).resolves.toEqual({ ok: true, result: ["/review"] });
    await expect(
      service.dispatch("copyTree.generate", {
        worktreeId: "wt-1",
        options: { includeGitStatus: true },
      })
    ).resolves.toEqual({ ok: true, result: "tree" });
    await expect(
      service.dispatch("copyTree.injectToTerminal", {
        terminalId: "term-1",
        worktreeId: "wt-1",
        options: { includeGitStatus: true },
      })
    ).resolves.toEqual({ ok: true, result: { injected: true } });
    await expect(
      service.dispatch("copyTree.getFileTree", { worktreeId: "wt-1", dirPath: "src" })
    ).resolves.toEqual({ ok: true, result: [{ path: "src", type: "directory" }] });
  });

  it("keeps confirmation gates on destructive system actions for agent sources", async () => {
    const { service } = buildService(registerSystemActions);

    const result = await service.dispatch(
      "artifact.applyPatch",
      { patchContent: "--- a\n+++ b", cwd: "/repo" },
      { source: "agent" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
    }
    expect(mocks.artifactClient.applyPatch).not.toHaveBeenCalled();
  });

  it("propagates downstream copyTree errors through ActionService", async () => {
    mocks.copyTreeClient.generateAndCopyFile.mockRejectedValueOnce(
      new Error("clipboard unavailable")
    );
    const { service } = buildService(registerSystemActions);

    const result = await service.dispatch(
      "copyTree.generateAndCopyFile",
      { worktreeId: "wt-1" },
      { source: "user", confirmed: true }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      expect(result.error.message).toBe("clipboard unavailable");
    }
  });
});

describe("preferences action hardening", () => {
  it("registers the full preferences action surface, including shortcut aliases", () => {
    const actions = buildRegistry(registerPreferencesActions);

    expectRegistryToMatchIds(actions, [
      "preferences.showProjectPulse.set",
      "preferences.showDeveloperTools.set",
      "preferences.showGridAgentHighlights.set",
      "preferences.showDockAgentHighlights.set",
      "window.toggleFullscreen",
      "window.reload",
      "window.forceReload",
      "window.toggleDevTools",
      "window.zoomIn",
      "window.zoomOut",
      "window.zoomReset",
      "window.close",
      "hibernation.getConfig",
      "hibernation.updateConfig",
      "agentSettings.get",
      "agentSettings.set",
      "agentSettings.reset",
      "keybinding.getOverrides",
      "keybinding.setOverride",
      "keybinding.removeOverride",
      "keybinding.resetAll",
      "terminalConfig.get",
      "terminalConfig.setScrollback",
      "terminalConfig.setPerformanceMode",
      "terminalConfig.setFontSize",
      "terminalConfig.setFontFamily",
      "terminalConfig.setHybridInputEnabled",
      "terminalConfig.setHybridInputAutoFocus",
      "terminalConfig.setScreenReaderMode",
      "worktreeConfig.get",
      "worktreeConfig.setPattern",
      "help.shortcuts",
      "help.shortcutsAlt",
      "modal.close",
      "app.quit",
      "app.forceQuit",
    ]);
  });

  it("keeps help shortcut aliases wired to the same callback", async () => {
    const callbacks = createCallbacks();
    const actions: ActionRegistry = new Map();
    registerPreferencesActions(actions, callbacks);

    await actions.get("help.shortcuts")!().run(undefined, {} as never);
    await actions.get("help.shortcutsAlt")!().run(undefined, {} as never);

    expect(callbacks.onOpenShortcuts).toHaveBeenCalledTimes(2);
  });

  it("updates local preference toggles immediately", async () => {
    const { service } = buildService(registerPreferencesActions);

    await expect(
      service.dispatch("preferences.showProjectPulse.set", { show: false })
    ).resolves.toEqual({ ok: true, result: undefined });
    await expect(
      service.dispatch("preferences.showDeveloperTools.set", { show: true })
    ).resolves.toEqual({ ok: true, result: undefined });

    expect(usePreferencesStore.getState().showProjectPulse).toBe(false);
    expect(usePreferencesStore.getState().showDeveloperTools).toBe(true);

    await expect(
      service.dispatch("preferences.showGridAgentHighlights.set", { show: true })
    ).resolves.toEqual({ ok: true, result: undefined });
    await expect(
      service.dispatch("preferences.showDockAgentHighlights.set", { show: true })
    ).resolves.toEqual({ ok: true, result: undefined });

    expect(usePreferencesStore.getState().showGridAgentHighlights).toBe(true);
    expect(usePreferencesStore.getState().showDockAgentHighlights).toBe(true);
  });

  it.each([
    {
      actionId: "terminalConfig.setScrollback" as const,
      successArgs: { scrollbackLines: 2000 },
      failureArgs: { scrollbackLines: 9000 },
      read: () => useScrollbackStore.getState().scrollbackLines,
      initial: 1000,
      expected: 2000,
      clientMock: mocks.terminalConfigClient.setScrollback,
    },
    {
      actionId: "terminalConfig.setPerformanceMode" as const,
      successArgs: { performanceMode: true },
      failureArgs: { performanceMode: false },
      read: () => usePerformanceModeStore.getState().performanceMode,
      initial: false,
      expected: true,
      clientMock: mocks.terminalConfigClient.setPerformanceMode,
    },
    {
      actionId: "terminalConfig.setFontSize" as const,
      successArgs: { fontSize: 18 },
      failureArgs: { fontSize: 24 },
      read: () => useTerminalFontStore.getState().fontSize,
      initial: 14,
      expected: 18,
      clientMock: mocks.terminalConfigClient.setFontSize,
    },
    {
      actionId: "terminalConfig.setFontFamily" as const,
      successArgs: { fontFamily: "Fira Code" },
      failureArgs: { fontFamily: "Monaco" },
      read: () => useTerminalFontStore.getState().fontFamily,
      initial: "JetBrains Mono",
      expected: "Fira Code",
      clientMock: mocks.terminalConfigClient.setFontFamily,
    },
    {
      actionId: "terminalConfig.setHybridInputEnabled" as const,
      successArgs: { enabled: false },
      failureArgs: { enabled: true },
      read: () => useTerminalInputStore.getState().hybridInputEnabled,
      initial: true,
      expected: false,
      clientMock: mocks.terminalConfigClient.setHybridInputEnabled,
    },
    {
      actionId: "terminalConfig.setHybridInputAutoFocus" as const,
      successArgs: { enabled: false },
      failureArgs: { enabled: true },
      read: () => useTerminalInputStore.getState().hybridInputAutoFocus,
      initial: true,
      expected: false,
      clientMock: mocks.terminalConfigClient.setHybridInputAutoFocus,
    },
    {
      actionId: "terminalConfig.setScreenReaderMode" as const,
      successArgs: { mode: "on" },
      failureArgs: { mode: "off" },
      read: () => useScreenReaderStore.getState().screenReaderMode,
      initial: "auto",
      expected: "on",
      clientMock: mocks.terminalConfigClient.setScreenReaderMode,
    },
  ])("$actionId rolls state forward on success and back on failure", async (testCase) => {
    testCase.clientMock.mockResolvedValueOnce(undefined);
    const { service } = buildService(registerPreferencesActions);

    const success = await service.dispatch(testCase.actionId, testCase.successArgs);
    expect(success).toEqual({ ok: true, result: undefined });
    expect(testCase.read()).toBe(testCase.expected);

    testCase.clientMock.mockRejectedValueOnce(new Error("persist failed"));
    const failure = await service.dispatch(testCase.actionId, testCase.failureArgs);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe("EXECUTION_ERROR");
      expect(failure.error.message).toBe("persist failed");
    }
    expect(testCase.read()).toBe(testCase.expected);
  });

  it("updates agent settings store only after successful client responses", async () => {
    mocks.agentSettingsClient.get.mockResolvedValueOnce({ agents: { codex: { selected: false } } });
    mocks.agentSettingsClient.set.mockResolvedValueOnce({ agents: { codex: { selected: true } } });
    mocks.agentSettingsClient.reset.mockRejectedValueOnce(new Error("reset failed"));
    const { service } = buildService(registerPreferencesActions);

    await expect(service.dispatch("agentSettings.get")).resolves.toEqual({
      ok: true,
      result: { agents: { codex: { selected: false } } },
    });
    expect(useAgentSettingsStore.getState()).toMatchObject({
      settings: { agents: { codex: { selected: false } } },
      isLoading: false,
      error: null,
      isInitialized: true,
    });

    await expect(
      service.dispatch("agentSettings.set", {
        agentId: "codex",
        settings: { selected: true },
      })
    ).resolves.toEqual({
      ok: true,
      result: { agents: { codex: { selected: true } } },
    });
    expect(useAgentSettingsStore.getState().settings).toEqual({
      agents: { codex: { selected: true } },
    });

    const failure = await service.dispatch("agentSettings.reset");
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe("EXECUTION_ERROR");
      expect(failure.error.message).toBe("reset failed");
    }
    expect(useAgentSettingsStore.getState().settings).toEqual({
      agents: { codex: { selected: true } },
    });
  });

  it("returns override snapshots and propagates stale action ID failures from the keybinding service", async () => {
    mocks.keybindingService.getOverridesSnapshot.mockReturnValue({ "terminal.new": ["Cmd+T"] });
    mocks.keybindingService.setOverride.mockRejectedValueOnce(
      new Error("Unknown action: stale.action")
    );
    const { service } = buildService(registerPreferencesActions);

    await expect(service.dispatch("keybinding.getOverrides")).resolves.toEqual({
      ok: true,
      result: { "terminal.new": ["Cmd+T"] },
    });

    const failure = await service.dispatch("keybinding.setOverride", {
      actionId: "stale.action",
      combo: ["Cmd+Alt+X"],
    });
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe("EXECUTION_ERROR");
      expect(failure.error.message).toBe("Unknown action: stale.action");
    }
  });

  it("calls Electron window actions directly and keeps quit actions confirmation-gated for agents", async () => {
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const { service } = buildService(registerPreferencesActions);

    await expect(service.dispatch("window.zoomIn")).resolves.toEqual({
      ok: true,
      result: undefined,
    });
    expect(mocks.electronWindow.zoomIn).toHaveBeenCalledTimes(1);

    await expect(service.dispatch("modal.close")).resolves.toEqual({ ok: true, result: undefined });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(KeyboardEvent));
    expect(dispatchEvent.mock.calls.at(-1)?.[0].type).toBe("keydown");

    const quitResult = await service.dispatch("app.quit", undefined, { source: "agent" });
    expect(quitResult.ok).toBe(false);
    if (!quitResult.ok) {
      expect(quitResult.error.code).toBe("CONFIRMATION_REQUIRED");
    }
    expect(mocks.appClient.quit).not.toHaveBeenCalled();
  });
});
