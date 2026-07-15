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
  getDbPath: vi.fn().mockReturnValue("/fake/daintree.db"),
  getBackupPath: vi.fn().mockReturnValue("/fake/daintree.db.backup"),
  getSharedSqlite: vi.fn().mockReturnValue(mockSqlite),
  probeDb: vi.fn().mockReturnValue(true),
  probeDbFile: vi.fn().mockReturnValue("ok"),
  attemptRecovery: vi.fn().mockReturnValue({
    kind: "restored-from-backup",
    quarantinedPath: "/fake/daintree.db.corrupt-2026-01-01",
  }),
}));

vi.mock("electron", () => ({
  powerMonitor: mockPowerMonitor,
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => mockSystemSleepService,
}));

vi.mock("../persistence/db.js", () => mockDbModule);

// Worker unavailable in unit tests — runDbWork executes the fallback
// synchronously, matching the client's disabled/degraded behavior, so the
// exact-sequence pragma assertions below hold unchanged.
vi.mock("../persistence/dbWorkerClient.js", () => ({
  runDbWork: vi.fn((_op: unknown, fallback: () => unknown) => Promise.resolve(fallback())),
}));

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

/**
 * A backup now awaits its candidate integrity probe before the rename, so the
 * chain spans several microtask turns. Drain generously rather than counting.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("DatabaseMaintenanceService adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockDbModule.getDbPath.mockReturnValue("/fake/daintree.db");
    mockDbModule.getBackupPath.mockReturnValue("/fake/daintree.db.backup");
    mockDbModule.getSharedSqlite.mockReturnValue(mockSqlite);
    mockDbModule.probeDb.mockReturnValue(true);
    mockDbModule.probeDbFile.mockReturnValue("ok");
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
    service.startMaintenance();

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
      ["optimize"],
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
    service.startMaintenance();

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
    service.startMaintenance();

    vi.advanceTimersByTime(5 * 60 * 1000);
    // The candidate probe (probeDb, mocked clean) sits between the backup and
    // the rename now, so the rename is one extra microtask turn out.
    await drainMicrotasks();

    expect(console.warn).toHaveBeenCalledWith("[DatabaseMaintenance] Backup failed:", renameError);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/fake/daintree.db.backup.tmp");

    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it("CORRUPT_CANDIDATE_SURVIVES_FAILED_TEMP_CLEANUP", async () => {
    // The candidate probes dirty AND the temp file cannot be removed. A failed
    // unlink is not a reason to promote the bad copy over the good backup.
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw Object.assign(new Error("unlink failed"), { code: "EPERM" });
    });

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(5 * 60 * 1000);
    await drainMicrotasks();

    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();

    await service.dispose();
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it("CORRUPT_CANDIDATE_NEVER_REPLACES_GOOD_BACKUP", async () => {
    // Every candidate sqlite.backup() produces probes dirty. However many ticks
    // pass and however shutdown lands, the good backup must never be renamed
    // over — that file is the user's last copy of their data.
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      await drainMicrotasks();
    }

    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/fake/daintree.db.backup.tmp");
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();

    await service.dispose();
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    expect(mockSqlite.pragma.mock.calls.at(-1)).toEqual(["wal_checkpoint(TRUNCATE)"]);
  });

  it("SUSPEND_DURING_INFLIGHT_BACKUP_ONLY_CHECKPOINTS", async () => {
    const inFlightBackup = createDeferred<void>();
    mockSqlite.backup
      .mockImplementationOnce(() => inFlightBackup.promise)
      .mockResolvedValue(undefined);

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

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
    service.startMaintenance();

    await service.dispose();
    mockSqlite.backup.mockClear();
    mockSqlite.pragma.mockClear();

    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(mockSqlite.backup).not.toHaveBeenCalled();
    expect(mockSqlite.pragma).not.toHaveBeenCalled();
  });

  it("DISPOSE_BEFORE_START_MAINTENANCE_IS_SAFE", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    await service.dispose();

    // Late drain of deferred queue tries to start maintenance after dispose;
    // must be a no-op (no timer installed, no listener registered).
    service.startMaintenance();

    expect(mockSystemSleepService.onSuspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * 60 * 1000);
    // backup may have been called once during dispose itself; ensure no further calls
    mockSqlite.backup.mockClear();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(mockSqlite.backup).not.toHaveBeenCalled();
  });
});
