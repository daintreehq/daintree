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
  resetForNormalBoot: vi.fn(),
};

vi.mock("../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashGuard,
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

  it("has exactly 10 fields", () => {
    expect(CRASH_CRITICAL_FIELDS.size).toBe(10);
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

async function invokeBoot() {
  ipcHandlers.clear();
  const cleanup = registerAppStateHandlers();
  const handler = ipcHandlers.get("app:boot");
  if (!handler) throw new Error("app:boot handler not registered");
  const result = (await handler({})) as Record<string, unknown>;
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
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue(undefined);
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
});
