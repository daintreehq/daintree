import fs from "node:fs";
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
}));

vi.mock("electron", () => ({
  powerMonitor: mockPowerMonitor,
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => mockSystemSleepService,
}));

vi.mock("../persistence/db.js", () => mockDbModule);

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

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("DatabaseMaintenanceService adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockDbModule.getDbPath.mockReturnValue("/fake/canopy.db");
    mockDbModule.getBackupPath.mockReturnValue("/fake/canopy.db.backup");
    mockDbModule.getSharedSqlite.mockReturnValue(mockSqlite);
    mockDbModule.probeDb.mockReturnValue(true);
    mockSqlite.backup.mockResolvedValue(undefined);
    mockSqlite.pragma.mockReset();
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);
    mockSystemSleepService.onSuspend.mockReturnValue(() => {});

    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.renameSync).mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.unlinkSync).mockReset();
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("OVERLAPPING_TICKS_DO_NOT_LOSE_INFLIGHT_BACKUP", async () => {
    const firstBackup = createDeferred<void>();
    mockSqlite.backup
      .mockImplementationOnce(() => firstBackup.promise)
      .mockResolvedValue(undefined);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    const disposePromise = service.dispose();
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    firstBackup.resolve(undefined);
    await flushMicrotasks();
    await disposePromise;

    expect(mockSqlite.backup).toHaveBeenCalledTimes(2);
    expect(mockSqlite.pragma.mock.calls).toEqual([
      ["wal_checkpoint(PASSIVE)"],
      ["wal_checkpoint(PASSIVE)"],
      ["wal_checkpoint(TRUNCATE)"],
    ]);
    expect(mockSqlite.pragma.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      mockSqlite.backup.mock.invocationCallOrder[1] ?? 0
    );
  });

  it("DISPOSE_DURING_INFLIGHT_BACKUP_WAITS_NOT_DOUBLE_STARTS", async () => {
    const inFlightBackup = createDeferred<void>();
    mockSqlite.backup
      .mockImplementationOnce(() => inFlightBackup.promise)
      .mockResolvedValue(undefined);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    vi.advanceTimersByTime(5 * 60 * 1000);
    const disposePromise = service.dispose();

    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    inFlightBackup.resolve(undefined);
    await flushMicrotasks();
    await disposePromise;

    expect(mockSqlite.backup).toHaveBeenCalledTimes(2);
    expect(mockSqlite.pragma.mock.calls.at(-1)).toEqual(["wal_checkpoint(TRUNCATE)"]);
  });

  it("RENAME_RACE_CLEANS_TEMP_FILE", async () => {
    const renameError = new Error("rename failed");
    Object.assign(renameError, { code: "EPERM" });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw renameError;
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    vi.advanceTimersByTime(5 * 60 * 1000);
    await flushMicrotasks();

    expect(console.warn).toHaveBeenCalledWith("[DatabaseMaintenance] Backup failed:", renameError);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/fake/canopy.db.backup.tmp");

    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it("SUSPEND_DURING_INFLIGHT_BACKUP_ONLY_CHECKPOINTS", async () => {
    const inFlightBackup = createDeferred<void>();
    mockSqlite.backup
      .mockImplementationOnce(() => inFlightBackup.promise)
      .mockResolvedValue(undefined);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    vi.advanceTimersByTime(5 * 60 * 1000);

    const suspendCallback = mockSystemSleepService.onSuspend.mock.calls[0]?.[0] as () => void;
    suspendCallback();

    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);
    expect(mockSqlite.pragma.mock.calls).toEqual([
      ["wal_checkpoint(PASSIVE)"],
      ["wal_checkpoint(PASSIVE)"],
    ]);

    inFlightBackup.resolve(undefined);
    await flushMicrotasks();
    await service.dispose();
  });

  it("DISPOSED_SERVICE_IGNORES_LATE_TIMER_FIRE", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    await service.dispose();
    mockSqlite.backup.mockClear();
    mockSqlite.pragma.mockClear();

    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(mockSqlite.backup).not.toHaveBeenCalled();
    expect(mockSqlite.pragma).not.toHaveBeenCalled();
  });
});
