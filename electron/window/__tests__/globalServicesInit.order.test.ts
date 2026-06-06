import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on registerDeferredTask before importing globalServicesInit so that the
// imported module captures our mock. Names recorded here drive the
// task-ordering assertions below.
const registeredTaskNames: string[] = [];
const registeredTaskRuns = new Map<string, () => unknown>();
const setMcpRegistry = vi.fn();
let migrationCurrentVersion = 1;
let migrationShouldThrow = false;
let mockLogRetentionDays: number | undefined = 30;
const { pruneOldLogs } = vi.hoisted(() => ({ pruneOldLogs: vi.fn() }));
const { pluginMcpHydrate, getPluginMcpAuditService, getPluginMcpConsentService } = vi.hoisted(
  () => {
    const pluginMcpHydrate = vi.fn();
    return {
      pluginMcpHydrate,
      getPluginMcpAuditService: vi.fn(() => ({ hydrate: pluginMcpHydrate })),
      getPluginMcpConsentService: vi.fn(),
    };
  }
);

vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  startEventLoopLagMonitor: vi.fn(() => () => {}),
  startProcessMemoryMonitor: vi.fn(() => () => {}),
}));

vi.mock("../../services/StoreMigrations.js", () => ({
  LATEST_SCHEMA_VERSION: 1,
  MigrationRunner: class {
    getCurrentVersion(): number {
      return migrationCurrentVersion;
    }
    async runMigrations(): Promise<void> {
      if (migrationShouldThrow) {
        throw new Error("test-migration-failure");
      }
    }
  },
  isStoreMigrationError: () => false,
}));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === "privacy") {
        return mockLogRetentionDays === undefined ? {} : { logRetentionDays: mockLogRetentionDays };
      }
      return {};
    }),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  pruneOldLogs,
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../../services/TelemetryService.js", () => ({
  initializeTelemetry: vi.fn(),
  setOnboardingCompleteTag: vi.fn(),
}));

vi.mock("../../services/github/GitHubAuth.js", () => ({
  GitHubAuth: {
    initializeStorage: vi.fn(),
    hasToken: () => false,
    getToken: () => null,
    getTokenVersion: () => 0,
    setMemoryToken: vi.fn(),
    setValidatedUserInfo: vi.fn(),
    validate: vi.fn(),
  },
}));

vi.mock("../../services/github/GitHubTokenHealthService.js", () => ({
  gitHubTokenHealthService: { start: vi.fn(), dispose: vi.fn() },
}));

vi.mock("../../services/connectivity/index.js", () => ({
  agentConnectivityService: { start: vi.fn(), dispose: vi.fn() },
  getServiceConnectivityRegistry: () => ({ start: vi.fn(), dispose: vi.fn() }),
}));

vi.mock("../../services/SecureStorage.js", () => ({
  secureStorage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));

vi.mock("../../services/NotificationService.js", () => ({
  notificationService: {
    showNativeNotification: vi.fn(),
    isWindowFocused: () => false,
  },
}));

vi.mock("../../services/PreAgentSnapshotService.js", () => ({
  preAgentSnapshotService: { initialize: vi.fn(), dispose: vi.fn() },
}));

vi.mock("../../services/ActionBreadcrumbService.js", () => ({
  getActionBreadcrumbService: () => ({ initialize: vi.fn() }),
}));

vi.mock("../../services/plugin-mcp/instances.js", () => ({
  getPluginMcpAuditService,
  getPluginMcpConsentService,
}));

vi.mock("../../services/HibernationService.js", () => ({
  initializeHibernationService: vi.fn(),
  getHibernationService: () => ({ stop: vi.fn(), hibernateUnderMemoryPressure: vi.fn() }),
}));

vi.mock("../../services/pty/terminalSessionPersistence.js", () => ({
  evictSessionFiles: vi.fn(async () => ({ deleted: 0, bytesFreed: 0 })),
  SESSION_EVICTION_TTL_MS: 0,
  SESSION_EVICTION_MAX_BYTES: 0,
}));

vi.mock("../../services/SystemSleepService.js", () => ({
  initializeSystemSleepService: vi.fn(),
  getSystemSleepService: () => ({ dispose: vi.fn() }),
}));

vi.mock("../../services/DatabaseMaintenanceService.js", () => ({
  getDatabaseMaintenanceService: () => ({
    initialize: vi.fn(),
    startMaintenance: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../../services/TrashedPidTracker.js", () => ({
  initializeTrashedPidCleanup: vi.fn(),
}));

vi.mock("../../services/ScratchCleanupService.js", () => ({
  initializeScratchCleanup: vi.fn(),
}));

vi.mock("../../services/AssistantScratchService.js", () => ({
  startAssistantScratchCleanup: vi.fn(async () => {}),
}));

// GpuCrashMonitorService is NOT a deferred task — it stays eager pre-window in
// main.ts so the `child-process-gone` listener installs before GPU spawn.
// Mock kept defensively to short-circuit any transitive import via mocked
// neighbors (e.g. CrashRecoveryService → GpuCrashMonitorService).
vi.mock("../../services/GpuCrashMonitorService.js", () => ({
  initializeGpuCrashMonitor: vi.fn(),
  getGpuCrashMonitorService: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => ({ startBackupTimer: vi.fn(), stopBackupTimer: vi.fn() }),
}));

vi.mock("../../services/ProcessMemoryMonitor.js", () => ({
  startAppMetricsMonitor: vi.fn(() => () => {}),
}));

vi.mock("../../services/ResourceProfileService.js", () => ({
  ResourceProfileService: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../../services/DiskSpaceMonitor.js", () => ({
  startDiskSpaceMonitor: vi.fn(() => () => {}),
}));

vi.mock("../../ipc/handlers.js", () => ({
  sendToRenderer: vi.fn(),
}));

vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: vi.fn(),
}));

vi.mock("../windowRef.js", () => ({
  getProjectViewManager: vi.fn(),
}));

vi.mock("../../ipc/handlers/projectCrud/index.js", () => ({
  getProjectStatsService: vi.fn(),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: () => [],
    getProjectState: vi.fn(),
  },
}));

vi.mock("../../setup/environment.js", () => ({
  exposeGc: vi.fn(),
  isSmokeTest: false,
}));

vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    setMcpRegistry,
    setPtyClient: vi.fn(),
    validateToken: vi.fn(),
    gcStaleSessions: vi.fn(async () => {}),
  },
}));

vi.mock("../deferredInitQueue.js", () => ({
  registerDeferredTask: vi.fn((task: { name: string; run: () => unknown }) => {
    registeredTaskNames.push(task.name);
    registeredTaskRuns.set(task.name, task.run);
  }),
  finalizeDeferredRegistration: vi.fn(),
  resetDeferredQueue: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { exit: vi.fn(), getPath: vi.fn(() => "/tmp/userData") },
  dialog: { showErrorBox: vi.fn() },
  session: { defaultSession: { clearCache: vi.fn(), clearStorageData: vi.fn() } },
}));

import { initGlobalServices } from "../globalServicesInit.js";
import { getGlobalServicesInitialized, setGlobalServicesInitialized } from "../serviceRefs.js";
import type { WindowRegistry } from "../WindowRegistry.js";
import { app } from "electron";

describe("initGlobalServices task ordering", () => {
  beforeEach(() => {
    registeredTaskNames.length = 0;
    registeredTaskRuns.clear();
    // mockReset (not mockClear) so mockImplementation set in one test doesn't
    // leak into the next — keeps tests independent as the suite grows.
    setMcpRegistry.mockReset();
    pruneOldLogs.mockReset();
    pluginMcpHydrate.mockClear();
    getPluginMcpAuditService.mockClear();
    getPluginMcpConsentService.mockClear();
    (app.exit as ReturnType<typeof vi.fn>).mockReset();
    migrationCurrentVersion = 1;
    migrationShouldThrow = false;
    mockLogRetentionDays = 30;
    setGlobalServicesInitialized(false);
  });

  afterEach(() => {
    setGlobalServicesInitialized(false);
  });

  it("registers monitor tasks before resource-profile-service so the profile reads ready data", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const lagIndex = registeredTaskNames.indexOf("event-loop-lag-monitor");
    const metricsIndex = registeredTaskNames.indexOf("app-metrics-monitor");
    const profileIndex = registeredTaskNames.indexOf("resource-profile-service");

    expect(lagIndex).toBeGreaterThanOrEqual(0);
    expect(metricsIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeGreaterThan(lagIndex);
    expect(profileIndex).toBeGreaterThan(metricsIndex);
  });

  it("registers service-connectivity-registry before mcp-server so onStatusChange wires first", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const registryIndex = registeredTaskNames.indexOf("service-connectivity-registry");
    const mcpIndex = registeredTaskNames.indexOf("mcp-server");

    expect(registryIndex).toBeGreaterThanOrEqual(0);
    expect(mcpIndex).toBeGreaterThanOrEqual(0);
    expect(mcpIndex).toBeGreaterThan(registryIndex);
  });

  it("calls helpSessionService.setMcpRegistry before pushing the mcp-server task", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;

    // Capture the index at which setMcpRegistry was called by recording a
    // marker into the same task-name list when the mock fires.
    setMcpRegistry.mockImplementation(() => {
      registeredTaskNames.push("__setMcpRegistry__");
    });

    await initGlobalServices(fakeRegistry);

    const setIdx = registeredTaskNames.indexOf("__setMcpRegistry__");
    const mcpIdx = registeredTaskNames.indexOf("mcp-server");

    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(mcpIdx).toBeGreaterThan(setIdx);
  });

  it("skips MCP-related tasks when no windowRegistry is supplied", async () => {
    await initGlobalServices(undefined);

    expect(registeredTaskNames).not.toContain("mcp-server");
    expect(registeredTaskNames).not.toContain("help-session-gc");
    expect(registeredTaskNames).not.toContain("help-session-pty");
    expect(setMcpRegistry).not.toHaveBeenCalled();
  });

  it("registers help-session-pty so HelpSessionService gets a PtyClient ref for displacement (#7509)", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);
    expect(registeredTaskNames).toContain("help-session-pty");
  });

  it("registers database-maintenance after system-sleep-service so onSuspend can attach to a live service", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const sleepIndex = registeredTaskNames.indexOf("system-sleep-service");
    const dbMaintIndex = registeredTaskNames.indexOf("database-maintenance");

    expect(sleepIndex).toBeGreaterThanOrEqual(0);
    expect(dbMaintIndex).toBeGreaterThanOrEqual(0);
    expect(dbMaintIndex).toBeGreaterThan(sleepIndex);
  });

  it("defers pre-agent-snapshot-service after system-sleep-service and doesn't initialize eagerly (#7656)", async () => {
    const { preAgentSnapshotService } = await import("../../services/PreAgentSnapshotService.js");
    const initSpy = preAgentSnapshotService.initialize as ReturnType<typeof vi.fn>;
    initSpy.mockClear();

    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    // The eager call has been removed — initialize() must not fire during
    // initGlobalServices(); it runs only when the deferred queue drains.
    expect(initSpy).not.toHaveBeenCalled();

    const sleepIndex = registeredTaskNames.indexOf("system-sleep-service");
    const dbMaintIndex = registeredTaskNames.indexOf("database-maintenance");
    const snapshotIndex = registeredTaskNames.indexOf("pre-agent-snapshot-service");

    expect(sleepIndex).toBeGreaterThanOrEqual(0);
    expect(dbMaintIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(sleepIndex);
    expect(snapshotIndex).toBeGreaterThan(dbMaintIndex);
  });

  it("registers ccr-config and plugin-service as deferred tasks", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    expect(registeredTaskNames).toContain("ccr-config");
    expect(registeredTaskNames).toContain("plugin-service");
  });

  it("does not touch plugin-MCP audit/consent services eagerly during initGlobalServices() (#10073)", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    // The eager hydrate + consent allocation were removed from the cold-boot
    // path — neither getter may fire until the deferred queue drains.
    expect(getPluginMcpAuditService).not.toHaveBeenCalled();
    expect(getPluginMcpConsentService).not.toHaveBeenCalled();
    expect(registeredTaskNames).toContain("plugin-mcp-audit-warm");
  });

  it("plugin-mcp-audit-warm task hydrates the audit service when run (#10073)", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const run = registeredTaskRuns.get("plugin-mcp-audit-warm");
    expect(run).toBeDefined();
    await run!();

    expect(pluginMcpHydrate).toHaveBeenCalledTimes(1);
    // Consent service stays purely on-demand — the warm task must not
    // allocate it (PluginInstaller constructs it lazily at first real use).
    expect(getPluginMcpConsentService).not.toHaveBeenCalled();
  });

  it("registers prune-old-logs as a deferred task so it doesn't block cold start (#8622)", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    expect(registeredTaskNames).toContain("prune-old-logs");
  });

  it("registers cleanup services migrated out of main.ts as deferred tasks (#8817)", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    expect(registeredTaskNames).toContain("trashed-pid-cleanup");
    expect(registeredTaskNames).toContain("scratch-cleanup");
    expect(registeredTaskNames).toContain("assistant-scratch-cleanup");
    // GpuCrashMonitor is intentionally NOT a deferred task — it must stay
    // eager in main.ts so the child-process-gone listener installs before
    // GPU process spawn. Deferring it would silently drop startup-window
    // GPU crashes.
    expect(registeredTaskNames).not.toContain("gpu-crash-monitor");
  });

  it("does not invoke cleanup service initializers eagerly during initGlobalServices() (#8817)", async () => {
    const { initializeTrashedPidCleanup } = await import("../../services/TrashedPidTracker.js");
    const { initializeScratchCleanup } = await import("../../services/ScratchCleanupService.js");
    const { startAssistantScratchCleanup } =
      await import("../../services/AssistantScratchService.js");
    const trashedSpy = initializeTrashedPidCleanup as ReturnType<typeof vi.fn>;
    const scratchSpy = initializeScratchCleanup as ReturnType<typeof vi.fn>;
    const assistantSpy = startAssistantScratchCleanup as ReturnType<typeof vi.fn>;
    trashedSpy.mockClear();
    scratchSpy.mockClear();
    assistantSpy.mockClear();

    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    expect(trashedSpy).not.toHaveBeenCalled();
    expect(scratchSpy).not.toHaveBeenCalled();
    expect(assistantSpy).not.toHaveBeenCalled();
  });

  it("deferred cleanup tasks invoke their service initializers when run (#8817)", async () => {
    const { initializeTrashedPidCleanup } = await import("../../services/TrashedPidTracker.js");
    const { initializeScratchCleanup } = await import("../../services/ScratchCleanupService.js");
    const { startAssistantScratchCleanup } =
      await import("../../services/AssistantScratchService.js");
    const trashedSpy = initializeTrashedPidCleanup as ReturnType<typeof vi.fn>;
    const scratchSpy = initializeScratchCleanup as ReturnType<typeof vi.fn>;
    const assistantSpy = startAssistantScratchCleanup as ReturnType<typeof vi.fn>;
    trashedSpy.mockClear();
    scratchSpy.mockClear();
    assistantSpy.mockClear();

    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    // Resolve runs explicitly so a missing-registration regression surfaces
    // as "task not registered" instead of "initializer not called".
    const trashedRun = registeredTaskRuns.get("trashed-pid-cleanup");
    const scratchRun = registeredTaskRuns.get("scratch-cleanup");
    const assistantRun = registeredTaskRuns.get("assistant-scratch-cleanup");
    expect(trashedRun).toBeDefined();
    expect(scratchRun).toBeDefined();
    expect(assistantRun).toBeDefined();

    await trashedRun!();
    await scratchRun!();
    await assistantRun!();

    expect(trashedSpy).toHaveBeenCalled();
    expect(scratchSpy).toHaveBeenCalled();
    expect(assistantSpy).toHaveBeenCalled();
  });

  it("prune-old-logs task invokes pruneOldLogs with retentionDays from privacy settings", async () => {
    mockLogRetentionDays = 14;
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const run = registeredTaskRuns.get("prune-old-logs");
    expect(run).toBeDefined();
    run?.();

    expect(pruneOldLogs).toHaveBeenCalledWith("/tmp/userData", 14);
  });

  it("prune-old-logs task skips pruning when retentionDays is 0", async () => {
    mockLogRetentionDays = 0;
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const run = registeredTaskRuns.get("prune-old-logs");
    expect(run).toBeDefined();
    run?.();

    expect(pruneOldLogs).not.toHaveBeenCalled();
  });

  it("prune-old-logs task defaults retentionDays to 30 when privacy setting is missing", async () => {
    mockLogRetentionDays = undefined;
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    await initGlobalServices(fakeRegistry);

    const run = registeredTaskRuns.get("prune-old-logs");
    expect(run).toBeDefined();
    run?.();

    expect(pruneOldLogs).toHaveBeenCalledWith("/tmp/userData", 30);
  });

  it("returns 'ok' on the happy path", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    const result = await initGlobalServices(fakeRegistry);
    expect(result).toBe("ok");
  });

  it("returns 'exit-requested' and calls app.exit(1) when migrations throw", async () => {
    const fakeRegistry = { all: () => [], size: 0 } as unknown as WindowRegistry;
    // Force the migration runner down the runMigrations() path AND make it throw
    // — currentVersion must differ from LATEST_SCHEMA_VERSION (mocked at 1).
    migrationCurrentVersion = 0;
    migrationShouldThrow = true;

    const result = await initGlobalServices(fakeRegistry);

    expect(result).toBe("exit-requested");
    expect(app.exit).toHaveBeenCalledWith(1);
    // No deferred tasks should have been registered after the failure point —
    // the function returns before reaching the post-migration registrations.
    expect(registeredTaskNames).toEqual([]);
    // Guard is set early so a concurrent second window doesn't double-run
    // migrations; app.exit(1) terminates the process before that matters.
    expect(getGlobalServicesInitialized()).toBe(true);
  });
});
