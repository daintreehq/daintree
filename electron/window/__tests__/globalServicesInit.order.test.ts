import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on registerDeferredTask before importing globalServicesInit so that the
// imported module captures our mock. Names recorded here drive the
// task-ordering assertions below.
const registeredTaskNames: string[] = [];
const setMcpRegistry = vi.fn();
let migrationCurrentVersion = 1;
let migrationShouldThrow = false;

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
    get: vi.fn(() => ({})),
  },
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
}));

vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    setMcpRegistry,
    validateToken: vi.fn(),
  },
}));

vi.mock("../deferredInitQueue.js", () => ({
  registerDeferredTask: vi.fn((task: { name: string; run: () => unknown }) => {
    registeredTaskNames.push(task.name);
  }),
  finalizeDeferredRegistration: vi.fn(),
  resetDeferredQueue: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { exit: vi.fn() },
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
    // mockReset (not mockClear) so mockImplementation set in one test doesn't
    // leak into the next — keeps tests independent as the suite grows.
    setMcpRegistry.mockReset();
    (app.exit as ReturnType<typeof vi.fn>).mockReset();
    migrationCurrentVersion = 1;
    migrationShouldThrow = false;
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
    expect(setMcpRegistry).not.toHaveBeenCalled();
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
