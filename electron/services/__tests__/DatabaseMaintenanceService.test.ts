import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const RESTORED_RECOVERY = {
  kind: "restored-from-backup" as const,
  quarantinedPath: "/fake/daintree.db.corrupt-2026-01-01",
};

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

const TICK = 5 * 60 * 1000 + 100;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A backup now awaits its candidate integrity probe before the rename, so the
 * chain spans several microtask turns. Drain generously rather than counting.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const quickCheckOps = () =>
  mockRunDbWork.mock.calls.filter(([op]) => (op as { op: string }).op === "quickCheck");

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
    mockDbModule.probeDbFile.mockReturnValue("ok");
    mockDbModule.attemptRecovery.mockReturnValue(RESTORED_RECOVERY);
    mockSqlite.backup.mockResolvedValue(undefined);
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);
    mockRunDbWork.mockImplementation((_op: unknown, fallback: () => unknown) =>
      Promise.resolve(fallback())
    );
    // restoreAllMocks strips the mock factory's implementations, so re-arm them.
    vi.mocked(fs.existsSync).mockReset().mockReturnValue(false);
    vi.mocked(fs.unlinkSync)
      .mockReset()
      .mockImplementation(() => undefined);
    vi.mocked(fs.renameSync)
      .mockReset()
      .mockImplementation(() => undefined);
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

    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(mockDbModule.attemptRecovery).toHaveBeenCalledWith("/fake/daintree.db");
    void service.dispose();
  });

  it("handles failed recovery gracefully", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(null);

    const service = new DatabaseMaintenanceService();
    expect(() => service.initialize()).not.toThrow();
    void service.dispose();
  });

  it("stashes the boot recovery outcome for exactly one consumer", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(RESTORED_RECOVERY);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(service.consumeRecovery()).toEqual(RESTORED_RECOVERY);
    // One-shot: the notification must not re-fire on a later hydrate.
    expect(service.consumeRecovery()).toBeNull();
    void service.dispose();
  });

  it("stashes a reset-to-fresh outcome, not just a restore", () => {
    const reset = { kind: "reset-to-fresh" as const, quarantinedPath: "/fake/x.corrupt" };
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(reset);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    // The reset is the branch that actually loses the user's projects — dropping
    // it while stashing restores would silently swallow the worse outcome.
    expect(service.consumeRecovery()).toEqual(reset);
    void service.dispose();
  });

  it("hands a recovery back so a discarded boot payload does not lose it", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(RESTORED_RECOVERY);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    // The real round trip app:boot performs when a pending crash means the
    // renderer will throw its payload away: consume, hand back, consume again.
    const consumed = service.consumeRecovery();
    expect(consumed).toEqual(RESTORED_RECOVERY);
    service.restoreRecovery(consumed!);

    expect(service.consumeRecovery()).toEqual(RESTORED_RECOVERY);
    expect(service.consumeRecovery()).toBeNull();
    void service.dispose();
  });

  it("reports no recovery when the boot probe found a healthy database", () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();

    expect(service.consumeRecovery()).toBeNull();
    void service.dispose();
  });

  it("reports no recovery when the recovery attempt itself failed", () => {
    mockDbModule.probeDb.mockReturnValue(false);
    mockDbModule.attemptRecovery.mockReturnValue(null);

    const service = new DatabaseMaintenanceService();
    service.initialize();

    // A rename that threw leaves the corrupt DB in place — claiming a restore
    // or a reset here would tell the user something that never happened.
    expect(service.consumeRecovery()).toBeNull();
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

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(quickCheckOps()).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(quickCheckOps()).toHaveLength(1);

    // The deferred scan must never run on the main connection.
    expect(mockSqlite.pragma).not.toHaveBeenCalledWith("quick_check", { simple: true });
    void service.dispose();
  });

  it("holds the first backup until the deferred quick_check passes", async () => {
    const quickCheck = createDeferred<string>();
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck" ? quickCheck.promise : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize(true);
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();

    // Integrity still unknown — backing up now could copy a corrupt DB.
    expect(mockSqlite.backup).not.toHaveBeenCalled();

    quickCheck.resolve("ok");
    await drainMicrotasks();

    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it("lifts the backup gate for the rest of the process once the check passes", async () => {
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck"
        ? Promise.resolve("ok")
        : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize(true);
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    // A passing check clears the pending flag: later ticks back up straight from
    // the timer callback and never re-run the O(size) scan.
    vi.advanceTimersByTime(TICK);
    expect(mockSqlite.backup).toHaveBeenCalledTimes(2);
    expect(quickCheckOps()).toHaveLength(1);

    await drainMicrotasks();
    await service.dispose();
  });

  it("keeps the quick_check pending and retries when the DB worker is unavailable", async () => {
    // Default mock: the worker is unavailable, so quickCheck's fallback returns
    // null — the scan never actually ran.
    const service = new DatabaseMaintenanceService();
    service.initialize(true);
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(quickCheckOps()).toHaveLength(1);

    // A check that never ran must not look like one that passed.
    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(quickCheckOps()).toHaveLength(2);

    // The backup still runs — its own candidate probe is what guards the
    // existing backup, and it catches on main what the worker could not.
    expect(mockSqlite.backup).toHaveBeenCalled();
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
      "/fake/daintree.db.backup.tmp",
      "/fake/daintree.db.backup"
    );
    await service.dispose();
  });

  // chmod is a POSIX no-op on Windows, so the mode-bit assertion only runs there.
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("promotes the backup file owner-only", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const realDir = actual.mkdtempSync(path.join(os.tmpdir(), "daintree-dbmaint-perms-"));
    const backupPath = path.join(realDir, "daintree.db.backup");
    mockDbModule.getBackupPath.mockReturnValue(backupPath);
    // sqlite.backup() writes the candidate at the umask default; simulate that.
    mockSqlite.backup.mockImplementation(async (tmp: string) => {
      actual.writeFileSync(tmp, "backup-bytes");
      actual.chmodSync(tmp, 0o644);
    });
    // Let the promotion rename actually run against the real filesystem.
    vi.mocked(fs.renameSync).mockImplementation(
      actual.renameSync as unknown as typeof fs.renameSync
    );

    try {
      const service = new DatabaseMaintenanceService();
      // dispose() runs the final backup on main (probeOnMain), no worker needed.
      await service.dispose();

      expect(actual.existsSync(backupPath)).toBe(true);
      expect(actual.statSync(backupPath).mode & 0o777).toBe(0o600);
    } finally {
      actual.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("suspends all backups once the deferred quick_check reports corruption", async () => {
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck"
        ? Promise.resolve("*** in database main *** Page 4 is never used")
        : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize(true);
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();

    expect(mockSqlite.backup).not.toHaveBeenCalled();

    // Every later tick stays suspended — the existing backup is the last good copy.
    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(mockSqlite.backup).not.toHaveBeenCalled();

    // ...including the final backup at shutdown.
    await service.dispose();
    expect(mockSqlite.backup).not.toHaveBeenCalled();
    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("never promotes a candidate that probes corrupt, and re-checks the live DB", async () => {
    // The candidate written by sqlite.backup() probes dirty. Promoting it would
    // destroy the only good backup — but a bad COPY is not by itself proof the
    // live DB is bad, so the service re-checks the source rather than assuming.
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();

    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/fake/daintree.db.backup.tmp");

    // The bad candidate arms a full check of the live database, which the next
    // idle tick runs — the source is interrogated directly rather than condemned
    // on the evidence of one bad copy.
    expect(quickCheckOps()).toHaveLength(0);
    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(quickCheckOps()).toHaveLength(1);

    await service.dispose();
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it("suspends backups once the live DB confirms the corruption a bad candidate hinted at", async () => {
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck"
        ? Promise.resolve("*** in database main *** Page 4 is never used")
        : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    // Tick 1 writes a bad candidate and arms the live re-check.
    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    // Tick 2 runs that check; it reports corruption, so backups stop for good.
    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);

    await service.dispose();
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it("gives up after repeated verification failures even if the live DB looks fine", async () => {
    // The live check keeps passing but every candidate comes out bad. Something
    // is durably wrong; stop rewriting the backup from a suspect source rather
    // than looping forever on a full copy + scan every idle tick.
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck"
        ? Promise.resolve("ok")
        : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(TICK);
      await drainMicrotasks();
    }

    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    // Bounded: it stopped trying rather than copying the DB on every tick forever.
    expect(mockSqlite.backup.mock.calls.length).toBeLessThanOrEqual(3);

    await service.dispose();
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it("discards an unverifiable candidate without suspending backups", async () => {
    // "unknown" is not evidence the DB is bad — it only means this copy could not
    // be checked. Refuse to promote it, but keep trying: treating it as
    // corruption would strand the user on an increasingly stale backup.
    mockDbModule.probeDbFile.mockReturnValueOnce("unknown");
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();

    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/fake/daintree.db.backup.tmp");

    // The next tick probes "ok" and promotes normally — backups are not latched off.
    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();

    expect(mockSqlite.backup).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
      "/fake/daintree.db.backup.tmp",
      "/fake/daintree.db.backup"
    );
    await service.dispose();
  });

  it("does not rename until the candidate probe has actually returned", async () => {
    const probe = createDeferred<string>();
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "probePath" ? probe.promise : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();

    // The candidate is written but its verdict is still outstanding. Renaming it
    // over the good backup now is exactly the bug — the probe must gate it.
    expect(mockSqlite.backup).toHaveBeenCalledTimes(1);
    expect(mockRunDbWork).toHaveBeenCalledWith(
      { op: "probePath", dbPath: "/fake/daintree.db.backup.tmp" },
      expect.any(Function)
    );
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();

    probe.resolve("ok");
    await drainMicrotasks();

    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
      "/fake/daintree.db.backup.tmp",
      "/fake/daintree.db.backup"
    );
    await service.dispose();
  });

  it("waits for an in-flight quick_check before running the final backup", async () => {
    const quickCheck = createDeferred<string>();
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck" ? quickCheck.promise : Promise.resolve(fallback())
    );

    const service = new DatabaseMaintenanceService();
    service.initialize(true);
    service.startMaintenance();

    vi.advanceTimersByTime(TICK);
    await drainMicrotasks();
    expect(mockSqlite.backup).not.toHaveBeenCalled();

    // Shutdown lands while the check is still running — and it comes back corrupt.
    const disposePromise = service.dispose();
    quickCheck.resolve("*** in database main *** Page 4 is never used");
    await disposePromise;

    // dispose() must not have raced ahead and backed the corrupt database up.
    expect(mockSqlite.backup).not.toHaveBeenCalled();
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    expect(mockSqlite.pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("probes the final backup on main rather than spawning a worker at shutdown", async () => {
    const service = new DatabaseMaintenanceService();
    service.initialize();
    service.startMaintenance();

    await service.dispose();

    // shutdown.ts drains the DB worker before disposing us, so routing this probe
    // through runDbWork would spawn a fresh worker purely to tear it down.
    expect(mockDbModule.probeDbFile).toHaveBeenCalledWith("/fake/daintree.db.backup.tmp");
    expect(
      mockRunDbWork.mock.calls.filter(([op]) => (op as { op: string }).op === "probePath")
    ).toHaveLength(0);
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
      "/fake/daintree.db.backup.tmp",
      "/fake/daintree.db.backup"
    );
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
