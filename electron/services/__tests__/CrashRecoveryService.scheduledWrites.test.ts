import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
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
  // before anything is renamed into place.
  function holdPrepare(target: string): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
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

  beforeEach(() => {
    vi.clearAllMocks();
    sleepHandlers.suspend = null;
    sleepHandlers.wake = null;
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
    svc.stopBackupTimer();
    await svc.whenScheduledWorkSettled();
    vi.useRealTimers();
    fs.rmSync(userData, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads layouts and writes the backup and heartbeat without synchronous disk I/O", async () => {
    writeProjectState(PROJECT_A, JSON.stringify({ terminals: [{ id: "t1", kind: "terminal" }] }));
    writeProjectState(PROJECT_B, "{not json");
    svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B]);
    svc.initialize();
    const initialHeartbeat = readJson(markerPath).lastHeartbeatMs;
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

    readFileSync.mockRestore();
    const backup = readJson(backupPath);
    expect(Object.keys(backup.projectLayouts)).toEqual([PROJECT_A]);
    expect(backup.appState.sidebarWidth).toBe(1);
    expect(readJson(markerPath).lastHeartbeatMs).toBeGreaterThanOrEqual(initialHeartbeat);
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

  it("retries a locked heartbeat rename by yielding, then installs it", async () => {
    svc.initialize();
    const realRename = fs.renameSync.bind(fs);
    let failures = 2;
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (dest === markerPath && failures-- > 0) throw lockedError();
      realRename(src, dest);
    });
    const before = readJson(markerPath).lastHeartbeatMs;

    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(renameSync.mock.calls.filter(([, dest]) => dest === markerPath)).toHaveLength(3);
    expect(readJson(markerPath).lastHeartbeatMs).toBeGreaterThanOrEqual(before);
    expect(tempFiles()).toEqual([]);
  });

  it("stops retrying a locked heartbeat rename once a crash supersedes it", async () => {
    svc.initialize();
    let firstFailure!: () => void;
    const failed = new Promise<void>((resolve) => (firstFailure = resolve));
    const realRename = fs.renameSync.bind(fs);
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (dest === markerPath) {
        firstFailure();
        throw lockedError("EBUSY");
      }
      realRename(src, dest);
    });

    svc.startBackupTimer();
    await failed;
    svc.recordCrash(new Error("boom"));
    await svc.whenScheduledWorkSettled();

    expect(renameSync.mock.calls.filter(([, dest]) => dest === markerPath)).toHaveLength(1);
    expect(readJson(markerPath).crashLogPath).toEqual(expect.stringContaining("crash-"));
  });

  it("rotates once when the install is retried after a locked rename", async () => {
    svc.initialize();
    svc.takeBackup();
    width = 2;
    const realRename = fs.renameSync.bind(fs);
    let installFailures = 1;
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (dest === backupPath && installFailures-- > 0) throw lockedError();
      realRename(src, dest);
    });

    svc.startBackupTimer();
    await svc.whenScheduledWorkSettled();

    expect(renameSync.mock.calls.filter(([, dest]) => dest === previousPath)).toHaveLength(1);
    expect(renameSync.mock.calls.filter(([, dest]) => dest === backupPath)).toHaveLength(2);
    expect(backupWidth(backupPath)).toBe(2);
    expect(backupWidth(previousPath)).toBe(1);
  });
});
