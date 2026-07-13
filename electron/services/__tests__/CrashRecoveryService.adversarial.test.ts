import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const windowStatesStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/fake/userData"),
  getVersion: vi.fn(() => "1.0.0"),
  isPackaged: false as boolean,
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [{}]),
  getFocusedWindow: vi.fn(() => null),
}));

const utilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFileSync: vi.fn(),
  resilientRenameSync: vi.fn(),
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
  BrowserWindow: browserWindowMock,
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
}));

import { CrashRecoveryService } from "../CrashRecoveryService.js";

function makeService(): CrashRecoveryService {
  return new CrashRecoveryService();
}

function writeBackup(userData: string, snapshot: unknown): void {
  const backupDir = path.join(userData, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));
}

function writeMarker(userData: string, overrides?: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(userData, "running.lock"),
    JSON.stringify({
      sessionStartMs: Date.now() - 5_000,
      appVersion: "1.0.0",
      platform: "darwin",
      ...overrides,
    })
  );
}

describe("CrashRecoveryService adversarial", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-adversarial-"));
    appMock.getPath.mockReturnValue(tmpDir);
    appMock.isPackaged = false;
    storeMock.get.mockImplementation((key: string) => {
      if (key === "crashRecovery") {
        return { autoRestoreOnCrash: false };
      }
      if (key === "appState") {
        return { terminals: [] };
      }
      return undefined;
    });
    storeMock.set.mockImplementation(() => {});
    utilsMock.resilientAtomicWriteFileSync.mockImplementation(
      (fp: string, data: string, enc?: BufferEncoding) => {
        fs.writeFileSync(fp, data, enc ?? "utf-8");
      }
    );
    utilsMock.resilientRenameSync.mockImplementation((src: string, dest: string) => {
      fs.renameSync(src, dest);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("TRUNCATED_BACKUP_JSON_FAILS_CLOSED", () => {
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "session-state.json"), '{"appState":');

    const service = makeService();

    expect(service.restoreBackup()).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("INVALID_SNAPSHOT_SHAPE_NO_GARBAGE_WRITES", () => {
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      windowStates: "oops",
      appState: {
        terminals: {},
      },
    });

    const service = makeService();

    expect(service.restoreBackup()).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("RENAMED_BACKUP_SURVIVES_TIMER_OVERWRITE", () => {
    // Issue #8681: consumeMarker renames the live backup to a timestamped
    // crashed-* path so the new session's backup tick can write a fresh
    // session-state.json without clobbering the pre-crash snapshot. The
    // renamed file is the durable cache — no in-memory state to drift.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [{ id: "agent-1", kind: "terminal", title: "Recovered" }],
      },
      windowStates: {
        "/home/user/project-a": { width: 1200, height: 800, isMaximized: false },
      },
    });
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    // Simulate the backup timer recreating session-state.json with the empty
    // current session after the marker has been consumed.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [],
      },
    });

    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [{ id: "agent-1", kind: "terminal", title: "Recovered" }],
    });
    expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", {
      "/home/user/project-a": { width: 1200, height: 800, isMaximized: false },
    });
  });

  it("PANEL_SUMMARIES_READ_RENAMED_FILE_NOT_LIVE_PATH", () => {
    // Issue #8681: extractPanelSummaries must read from the renamed
    // crashed-* file, not from session-state.json — otherwise a concurrent
    // overwrite (backup tick, external process) would silently swap
    // pre-crash panels for the empty post-crash session.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [{ id: "agent-1", kind: "terminal", title: "Pre-Crash" }],
      },
    });
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    // Overwrite the live path right after consumeMarker. Panel summaries
    // were captured during initialize and stored on PendingCrash; they
    // must still reflect the pre-crash terminals.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: { terminals: [] },
    });

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    expect(pending!.panels).toBeDefined();
    expect(pending!.panels!.length).toBe(1);
    expect(pending!.panels![0]).toMatchObject({ id: "agent-1", title: "Pre-Crash" });
  });

  it("PRESERVE_BEFORE_DELETE_MARKER_AVOIDS_LOST_CRASH_DETECTION", () => {
    // Issue #8681 review finding: if deleteMarker fires before the backup
    // is preserved, a kill between the two leaves no marker on disk and
    // the next launch silently skips crash detection. Order must be:
    // preserve first, then delete. Simulate the kill-after-preserve case
    // by leaving the crashed-* file from a "prior attempt" on disk; the
    // second consumeMarker pass must reuse it idempotently.
    const sessionStartMs = Date.now() - 5_000;
    fs.writeFileSync(
      path.join(tmpDir, "running.lock"),
      JSON.stringify({
        sessionStartMs,
        appVersion: "1.0.0",
        platform: "darwin",
      })
    );

    // Pre-existing crashed-* file from a previous (killed) consumeMarker
    // attempt. session-state.json is absent — already renamed last time.
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, `session-state.crashed-${sessionStartMs}.json`),
      JSON.stringify({
        capturedAt: Date.now(),
        appState: { terminals: [{ id: "agent-1", kind: "terminal", title: "Survived" }] },
      })
    );

    const service = makeService();
    service.initialize();

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    expect(pending!.hasBackup).toBe(true);
    expect(pending!.panels!.length).toBe(1);
    expect(pending!.panels![0]).toMatchObject({ id: "agent-1", title: "Survived" });
    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [{ id: "agent-1", kind: "terminal", title: "Survived" }],
    });
  });

  it("FILTER_WITH_NO_MATCHES_KEEPS_RECOVERY_SOURCE_FOR_RETRY", () => {
    // Stale or typo'd panel IDs would otherwise empty the filter, succeed
    // restoreBackup, and unlink the crashed-* file — silently dropping
    // the recovery source. Return false instead so a follow-up restore
    // (without the bad filter) still finds the snapshot.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [
          { id: "a", kind: "terminal", title: "Alpha" },
          { id: "b", kind: "terminal", title: "Bravo" },
        ],
      },
    });
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    expect(service.restoreBackup(["nonexistent"])).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();

    // Retry with no filter — must still see both panels.
    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [
        { id: "a", kind: "terminal", title: "Alpha" },
        { id: "b", kind: "terminal", title: "Bravo" },
      ],
    });
  });

  it("NULL_TERMINAL_IN_BACKUP_DOES_NOT_DROP_VALID_PANELS", () => {
    // Issue #8681 review finding: one malformed terminal entry must not
    // drop all panel summaries. Per-item guard yields the valid subset.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [
          { id: "t1", kind: "terminal", title: "Alpha" },
          null,
          "garbage",
          { id: "t2", kind: "terminal", title: "Bravo" },
        ],
      },
    });
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    expect(pending!.panels).toBeDefined();
    expect(pending!.panels!.length).toBe(2);
    expect(pending!.panels![0]).toMatchObject({ id: "t1", title: "Alpha" });
    expect(pending!.panels![1]).toMatchObject({ id: "t2", title: "Bravo" });
  });

  it("RENAME_FAILURE_FALLS_BACK_TO_COPY_PLUS_UNLINK", () => {
    // Windows antivirus and search indexers can hold session-state.json
    // open long enough that resilientRenameSync exhausts its 500ms retry
    // budget. The fallback copies content to the crashed-* path and
    // unlinks the original so the pre-crash snapshot is never lost.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [{ id: "agent-1", kind: "terminal", title: "Lock-Bypass" }],
      },
    });
    writeMarker(tmpDir);

    utilsMock.resilientRenameSync.mockImplementationOnce(() => {
      const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    });

    const service = makeService();
    service.initialize();

    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [{ id: "agent-1", kind: "terminal", title: "Lock-Bypass" }],
    });
  });

  it("FILTERED_RESTORE_DOES_NOT_NARROW_CACHE_ON_FAILURE", () => {
    // restoreBackup applies a panelIds filter when the user picks a subset
    // to restore. The filter must operate on a copy of the cached snapshot
    // — otherwise a failed applySessionSnapshot leaves the cache narrowed
    // and a retry (different filter, or no filter) silently drops panels
    // that were never restored.
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [
          { id: "a", kind: "terminal", title: "Alpha" },
          { id: "b", kind: "terminal", title: "Bravo" },
        ],
      },
    });
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    // First restore filters to just "a" but the underlying store.set
    // throws, simulating a partial-write or transient failure.
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("transient store failure");
    });
    expect(service.restoreBackup(["a"])).toBe(false);

    // Retry without a filter — must still see both panels because the
    // cache was not destructively narrowed by the failed first attempt.
    storeMock.set.mockImplementation(() => {});
    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenLastCalledWith("appState", {
      terminals: [
        { id: "a", kind: "terminal", title: "Alpha" },
        { id: "b", kind: "terminal", title: "Bravo" },
      ],
    });
  });

  it("STARTBACKUPTIMER_IDEMPOTENT", () => {
    const service = makeService();
    const takeBackup = vi.spyOn(service, "takeBackup").mockImplementation(() => {});

    service.startBackupTimer();
    service.startBackupTimer();
    vi.advanceTimersByTime(60_000);

    expect(takeBackup).toHaveBeenCalledTimes(2);
  });

  it("NESTED_STATE_ROUND_TRIPS", () => {
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [
          {
            id: "panel-1",
            kind: "terminal",
            meta: {
              badges: ["active", "pinned"],
              layout: {
                docked: true,
                column: 2,
              },
            },
          },
        ],
      },
      windowStates: {
        main: {
          bounds: { width: 1440, height: 900 },
          tabs: [{ id: "panel-1", kind: "terminal" }],
        },
      },
    });

    const service = makeService();

    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [
        {
          id: "panel-1",
          kind: "terminal",
          meta: {
            badges: ["active", "pinned"],
            layout: {
              docked: true,
              column: 2,
            },
          },
        },
      ],
    });
    expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", {
      main: {
        bounds: { width: 1440, height: 900 },
        tabs: [{ id: "panel-1", kind: "terminal" }],
      },
    });
  });

  it("CORRUPT_CRASH_LOG_FALLS_BACK", () => {
    const crashDir = path.join(tmpDir, "crashes");
    fs.mkdirSync(crashDir, { recursive: true });
    const crashLogPath = path.join(crashDir, "crash-bad.json");
    fs.writeFileSync(crashLogPath, "{bad json");
    writeMarker(tmpDir, { crashLogPath });

    const service = makeService();
    service.initialize();

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    expect(pending?.entry.appVersion).toBe("1.0.0");
    expect(typeof pending?.entry.timestamp).toBe("number");
    expect(typeof pending?.entry.windowCount).toBe("number");
  });

  it("MARKER_PLUS_BAD_BACKUP_DOES_NOT_BRICK", () => {
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "session-state.json"), "{bad json");
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    // With backup rotation (#8699): a corrupt current with no usable previous
    // reports hasBackup=false so the recovery UI doesn't offer a restore that
    // would silently fail. The safety invariant remains: the app doesn't brick
    // (pending is non-null, panels are an empty array, restoreBackup returns
    // false rather than throwing).
    expect(pending?.hasBackup).toBe(false);
    expect(pending?.panels).toBeUndefined();
    expect(service.restoreBackup()).toBe(false);
  });

  it("PANEL_FILTER_ONE_SHOT_AFTER_FAILED_RESTORE", () => {
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "session-state.json"), "not json");
    const service = makeService();

    service.setPanelFilter(["a", "b"]);

    expect(service.restoreBackup()).toBe(false);
    expect(service.consumePanelFilter()).toEqual(["a", "b"]);
    expect(service.consumePanelFilter()).toBeNull();
  });
});
