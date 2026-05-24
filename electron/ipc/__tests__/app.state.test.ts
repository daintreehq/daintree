import { describe, expect, it, vi, beforeEach } from "vitest";

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "1.0.0"), getPath: vi.fn(() => "/tmp") },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === "appState") return { terminals: [], sidebarWidth: 350 };
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    }),
    set: vi.fn(),
    delete: vi.fn(),
  },
  consumePendingSettingsRecovery: vi.fn(() => null),
  windowStatesStore: { get: vi.fn(), set: vi.fn() },
}));

const crashService = {
  scheduleBackup: vi.fn(),
  consumePanelFilter: vi.fn(() => null),
  startBackupTimer: vi.fn(),
  resetToFresh: vi.fn(),
  restoreBackup: vi.fn(() => false),
  setPanelFilter: vi.fn(),
  getPendingCrash: vi.fn() as any,
  getConfig: vi.fn(() => ({ autoRestoreOnCrash: false })),
};

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashService,
  initializeCrashRecoveryService: vi.fn(),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getProjectById: vi.fn(() => null),
    getProjectStateWithRecovery: vi.fn(),
    saveProjectState: vi.fn(),
  },
}));

vi.mock("../../utils/gpuDetection.js", () => ({
  getGpuFeatureStatus: vi.fn(() => ({ webgl2: "hardware" })),
  isWebGLHardwareAccelerated: vi.fn(() => true),
}));

vi.mock("../../services/GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
  isGpuAngleFallbackApplied: vi.fn(() => false),
}));

const crashGuard = {
  isSafeMode: vi.fn(() => false),
  getCrashCount: vi.fn(() => 0),
  getLastCrashTimestamp: vi.fn(() => null),
  getQuarantinedStatePath: vi.fn(() => null),
  resetForNormalBoot: vi.fn(),
};

vi.mock("../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashGuard,
}));

const panelSuspectLedger = {
  getQuarantinedPanelIds: vi.fn(() => new Set<string>()),
  getQuarantinedPanels: vi.fn(() => [] as Array<Record<string, unknown>>),
  clearQuarantinedPanel: vi.fn((_panelId: string) => false),
};

vi.mock("../../services/PanelSuspectLedgerService.js", () => ({
  getPanelSuspectLedger: () => panelSuspectLedger,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  closeTelemetry: vi.fn(),
}));

vi.mock("../../window/deferredInitQueue.js", () => ({
  signalFirstInteractive: vi.fn(),
}));

vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  isPerformanceCaptureEnabled: vi.fn(() => false),
  sampleIpcTiming: vi.fn(),
}));

vi.mock("../../services/prefetchHydrateCache.js", () => ({
  consumePrefetchedHydrateResult: vi.fn(() => null),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
}));

vi.mock("../../ipc/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/utils.js")>();
  return {
    ...actual,
    assertIpcSecurityReady: vi.fn(),
  };
});

import { CRASH_CRITICAL_FIELDS, registerAppStateHandlers } from "../handlers/app/state.js";
import { consumePrefetchedHydrateResult } from "../../services/prefetchHydrateCache.js";
import { projectStore } from "../../services/ProjectStore.js";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import type { HandlerDependencies } from "../types.js";

function shouldTriggerBackup(updates: Record<string, unknown>): boolean {
  return Object.keys(updates).some((k) => CRASH_CRITICAL_FIELDS.has(k));
}

describe("CRASH_CRITICAL_FIELDS", () => {
  it("includes terminals", () => {
    expect(CRASH_CRITICAL_FIELDS.has("terminals")).toBe(true);
  });

  it("includes panelGridConfig", () => {
    expect(CRASH_CRITICAL_FIELDS.has("panelGridConfig")).toBe(true);
  });

  it("includes focusMode", () => {
    expect(CRASH_CRITICAL_FIELDS.has("focusMode")).toBe(true);
  });

  it("includes focusPanelState", () => {
    expect(CRASH_CRITICAL_FIELDS.has("focusPanelState")).toBe(true);
  });

  it("includes activeWorktreeId", () => {
    expect(CRASH_CRITICAL_FIELDS.has("activeWorktreeId")).toBe(true);
  });

  it("includes recipes", () => {
    expect(CRASH_CRITICAL_FIELDS.has("recipes")).toBe(true);
  });

  it("includes mruList", () => {
    expect(CRASH_CRITICAL_FIELDS.has("mruList")).toBe(true);
  });

  it("includes actionMruList", () => {
    expect(CRASH_CRITICAL_FIELDS.has("actionMruList")).toBe(true);
  });

  it("includes actionPinnedIds", () => {
    expect(CRASH_CRITICAL_FIELDS.has("actionPinnedIds")).toBe(true);
  });

  it("includes actionHiddenIds", () => {
    expect(CRASH_CRITICAL_FIELDS.has("actionHiddenIds")).toBe(true);
  });

  it("includes developerMode", () => {
    expect(CRASH_CRITICAL_FIELDS.has("developerMode")).toBe(true);
  });

  it("includes fleetScopeMode", () => {
    expect(CRASH_CRITICAL_FIELDS.has("fleetScopeMode")).toBe(true);
  });

  it("does NOT include sidebarWidth", () => {
    expect(CRASH_CRITICAL_FIELDS.has("sidebarWidth")).toBe(false);
  });

  it("does NOT include diagnosticsHeight", () => {
    expect(CRASH_CRITICAL_FIELDS.has("diagnosticsHeight")).toBe(false);
  });

  it("does NOT include hasSeenWelcome", () => {
    expect(CRASH_CRITICAL_FIELDS.has("hasSeenWelcome")).toBe(false);
  });

  it("does NOT include unknown fields", () => {
    expect(CRASH_CRITICAL_FIELDS.has("unknownField")).toBe(false);
  });

  it("has exactly 12 fields", () => {
    expect(CRASH_CRITICAL_FIELDS.size).toBe(12);
  });
});

describe("shouldTriggerBackup", () => {
  it("returns true for a single critical field", () => {
    expect(shouldTriggerBackup({ focusMode: true })).toBe(true);
  });

  it("returns true for terminals", () => {
    expect(shouldTriggerBackup({ terminals: [] })).toBe(true);
  });

  it("returns true for panelGridConfig", () => {
    expect(shouldTriggerBackup({ panelGridConfig: { strategy: "automatic", value: 3 } })).toBe(
      true
    );
  });

  it("returns true for activeWorktreeId", () => {
    expect(shouldTriggerBackup({ activeWorktreeId: "wt-1" })).toBe(true);
  });

  it("returns true for recipes", () => {
    expect(shouldTriggerBackup({ recipes: [] })).toBe(true);
  });

  it("returns true for mruList", () => {
    expect(shouldTriggerBackup({ mruList: [] })).toBe(true);
  });

  it("returns true for actionMruList", () => {
    expect(shouldTriggerBackup({ actionMruList: [] })).toBe(true);
  });

  it("returns true for actionPinnedIds", () => {
    expect(shouldTriggerBackup({ actionPinnedIds: [] })).toBe(true);
  });

  it("returns true for actionHiddenIds", () => {
    expect(shouldTriggerBackup({ actionHiddenIds: [] })).toBe(true);
  });

  it("returns true for developerMode", () => {
    expect(shouldTriggerBackup({ developerMode: { enabled: true } })).toBe(true);
  });

  it("returns true for fleetScopeMode", () => {
    expect(shouldTriggerBackup({ fleetScopeMode: "scoped" })).toBe(true);
  });

  it("returns false for sidebarWidth-only mutation", () => {
    expect(shouldTriggerBackup({ sidebarWidth: 350 })).toBe(false);
  });

  it("returns false for diagnosticsHeight-only mutation", () => {
    expect(shouldTriggerBackup({ diagnosticsHeight: 400 })).toBe(false);
  });

  it("returns false for hasSeenWelcome-only mutation", () => {
    expect(shouldTriggerBackup({ hasSeenWelcome: true })).toBe(false);
  });

  it("returns true for mixed critical+cosmetic mutation", () => {
    expect(shouldTriggerBackup({ focusMode: true, sidebarWidth: 350, hasSeenWelcome: true })).toBe(
      true
    );
  });

  it("returns true for focusPanelState undefined (clearing on focus-mode exit)", () => {
    expect(shouldTriggerBackup({ focusPanelState: undefined })).toBe(true);
  });

  it("returns false for empty object", () => {
    expect(shouldTriggerBackup({})).toBe(false);
  });
});

function makeInvokeEvent(senderId = 1, senderUrl = "") {
  return {
    sender: {
      id: senderId,
      getURL: vi.fn(() => senderUrl),
    },
  } as unknown as Electron.IpcMainInvokeEvent;
}

async function invokeBoot(
  options: { deps?: HandlerDependencies; senderId?: number; senderUrl?: string } = {}
) {
  ipcHandlers.clear();
  const cleanup = registerAppStateHandlers(options.deps);
  const handler = ipcHandlers.get("app:boot");
  if (!handler) throw new Error("app:boot handler not registered");
  const result = (await handler(makeInvokeEvent(options.senderId, options.senderUrl))) as Record<
    string,
    unknown
  >;
  cleanup();
  return result;
}

describe("app:boot handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    crashGuard.isSafeMode.mockReturnValue(false);
    crashGuard.getCrashCount.mockReturnValue(0);
    crashService.getPendingCrash.mockReturnValue(null);
    crashService.consumePanelFilter.mockReturnValue(null);
    crashService.getConfig.mockReturnValue({ autoRestoreOnCrash: false });
    crashGuard.getQuarantinedStatePath.mockReturnValue(null);
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue(undefined);
    vi.mocked(getWindowForWebContents).mockReturnValue(null);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue(null);
    vi.mocked(projectStore.getProjectById).mockReturnValue(null);
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: null,
      quarantinedPath: undefined,
    });
  });

  it("returns a BootResult with crashPending=null and the live crashConfig when no crash is pending", async () => {
    const result = await invokeBoot();
    expect(result).toHaveProperty("appState");
    expect(result).toHaveProperty("terminalConfig");
    expect(result).toHaveProperty("agentSettings");
    expect(result).toHaveProperty("crashPending", null);
    expect(result).toHaveProperty("crashConfig", { autoRestoreOnCrash: false });
  });

  it("attaches a pending crash plus the live crashCount when one exists", async () => {
    crashGuard.getCrashCount.mockReturnValue(3);
    crashService.getPendingCrash.mockReturnValue({
      logPath: "/fake.json",
      entry: {
        id: "c",
        timestamp: 0,
        appVersion: "1",
        platform: "x",
        osVersion: "y",
        arch: "z",
      },
      hasBackup: false,
      panels: [],
    });

    const result = (await invokeBoot()) as { crashPending: { crashCount: number } | null };
    expect(result.crashPending).not.toBeNull();
    expect(result.crashPending?.crashCount).toBe(3);
  });

  it("suppresses crashPending when in safe mode (mirrors crash-recovery:get-pending)", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    crashService.getPendingCrash.mockReturnValue({
      logPath: "/fake.json",
      entry: {
        id: "c",
        timestamp: 0,
        appVersion: "1",
        platform: "x",
        osVersion: "y",
        arch: "z",
      },
      hasBackup: false,
      panels: [],
    });

    const result = (await invokeBoot()) as { crashPending: unknown };
    expect(result.crashPending).toBeNull();
  });

  it("surfaces crashLoopStateRecovery only when in safe mode AND quarantine path is set", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    (crashGuard.getQuarantinedStatePath as any).mockReturnValue(
      "/tmp/crash-loop-state.json.corrupted.42"
    );

    const result = (await invokeBoot()) as { crashLoopStateRecovery: unknown };
    expect(result.crashLoopStateRecovery).toEqual({
      quarantinedPath: "/tmp/crash-loop-state.json.corrupted.42",
    });
  });

  it("omits crashLoopStateRecovery when not in safe mode (silent corruption is log-only)", async () => {
    crashGuard.isSafeMode.mockReturnValue(false);
    (crashGuard.getQuarantinedStatePath as any).mockReturnValue(
      "/tmp/crash-loop-state.json.corrupted.42"
    );

    const result = (await invokeBoot()) as { crashLoopStateRecovery: unknown };
    expect(result.crashLoopStateRecovery).toBeNull();
  });

  it("omits crashLoopStateRecovery when in safe mode but no quarantine occurred", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    crashGuard.getQuarantinedStatePath.mockReturnValue(null);

    const result = (await invokeBoot()) as { crashLoopStateRecovery: unknown };
    expect(result.crashLoopStateRecovery).toBeNull();
  });

  it("filters out quarantined panels in safe mode while keeping stable ones", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["panel-bad"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "panel-bad", kind: "terminal", title: "Misbehaving" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "panel-good", kind: "terminal", title: "Good", location: "grid", cwd: "/tmp" },
            { id: "panel-bad", kind: "terminal", title: "Bad", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: Array<{ id: string }> };
      skippedPanelCount: number;
      quarantinedPanels: Array<{ id: string }>;
    };
    expect(result.appState.terminals.map((t) => t.id)).toEqual(["panel-good"]);
    expect(result.skippedPanelCount).toBe(1);
    expect(result.quarantinedPanels).toEqual([
      expect.objectContaining({ id: "panel-bad", title: "Misbehaving" }),
    ]);
  });

  it("falls back to the all-or-nothing wipe when every saved panel is quarantined", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["a", "b"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "a", kind: "terminal", title: "A" },
      { id: "b", kind: "terminal", title: "B" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" },
            { id: "b", kind: "terminal", title: "B", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: unknown[] };
      skippedPanelCount: number;
    };
    expect(result.appState.terminals).toEqual([]);
    expect(result.skippedPanelCount).toBe(2);
  });

  it("falls back to the all-or-nothing wipe when ledger is empty (legacy path)", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set());
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [{ id: "a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" }],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: unknown[] };
      skippedPanelCount: number;
      quarantinedPanels: unknown[];
    };
    expect(result.appState.terminals).toEqual([]);
    expect(result.skippedPanelCount).toBe(1);
    expect(result.quarantinedPanels).toEqual([]);
  });

  it("preserves panels in safe mode when the quarantine set doesn't match this project", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    // Ledger has IDs from a different project — none of the current project's
    // saved panels are quarantined.
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["other-project-bad"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "other-project-bad", kind: "terminal", title: "Other" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "current-a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" },
            { id: "current-b", kind: "terminal", title: "B", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: Array<{ id: string }> };
      skippedPanelCount: number;
      quarantinedPanels: Array<{ id: string }>;
    };
    expect(result.appState.terminals.map((t) => t.id).sort()).toEqual(["current-a", "current-b"]);
    expect(result.skippedPanelCount).toBe(0);
    // The other project's quarantine is still surfaced for the banner.
    expect(result.quarantinedPanels.map((p) => p.id)).toEqual(["other-project-bad"]);
  });

  it("does not consult the ledger filter outside of safe mode", async () => {
    crashGuard.isSafeMode.mockReturnValue(false);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["a"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "a", kind: "terminal", title: "A" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" },
            { id: "b", kind: "terminal", title: "B", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: Array<{ id: string }> };
      skippedPanelCount: number;
      quarantinedPanels: unknown[];
    };
    expect(result.appState.terminals.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(result.skippedPanelCount).toBe(0);
    expect(result.quarantinedPanels).toEqual([]);
  });

  it("propagates the cache-hit fast path from handleAppHydrate (no disk read)", async () => {
    const cachedResult = {
      appState: { terminals: [], sidebarWidth: 350 },
      terminalConfig: {
        scrollbackLines: 3000,
        performanceMode: false,
        resourceMonitoringEnabled: true,
      },
      project: null,
      agentSettings: { agents: {} },
      gpuWebGLHardware: true,
      gpuHardwareAccelerationDisabled: false,
      gpuAngleFallbackActive: false,
      safeMode: false,
      isWindowsStore: false,
    };
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue(
      cachedResult as ReturnType<typeof consumePrefetchedHydrateResult>
    );
    // Force the cache path by giving handleAppHydrate a current project.
    const projectStoreModule = await import("../../services/ProjectStore.js");
    vi.mocked(projectStoreModule.projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStoreModule.projectStore.getCurrentProject>);

    const result = (await invokeBoot()) as Record<string, unknown>;
    expect(result.terminalConfig).toEqual(cachedResult.terminalConfig);
    expect(result.crashPending).toBeNull();
    expect(result.crashConfig).toEqual({ autoRestoreOnCrash: false });
  });

  it("hydrates the project bound to the sending project view instead of the stale global current project", async () => {
    const boundProject = {
      id: "proj-bound",
      name: "Bound Project",
      path: "/projects/bound",
    };
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.getProjectById).mockImplementation((projectId) =>
      projectId === boundProject.id
        ? (boundProject as unknown as ReturnType<typeof projectStore.getProjectById>)
        : null
    );
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: {
        projectId: boundProject.id,
        sidebarWidth: 350,
        terminals: [],
      },
      quarantinedPath: undefined,
    });

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(boundProject.id),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: {
        getProjectIdForWebContents: vi.fn().mockReturnValue("proj-other"),
      },
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({ deps, senderId: 42 });

    expect(result.project).toEqual(boundProject);
    expect(pvm.getProjectIdForWebContents).toHaveBeenCalledWith(42);
    expect(projectStore.getProjectStateWithRecovery).toHaveBeenCalledWith(boundProject.id);
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("does not inherit the global current project for an unbound project view", async () => {
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({ deps, senderId: 42 });

    expect(result.project).toBeNull();
    expect(projectStore.getProjectStateWithRecovery).not.toHaveBeenCalled();
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("hydrates the URL project while a project view binding is still pending", async () => {
    const urlProject = {
      id: "proj-url",
      name: "URL Project",
      path: "/projects/url",
    };
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.getProjectById).mockImplementation((projectId) =>
      projectId === urlProject.id
        ? (urlProject as unknown as ReturnType<typeof projectStore.getProjectById>)
        : null
    );
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: {
        projectId: urlProject.id,
        sidebarWidth: 350,
        terminals: [],
      },
      quarantinedPath: undefined,
    });

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({
      deps,
      senderId: 42,
      senderUrl: "app://daintree/index.html?projectId=proj-url",
    });

    expect(result.project).toEqual(urlProject);
    expect(pvm.getProjectIdForWebContents).toHaveBeenCalledWith(42);
    expect(projectStore.getProjectStateWithRecovery).toHaveBeenCalledWith(urlProject.id);
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("does not hydrate a closed URL project before the project view binding is ready", async () => {
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.getProjectById).mockReturnValue({
      id: "proj-url-closed",
      name: "Closed URL Project",
      path: "/projects/url-closed",
      status: "closed",
    } as unknown as ReturnType<typeof projectStore.getProjectById>);

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({
      deps,
      senderId: 42,
      senderUrl: "app://daintree/index.html?projectId=proj-url-closed",
    });

    expect(result.project).toBeNull();
    expect(projectStore.getProjectStateWithRecovery).not.toHaveBeenCalled();
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });
});
