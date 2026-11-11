import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs, { type PathLike } from "node:fs";
import path from "node:path";
import os from "node:os";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const windowStatesStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const appMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    getPath: vi.fn(() => "/fake/userData"),
    getVersion: vi.fn(() => "1.0.0"),
    isPackaged: false as boolean,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    }),
    _handlers: handlers,
  };
});

const utilsMock = vi.hoisted(() => ({
  prepareAtomicWriteFile: vi.fn(),
  syncParentDirectory: vi.fn(async () => {}),
  tightenDirPermissions: vi.fn(async () => {}),
  tightenFilePermissions: vi.fn(async () => {}),
  resilientAtomicWriteFileSync: vi.fn(),
  resilientRenameSync: vi.fn(),
  tightenFilePermissionsSync: vi.fn(),
  tightenDirPermissionsSync: vi.fn(),
  OWNER_RW_FILE_MODE: 0o600,
  OWNER_RWX_DIR_MODE: 0o700,
}));

vi.mock("../../utils/fs.js", () => utilsMock);

vi.mock("../../store.js", () => ({
  store: storeMock,
  windowStatesStore: windowStatesStoreMock,
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{}]),
    getFocusedWindow: vi.fn(() => null),
  },
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
}));

vi.mock("../ActionBreadcrumbService.js", () => ({
  getActionBreadcrumbService: () => ({
    getRecentActions: vi.fn(() => []),
  }),
}));

const sleepHandlers = vi.hoisted(() => ({
  suspend: null as (() => void) | null,
  wake: null as (() => void) | null,
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    onSuspend: vi.fn((handler: () => void) => {
      sleepHandlers.suspend = handler;
      return vi.fn();
    }),
    onWake: vi.fn((handler: () => void) => {
      sleepHandlers.wake = handler;
      return vi.fn();
    }),
  }),
}));

vi.mock("../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/logger.js")>()),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { CrashRecoveryService } from "../CrashRecoveryService.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

function writeTemp(filePath: string, data: string): string {
  const tempPath = `${filePath}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, data, "utf-8");
  return tempPath;
}

function lockedError(code = "EPERM"): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: locked`), { code });
}

describe("CrashRecoveryService scheduled writes (#16813)", () => {
  let userData: string;
  let markerPath: string;
  let backupPath: string;
  let previousPath: string;
  let width: number;
  let svc: CrashRecoveryService;
  let releases: (() => void)[];

  const readJson = (filePath: string) => JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const backupWidth = (filePath: string) => readJson(filePath).appState.sidebarWidth;
  const preparedFor = (target: string) =>
    utilsMock.prepareAtomicWriteFile.mock.calls.filter(([fp]) => fp === target).length;
  const backupsRun = () => windowStatesStoreMock.get.mock.calls.length;
  const tempFiles = () =>
    [userData, path.join(userData, "backups")]
      .filter((dir) => fs.existsSync(dir))
      .flatMap((dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")));

  // Parks the next scheduled write of `target` after its state is captured and
  // before anything is renamed into place. Teardown releases it too, so a
  // failed assertion can't leave the drain waiting forever.
  function holdPrepare(target: string): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    releases.push(release);
    const reached = new Promise<void>((resolve) => (entered = resolve));
    let held = false;
    utilsMock.prepareAtomicWriteFile.mockImplementation(async (fp: string, data: string) => {
      if (fp === target && !held) {
        held = true;
        entered();
        await gate;
      }
      return writeTemp(fp, data);
    });
    return { reached, release };
  }

  function writeProjectState(projectId: string, content: string): void {
    const dir = path.join(userData, "projects", projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), content);
  }

  // Rewrites the marker initialize() wrote, so a refreshed heartbeat is
  // distinguishable from none and fields a heartbeat must carry are present.
  function seedMarker(fields: Record<string, unknown>): void {
    fs.writeFileSync(markerPath, JSON.stringify({ ...readJson(markerPath), ...fields }));
  }

  type RenameSpy = MockInstance<typeof fs.renameSync>;

  function renameFailing(shouldFail: (dest: PathLike) => NodeJS.ErrnoException | null): RenameSpy {
    const realRename = fs.renameSync.bind(fs);
    return vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      const error = shouldFail(dest);
      if (error) throw error;
      realRename(src, dest);
    });
  }

  const renamesTo = (spy: RenameSpy, dest: string) =>
    spy.mock.calls.filter((call) => call[1] === dest).length;

  beforeEach(() => {
    vi.clearAllMocks();
    sleepHandlers.suspend = null;
    sleepHandlers.wake = null;
    releases = [];
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-scheduled-"));
    markerPath = path.join(userData, "running.lock");
    backupPath = path.join(userData, "backups", "session-state.json");
    previousPath = path.join(userData, "backups", "session-state.previous.json");
    width = 1;
    appMock.getPath.mockReturnValue(userData);
    storeMock.get.mockImplementation((key: string) =>
      key === "appState"
        ? { sidebarWidth: width, terminals: [] }
        : key === "crashRecovery"
          ? { autoRestoreOnCrash: false }
          : undefined
    );
    windowStatesStoreMock.get.mockReturnValue({});
    utilsMock.prepareAtomicWriteFile.mockImplementation(async (fp: string, data: string) =>
      writeTemp(fp, data)
    );
    utilsMock.resilientAtomicWriteFileSync.mockImplementation((fp: string, data: string) => {
      fs.writeFileSync(fp, data, "utf-8");
    });
    utilsMock.resilientRenameSync.mockImplementation((src: string, dest: string) => {
      fs.renameSync(src, dest);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    svc = new CrashRecoveryService();
  });

  afterEach(async () => {
    for (const release of releases) release();
    svc.stopBackupTimer();
    await svc.whenScheduledWorkSettled();
    vi.useRealTimers();
    fs.rmSync(userData, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads layouts and writes the backup and heartbeat without synchronous disk I/O", async () => {
    const terminals = [
      { id: "t1", kind: "terminal", title: "One" },
      { id: "t2", kind: "agent", agentId: "claude" },
    ];
    writeProjectState(PROJECT_A, JSON.stringify({ terminals }));
    writeProjectState(PROJECT_B, "{not json");
    svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B]);
    svc.initialize();
    seedMarker({ lastHeartbeatMs: 0, lastSuspendStart: 123, crashLogPath: "/crash.json" });
    vi.clearAllMocks();
    const underUserData = (calls: unknown[][]) =>
      calls.filter(([target]) => typeof target === "string" && target.startsWith(userData));
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const statSync = vi.spyOn(fs, "statSync");
    const mkdirSync = vi.spyOn(fs, "mkdirSync");
    const existsSync = vi.spyOn(fs, "existsSync");

    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(underUserData(readFileSync.mock.calls)).toEqual([]);
    expect(underUserData(statSync.mock.calls)).toEqual([]);
    expect(underUserData(mkdirSync.mock.calls)).toEqual([]);
    expect(underUserData(existsSync.mock.calls)).toEqual([]);
    expect(utilsMock.resilientAtomicWriteFileSync).not.toHaveBeenCalled();
    expect(utilsMock.resilientRenameSync).not.toHaveBeenCalled();
    expect(utilsMock.tightenDirPermissionsSync).not.toHaveBeenCalled();
    expect(utilsMock.tightenFilePermissionsSync).not.toHaveBeenCalled();
    expect(utilsMock.syncParentDirectory).toHaveBeenCalledWith(backupPath);
    expect(utilsMock.syncParentDirectory).toHaveBeenCalledWith(markerPath);
    expect(utilsMock.tightenDirPermissions).toHaveBeenCalledWith(path.dirname(backupPath));
    expect(utilsMock.tightenFilePermissions).toHaveBeenCalledWith(backupPath);
    for (const target of [backupPath, markerPath]) {
      expect(utilsMock.prepareAtomicWriteFile).toHaveBeenCalledWith(
        target,
        expect.any(String),
        "utf-8",
        { mode: 0o600 }
      );
    }

    readFileSync.mockRestore();
    const backup = readJson(backupPath);
    expect(backup.projectLayouts).toEqual({ [PROJECT_A]: terminals });
    expect(backup.appState.sidebarWidth).toBe(1);
    const marker = readJson(markerPath);
    expect(marker.lastHeartbeatMs).toBeGreaterThan(0);
    expect(marker.lastSuspendStart).toBe(123);
    expect(marker.crashLogPath).toBe("/crash.json");
    expect(tempFiles()).toEqual([]);
  });

  it("keeps the crash marker when a crash is recorded mid-heartbeat", async () => {
    svc.initialize();
    const hold = holdPrepare(markerPath);
    svc.startBackupTimer();
    await hold.reached;

    svc.recordCrash(new Error("boom"));
    const crashLogPath = readJson(markerPath).crashLogPath;
    expect(crashLogPath).toEqual(expect.stringContaining("crash-"));

    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(readJson(markerPath).crashLogPath).toBe(crashLogPath);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));
  });

  it("leaves no marker behind when a clean exit lands mid-heartbeat", async () => {
    svc.initialize();
    const hold = holdPrepare(markerPath);
    svc.startBackupTimer();
    await hold.reached;

    svc.cleanupOnExit();
    expect(fs.existsSync(markerPath)).toBe(false);

    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(fs.existsSync(markerPath)).toBe(false);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));
  });

  it("keeps a suspend stamp written mid-heartbeat", async () => {
    svc.initialize();
    const hold = holdPrepare(markerPath);
    svc.startBackupTimer();
    await hold.reached;

    sleepHandlers.suspend!();
    expect(typeof readJson(markerPath).lastSuspendStart).toBe("number");

    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(typeof readJson(markerPath).lastSuspendStart).toBe("number");
  });

  it("installs no heartbeat when the schedule stops mid-heartbeat", async () => {
    svc.initialize();
    seedMarker({ lastHeartbeatMs: 0 });
    const hold = holdPrepare(markerPath);
    svc.startBackupTimer();
    await hold.reached;

    svc.stopBackupTimer();
    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(readJson(markerPath).lastHeartbeatMs).toBe(0);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));
  });

  it("starts fresh work on wake while the job suspend superseded is still in flight", async () => {
    svc.initialize();
    seedMarker({ lastHeartbeatMs: 0 });
    const hold = holdPrepare(backupPath);
    svc.startBackupTimer();
    await hold.reached;

    sleepHandlers.suspend!();
    width = 2;
    sleepHandlers.wake!();
    expect(readJson(markerPath).lastSuspendStart).toBeUndefined();
    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(backupsRun()).toBe(2);
    expect(backupWidth(backupPath)).toBe(2);
    expect(fs.existsSync(previousPath)).toBe(false);
    expect(readJson(markerPath).lastHeartbeatMs).toBeGreaterThan(0);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));
  });

  it("never lands an older scheduled backup over a synchronous one", async () => {
    svc.initialize();
    svc.takeBackup();
    const hold = holdPrepare(backupPath);
    width = 2;
    svc.startBackupTimer();
    await hold.reached;

    width = 3;
    svc.takeBackup();
    expect(backupWidth(backupPath)).toBe(3);
    expect(backupWidth(previousPath)).toBe(1);

    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(backupWidth(backupPath)).toBe(3);
    expect(backupWidth(previousPath)).toBe(1);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));

    // The dedup guard still describes the synchronous write, so an unchanged
    // state rotates nothing.
    const writes = preparedFor(backupPath);
    svc.scheduleBackup();
    svc.stopBackupTimer();
    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();
    expect(preparedFor(backupPath)).toBe(writes);
    expect(backupWidth(previousPath)).toBe(1);
  });

  it("is superseded by a synchronous backup that found nothing to write", async () => {
    svc.initialize();
    svc.takeBackup();
    const hold = holdPrepare(backupPath);
    width = 2;
    svc.startBackupTimer();
    await hold.reached;

    width = 1;
    const syncWrites = utilsMock.resilientAtomicWriteFileSync.mock.calls.length;
    svc.takeBackup();
    expect(utilsMock.resilientAtomicWriteFileSync.mock.calls.length).toBe(syncWrites);

    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(backupWidth(backupPath)).toBe(1);
    expect(fs.existsSync(previousPath)).toBe(false);
  });

  it("rewrites unchanged state when the current backup has gone missing", async () => {
    svc.initialize();
    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();
    fs.unlinkSync(backupPath);

    svc.stopBackupTimer();
    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(backupWidth(backupPath)).toBe(1);
  });

  it("coalesces requests made during a hung backup into one trailing run of the latest state", async () => {
    vi.useFakeTimers();
    svc.initialize();
    const hold = holdPrepare(backupPath);
    svc.startBackupTimer();
    await hold.reached;

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    svc.scheduleBackup();
    await vi.advanceTimersByTimeAsync(1_500);
    width = 5;
    expect(backupsRun()).toBe(1);

    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(backupsRun()).toBe(2);
    expect(preparedFor(markerPath)).toBe(1);
    expect(backupWidth(backupPath)).toBe(5);
    expect(backupWidth(previousPath)).toBe(1);
  });

  it("installs nothing when the schedule stops mid-backup", async () => {
    svc.initialize();
    svc.takeBackup();
    const hold = holdPrepare(backupPath);
    width = 2;
    svc.startBackupTimer();
    await hold.reached;

    svc.stopBackupTimer();
    hold.release();
    await svc.whenScheduledWorkSettled();

    expect(backupWidth(backupPath)).toBe(1);
    expect(fs.existsSync(previousPath)).toBe(false);
    expect(preparedFor(markerPath)).toBe(0);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));
  });

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a heartbeat rename locked with %s after waiting, then installs it",
    async (code) => {
      svc.initialize();
      seedMarker({ lastHeartbeatMs: 0 });
      let failures = 2;
      let firstFailedAt: number | null = null;
      let installedAt: number | null = null;
      const renameSync = renameFailing((dest) => {
        if (dest !== markerPath) return null;
        if (failures-- > 0) {
          firstFailedAt ??= Date.now();
          return lockedError(code);
        }
        installedAt = Date.now();
        return null;
      });

      svc.startBackupTimer();
      await svc.whenScheduledWorkSettled();

      // Waits of 25ms and 50ms; a retry that only yielded microtasks would
      // land at once.
      expect(installedAt! - firstFailedAt!).toBeGreaterThanOrEqual(60);
      expect(renamesTo(renameSync, markerPath)).toBe(3);
      expect(readJson(markerPath).lastHeartbeatMs).toBeGreaterThan(0);
      expect(tempFiles()).toEqual([]);
    }
  );

  it("gives up on a rename that stays locked and keeps the old marker", async () => {
    svc.initialize();
    seedMarker({ lastHeartbeatMs: 0 });
    const renameSync = renameFailing((dest) => (dest === markerPath ? lockedError() : null));

    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(renamesTo(renameSync, markerPath)).toBe(6);
    expect(readJson(markerPath).lastHeartbeatMs).toBe(0);
    await vi.waitFor(() => expect(tempFiles()).toEqual([]));
  });

  it("stops retrying a locked heartbeat rename once a crash supersedes it", async () => {
    svc.initialize();
    let firstFailure!: () => void;
    const failed = new Promise<void>((resolve) => (firstFailure = resolve));
    const renameSync = renameFailing((dest) => {
      if (dest !== markerPath) return null;
      firstFailure();
      return lockedError("EBUSY");
    });

    svc.startBackupTimer();
    await failed;
    svc.recordCrash(new Error("boom"));
    await svc.whenScheduledWorkSettled();

    expect(renamesTo(renameSync, markerPath)).toBe(1);
    expect(readJson(markerPath).crashLogPath).toEqual(expect.stringContaining("crash-"));
  });

  it("rotates once when the install is retried after a locked rename", async () => {
    svc.initialize();
    svc.takeBackup();
    width = 2;
    let installFailures = 1;
    const renameSync = renameFailing((dest) =>
      dest === backupPath && installFailures-- > 0 ? lockedError() : null
    );

    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(renamesTo(renameSync, previousPath)).toBe(1);
    expect(renamesTo(renameSync, backupPath)).toBe(2);
    expect(backupWidth(backupPath)).toBe(2);
    expect(backupWidth(previousPath)).toBe(1);
  });

  it("retries a locked rotation, then installs on the install's own retries", async () => {
    svc.initialize();
    svc.takeBackup();
    width = 2;
    let rotationFailures = 5;
    let installFailures = 1;
    const renameSync = renameFailing((dest) => {
      if (dest === previousPath && rotationFailures-- > 0) return lockedError("EBUSY");
      if (dest === backupPath && installFailures-- > 0) return lockedError();
      return null;
    });

    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(renamesTo(renameSync, previousPath)).toBe(6);
    expect(renamesTo(renameSync, backupPath)).toBe(2);
    expect(backupWidth(backupPath)).toBe(2);
    expect(backupWidth(previousPath)).toBe(1);
  });
});
