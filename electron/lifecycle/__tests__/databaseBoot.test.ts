import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => ""),
}));

const mockDbModule = vi.hoisted(() => ({
  getDbPath: vi.fn(() => ""),
  getBackupPath: vi.fn(() => ""),
  getSharedSqlite: vi.fn(() => null),
  probeDb: vi.fn(() => true),
  probeDbFile: vi.fn(() => "ok"),
  attemptRecovery: vi.fn(() => null),
  isRecoveryPending: vi.fn(() => false),
  markRecoveryPending: vi.fn(),
  clearRecoveryPending: vi.fn(),
}));

vi.mock("electron", () => ({
  app: appMock,
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../../services/persistence/db.js", () => mockDbModule);

vi.mock("../../services/persistence/dbWorkerClient.js", () => ({
  runDbWork: vi.fn(),
}));

vi.mock("../../services/SystemSleepService.js", () => ({
  getSystemSleepService: () => ({ onSuspend: vi.fn(() => () => {}) }),
}));

describe("initializeDatabaseForBoot", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    // DatabaseMaintenanceService is a module singleton that initializes once.
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "database-boot-test-"));
    dbPath = path.join(tmpDir, "daintree.db");
    appMock.getPath.mockReturnValue(tmpDir);
    mockDbModule.getDbPath.mockReturnValue(dbPath);
    mockDbModule.getBackupPath.mockReturnValue(`${dbPath}.backup`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function boot() {
    const { CrashLoopGuardService } = await import("../../services/CrashLoopGuardService.js");
    const { initializeDatabaseForBoot } = await import("../databaseBoot.js");
    const guard = new CrashLoopGuardService();
    guard.initialize();
    await initializeDatabaseForBoot(guard);
    return guard;
  }

  it("runs the full scan after an unclean exit whose launch is older than the crash window", async () => {
    const { CRASH_WINDOW_MS } = await import("../../services/CrashLoopGuardService.js");
    const launchedAt = Date.now() - CRASH_WINDOW_MS - 60_000;
    fs.writeFileSync(
      path.join(tmpDir, "crash-loop-state.json"),
      JSON.stringify({
        version: 1,
        crashes: 0,
        launches: [launchedAt],
        cleanExit: false,
        lastReset: launchedAt,
      })
    );

    const guard = await boot();

    expect(guard.getCrashCount()).toBe(0);
    expect(mockDbModule.probeDb).toHaveBeenCalledWith(dbPath, true);
  });

  it("keeps the cheap probe after a clean exit", async () => {
    const { CrashLoopGuardService } = await import("../../services/CrashLoopGuardService.js");
    const previous = new CrashLoopGuardService();
    previous.initialize();
    previous.markCleanExit();

    await boot();

    expect(mockDbModule.probeDb).toHaveBeenCalledWith(dbPath, false);
    expect(mockDbModule.probeDb).not.toHaveBeenCalledWith(dbPath, true);
  });
});
