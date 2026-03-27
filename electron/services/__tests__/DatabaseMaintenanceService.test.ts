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
  getDbPath: vi.fn().mockReturnValue("/fake/canopy.db"),
  getBackupPath: vi.fn().mockReturnValue("/fake/canopy.db.backup"),
  getSharedSqlite: vi.fn().mockReturnValue(mockSqlite),
  probeDb: vi.fn().mockReturnValue(true),
  attemptRecovery: vi.fn().mockReturnValue(true),
  closeSharedDb: vi.fn(),
}));

vi.mock("electron", () => ({
  powerMonitor: mockPowerMonitor,
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => mockSystemSleepService,
}));

vi.mock("../persistence/db.js", () => mockDbModule);

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
    mockDbModule.getDbPath.mockReturnValue("/fake/canopy.db");
    mockDbModule.getBackupPath.mockReturnValue("/fake/canopy.db.backup");
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

    expect(mockDbModule.probeDb).toHaveBeenCalledWith("/fake/canopy.db");
    expect(mockDbModule.attemptRecovery).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("attempts recovery when corruption detected", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(mockDbModule.attemptRecovery).toHaveBeenCalledWith("/fake/canopy.db");
    void service.dispose();
  });

  it("handles failed recovery gracefully", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(false);

    const service = new DatabaseMaintenanceService();
    expect(() => service.initialize()).not.toThrow();
    void service.dispose();
  });

  it("registers suspend listener via SystemSleepService", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(mockSystemSleepService.onSuspend).toHaveBeenCalledWith(expect.any(Function));
    void service.dispose();
  });

  it("runs PASSIVE checkpoint on suspend", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    const suspendCallback = mockSystemSleepService.onSuspend.mock.calls[0][0] as () => void;
    suspendCallback();

    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(PASSIVE)");
    void service.dispose();
  });

  it("runs checkpoint and backup on idle tick", async () => {
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);

    const service = new DatabaseMaintenanceService();
    service.initialize();

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

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(mockSqlite.pragma).not.toHaveBeenCalled();
    expect(mockSqlite.backup).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("skips tick when no shared DB exists", () => {
    mockDbModule.getSharedSqlite.mockReturnValue(null);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(mockSqlite.pragma).not.toHaveBeenCalled();
    void service.dispose();
  });

  it("dispose runs TRUNCATE checkpoint and closes DB", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    await service.dispose();

    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
    expect(mockDbModule.closeSharedDb).toHaveBeenCalled();
  });

  it("dispose is idempotent", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    await service.dispose();
    mockDbModule.closeSharedDb.mockClear();

    await service.dispose();
    expect(mockDbModule.closeSharedDb).not.toHaveBeenCalled();
  });
});
