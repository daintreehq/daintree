import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPowerMonitor = vi.hoisted(() => ({
  getSystemIdleTime: vi.fn().mockReturnValue(120),
  on: vi.fn(),
  off: vi.fn(),
}));

const mockSystemSleepService = vi.hoisted(() => ({
  onSuspend: vi.fn().mockReturnValue(() => {}),
}));

const mockSqlite = vi.hoisted(() => ({
  pragma: vi.fn(),
  backup: vi.fn().mockResolvedValue(undefined),
}));

const mockDbModule = vi.hoisted(() => ({
  getDbPath: vi.fn().mockReturnValue("/fake/daintree.db"),
  getBackupPath: vi.fn().mockReturnValue("/fake/daintree.db.backup"),
  getSharedSqlite: vi.fn().mockReturnValue(mockSqlite),
  probeDb: vi.fn().mockReturnValue(true),
  attemptRecovery: vi.fn().mockReturnValue(true),
  closeSharedDb: vi.fn(),
}));

// Worker unavailable in unit tests — runDbWork executes the fallback
// synchronously, matching the client's disabled/degraded behavior.
const mockRunDbWork = vi.hoisted(() =>
  vi.fn((_op: unknown, fallback: () => unknown) => Promise.resolve(fallback()))
);

vi.mock("electron", () => ({
  powerMonitor: mockPowerMonitor,
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => mockSystemSleepService,
}));

vi.mock("../persistence/db.js", () => mockDbModule);

vi.mock("../persistence/dbWorkerClient.js", () => ({
  runDbWork: mockRunDbWork,
}));

// Must mock fs.existsSync / renameSync for backup cleanup
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      unlinkSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

import { DatabaseMaintenanceService } from "../DatabaseMaintenanceService.js";

describe("DatabaseMaintenanceService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.clearAllMocks();
    // Reset defaults after clearAllMocks
    mockDbModule.getDbPath.mockReturnValue("/fake/daintree.db");
    mockDbModule.getBackupPath.mockReturnValue("/fake/daintree.db.backup");
    mockDbModule.getSharedSqlite.mockReturnValue(mockSqlite);
    mockDbModule.probeDb.mockReturnValue(true);
    mockSqlite.backup.mockResolvedValue(undefined);
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips recovery when DB is healthy", () => {
    mockDbModule.probeDb.mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(mockDbModule.probeDb).toHaveBeenCalledWith("/fake/daintree.db", true);
    expect(mockDbModule.attemptRecovery).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("attempts recovery when corruption detected", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(mockDbModule.attemptRecovery).toHaveBeenCalledWith("/fake/daintree.db");
    void service.dispose();
  });

  it("handles failed recovery gracefully", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(false);

    const service = new DatabaseMaintenanceService();
    expect(() => service.initialize()).not.toThrow();
    void service.dispose();
  });

  it("initialize alone does NOT install timer or suspend listener", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(mockSystemSleepService.onSuspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(mockSqlite.pragma).not.toHaveBeenCalled();
    expect(mockSqlite.backup).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("registers suspend listener via SystemSleepService", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    expect(mockSystemSleepService.onSuspend).toHaveBeenCalledWith(expect.any(Function));
    void service.dispose();
  });

  it("runs PASSIVE checkpoint on suspend", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    const suspendCallback = mockSystemSleepService.onSuspend.mock.calls[0][0] as () => void;
    suspendCallback();

    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(PASSIVE)");
    void service.dispose();
  });

  it("runs checkpoint and backup on idle tick", async () => {
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    // Advance past tick interval (5 minutes)
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(PASSIVE)");
    expect(mockSqlite.backup).toHaveBeenCalled();
    void service.dispose();
  });

  it("skips tick when system is not idle", () => {
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(10); // below 60s threshold

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(mockSqlite.pragma).not.toHaveBeenCalled();
    expect(mockSqlite.backup).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("skips tick when no shared DB exists", () => {
    mockDbModule.getSharedSqlite.mockReturnValue(null);

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(mockSqlite.pragma).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("dispose runs final backup and TRUNCATE checkpoint", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    await service.dispose();

    expect(mockSqlite.backup).toHaveBeenCalled();
    expect(mockSqlite.pragma).toHaveBeenCalledWith("optimize");
    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");

    const backupOrder = mockSqlite.backup.mock.invocationCallOrder.at(-1)!;
    const [optimizeOrder, truncateOrder] = mockSqlite.pragma.mock.invocationCallOrder.slice(-2);
    expect(backupOrder).toBeLessThan(optimizeOrder);
    expect(optimizeOrder).toBeLessThan(truncateOrder);
  });

  it("dispose is idempotent", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    await service.dispose();
    mockSqlite.pragma.mockClear();

    await service.dispose();
    // Second dispose should not run checkpoint again
    expect(mockSqlite.pragma).not.toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("dispose before startMaintenance completes without error", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    await expect(service.dispose()).resolves.toBeUndefined();
    expect(mockSystemSleepService.onSuspend).not.toHaveBeenCalled();
  });

  it("startMaintenance after dispose is a no-op", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    await service.dispose();
    // dispose runs its final backup; clear before asserting no further timer activity
    mockSqlite.backup.mockClear();

    service.startMaintenance();
    expect(mockSystemSleepService.onSuspend).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(mockSqlite.backup).not.toHaveBeenCalled();
  });

  it("initialize is idempotent", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.initialize();

    // probeDb should only be called once
    expect(mockDbModule.probeDb).toHaveBeenCalledTimes(1);
    void service.dispose();
  });

  it("startMaintenance is idempotent", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();
    service.startMaintenance();

    // onSuspend should only register once even if called twice
    expect(mockSystemSleepService.onSuspend).toHaveBeenCalledTimes(1);
    void service.dispose();
  });

  it("routes the idle-tick checkpoint through the worker client", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(mockRunDbWork).toHaveBeenCalledWith(
      { op: "checkpoint", mode: "PASSIVE" },
      expect.any(Function)
    );
    void service.dispose();
  });

  it("defers the full quick_check to a single idle tick after a clean-exit boot", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize(true);
    service.startMaintenance();

    const quickCheckOps = () =>
      mockRunDbWork.mock.calls.filter(([op]) => (op as { op: string }).op === "quickCheck");

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(quickCheckOps()).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(quickCheckOps()).toHaveLength(1);

    // The deferred scan must never run on the main connection.
    expect(mockSqlite.pragma).not.toHaveBeenCalledWith("quick_check", { simple: true });
    void service.dispose();
  });

  it("does not schedule a deferred quick_check when the boot probe already ran the full scan", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize(false);
    service.startMaintenance();

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(
      mockRunDbWork.mock.calls.filter(([op]) => (op as { op: string }).op === "quickCheck")
    ).toHaveLength(0);
    void service.dispose();
  });
});
