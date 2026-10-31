import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPowerMonitor = vi.hoisted(() => ({
  getSystemIdleTime: vi.fn().mockReturnValue(120),
}));

const mockSqlite = vi.hoisted(() => ({
  pragma: vi.fn(),
  backup: vi.fn().mockResolvedValue(undefined),
}));

const DB_PATH = "/fake/daintree.db";
const BACKUP_PATH = "/fake/daintree.db.backup";
const BACKUP_WRITTEN_AT = Date.UTC(2026, 9, 30, 14, 5);
const CORRUPT_RESULT = "*** in database main *** Page 4 is never used";

const mockDbModule = vi.hoisted(() => ({
  getDbPath: vi.fn(),
  getBackupPath: vi.fn(),
  getSharedSqlite: vi.fn(),
  probeDb: vi.fn(),
  probeDbFile: vi.fn(),
  attemptRecovery: vi.fn(),
  isRecoveryPending: vi.fn(),
  markRecoveryPending: vi.fn(),
  clearRecoveryPending: vi.fn(),
}));

const mockRunDbWork = vi.hoisted(() =>
  vi.fn((_op: unknown, fallback: () => unknown) => Promise.resolve(fallback()))
);

vi.mock("electron", () => ({ powerMonitor: mockPowerMonitor }));
vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({ onSuspend: () => () => {} }),
}));
vi.mock("../persistence/db.js", () => mockDbModule);
vi.mock("../persistence/dbWorkerClient.js", () => ({ runDbWork: mockRunDbWork }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      unlinkSync: vi.fn(),
      renameSync: vi.fn(),
      statSync: vi.fn(),
    },
  };
});

import {
  DatabaseMaintenanceService,
  type BackupSuspensionNotice,
} from "../DatabaseMaintenanceService.js";

const TICK = 5 * 60 * 1000 + 100;
const SAVED = { kind: "saved", writtenAt: BACKUP_WRITTEN_AT } as const;

function statFails(code: string): void {
  vi.mocked(fs.statSync).mockImplementation((() => {
    throw Object.assign(new Error(code), { code });
  }) as typeof fs.statSync);
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function quickCheckReturns(result: string): void {
  mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
    (op as { op: string }).op === "quickCheck"
      ? Promise.resolve(result)
      : Promise.resolve(fallback())
  );
}

describe("DatabaseMaintenanceService backup suspension notices", () => {
  let notices: BackupSuspensionNotice[];
  let service: DatabaseMaintenanceService;

  function startSession(wasCleanExit: boolean): void {
    service = new DatabaseMaintenanceService();
    service.onBackupsSuspended((notice) => notices.push(notice));
    service.initialize(wasCleanExit);
    service.startMaintenance();
  }

  async function idleTicks(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      vi.advanceTimersByTime(TICK);
      await drainMicrotasks();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.clearAllMocks();
    notices = [];
    mockDbModule.getDbPath.mockReturnValue(DB_PATH);
    mockDbModule.getBackupPath.mockReturnValue(BACKUP_PATH);
    mockDbModule.getSharedSqlite.mockReturnValue(mockSqlite);
    mockDbModule.probeDb.mockReturnValue(true);
    mockDbModule.probeDbFile.mockReturnValue("ok");
    mockDbModule.isRecoveryPending.mockReturnValue(false);
    mockSqlite.backup.mockResolvedValue(undefined);
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);
    mockRunDbWork.mockImplementation((_op: unknown, fallback: () => unknown) =>
      Promise.resolve(fallback())
    );
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockImplementation(((file: fs.PathLike) => {
      if (file !== BACKUP_PATH) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: BACKUP_WRITTEN_AT } as fs.Stats;
    }) as typeof fs.statSync);
  });

  afterEach(async () => {
    await service?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports confirmed corruption once, with when the preserved backup was written", async () => {
    quickCheckReturns(CORRUPT_RESULT);
    startSession(true);

    await idleTicks(4);

    expect(notices).toEqual([{ reason: "corruption", backup: SAVED }]);
  });

  it("reports corruption once even when a candidate and the live check both keep finding it", async () => {
    // The live check runs once per failed candidate here, so corruption is
    // confirmed by a check that has run more than once this session.
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    quickCheckReturns("ok");
    startSession(false);

    await idleTicks(2);
    expect(notices).toEqual([]);

    quickCheckReturns(CORRUPT_RESULT);
    await idleTicks(4);

    expect(notices).toEqual([{ reason: "corruption", backup: SAVED }]);
  });

  it("reports corruption with no backup when none was ever written", async () => {
    statFails("ENOENT");
    quickCheckReturns(CORRUPT_RESULT);
    startSession(true);

    await idleTicks(2);

    expect(notices).toEqual([{ reason: "corruption", backup: { kind: "missing" } }]);
  });

  it("does not report a backup it could not stat as missing", async () => {
    statFails("EACCES");
    quickCheckReturns(CORRUPT_RESULT);
    startSession(true);

    await idleTicks(2);

    expect(notices).toEqual([{ reason: "corruption", backup: { kind: "unreadable" } }]);
  });

  it("reports corruption once when the live check itself runs again and finds it again", async () => {
    // The tick stops calling the check once backups are suspended, so drive it
    // directly: the notice must not depend on that guard to stay single.
    quickCheckReturns(CORRUPT_RESULT);
    startSession(true);
    await idleTicks(1);
    const rerunCheck = () =>
      (service as unknown as { runDeferredQuickCheck(): Promise<boolean> | null })
        .runDeferredQuickCheck();

    await expect(rerunCheck()).resolves.toBe(false);
    await expect(rerunCheck()).resolves.toBe(false);

    expect(mockDbModule.markRecoveryPending).toHaveBeenCalledTimes(3);
    expect(notices).toEqual([{ reason: "corruption", backup: SAVED }]);
  });

  it("reports stopped backups once when candidates keep failing and the live check passes", async () => {
    mockDbModule.probeDbFile.mockReturnValue("corrupt");
    quickCheckReturns("ok");
    startSession(false);

    await idleTicks(8);

    expect(mockSqlite.backup).toHaveBeenCalledTimes(3);
    expect(notices).toEqual([{ reason: "verification", backup: SAVED }]);
  });

  it("reports stopped backups when candidates repeatedly cannot be verified at all", async () => {
    mockDbModule.probeDbFile.mockReturnValue("unknown");
    startSession(false);

    await idleTicks(5);

    expect(notices).toEqual([{ reason: "verification", backup: SAVED }]);
  });

  it("keeps a single failed verification log-only", async () => {
    mockDbModule.probeDbFile.mockReturnValueOnce("corrupt");
    quickCheckReturns("ok");
    startSession(false);

    await idleTicks(4);

    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("keeps a single failed backup copy log-only", async () => {
    mockSqlite.backup.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    startSession(false);

    await idleTicks(3);

    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("does not count failures that a verified backup came between", async () => {
    mockDbModule.probeDbFile
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("ok")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("unknown");
    startSession(false);

    await idleTicks(6);

    expect(notices).toEqual([]);
  });

  it("raises nothing for corruption the shutdown drain confirms, which the next launch reports", async () => {
    let resolveCheck!: (result: string) => void;
    mockRunDbWork.mockImplementation((op: unknown, fallback: () => unknown) =>
      (op as { op: string }).op === "quickCheck"
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve(fallback())
    );
    startSession(true);
    await idleTicks(1);

    const disposing = service.dispose();
    resolveCheck(CORRUPT_RESULT);
    await disposing;

    expect(mockDbModule.markRecoveryPending).toHaveBeenCalledWith(DB_PATH);
    expect(notices).toEqual([]);
  });

  it("keeps the latch when a listener throws", async () => {
    service = new DatabaseMaintenanceService();
    service.onBackupsSuspended(() => {
      throw new Error("renderer gone");
    });
    service.onBackupsSuspended((notice) => notices.push(notice));
    quickCheckReturns(CORRUPT_RESULT);
    service.initialize(true);
    service.startMaintenance();

    await idleTicks(3);

    expect(notices).toHaveLength(1);
    expect(mockSqlite.backup).not.toHaveBeenCalled();
  });

  it("stops notifying a listener once it unsubscribes", async () => {
    service = new DatabaseMaintenanceService();
    const unsubscribe = service.onBackupsSuspended((notice) => notices.push(notice));
    unsubscribe();
    quickCheckReturns(CORRUPT_RESULT);
    service.initialize(true);
    service.startMaintenance();

    await idleTicks(2);

    expect(notices).toEqual([]);
    expect(mockSqlite.backup).not.toHaveBeenCalled();
  });
});
