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

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [{}]),
  getFocusedWindow: vi.fn(() => null),
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
}));

const getRecentActionsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));

vi.mock("../ActionBreadcrumbService.js", () => ({
  getActionBreadcrumbService: () => ({
    getRecentActions: getRecentActionsMock,
  }),
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    onSuspend: vi.fn(() => vi.fn()),
    onWake: vi.fn(() => vi.fn()),
  }),
}));

import { BrowserWindow } from "electron";
import { CrashRecoveryService } from "../CrashRecoveryService.js";

function makeService(): CrashRecoveryService {
  return new CrashRecoveryService();
}

describe("CrashRecoveryService", () => {
  let tmpDir: string;
  let userData: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-test-"));
    userData = tmpDir;
    appMock.getPath.mockReturnValue(userData);
    appMock.isPackaged = false;
    storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("blur backup", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 400, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});
      appMock._handlers.clear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function getBlurHandler(): () => void {
      const h = appMock._handlers.get("browser-window-blur");
      if (!h) throw new Error("browser-window-blur handler not registered");
      return h as () => void;
    }

    function getFocusHandler(): () => void {
      const h = appMock._handlers.get("browser-window-focus");
      if (!h) throw new Error("browser-window-focus handler not registered");
      return h as () => void;
    }

    it("registers blur and focus listeners on startBackupTimer", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      expect(appMock.on).toHaveBeenCalledWith("browser-window-blur", expect.any(Function));
      expect(appMock.on).toHaveBeenCalledWith("browser-window-focus", expect.any(Function));
    });

    it("unregisters blur and focus listeners on stopBackupTimer", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      svc.stopBackupTimer();

      expect(appMock.removeListener).toHaveBeenCalledWith(
        "browser-window-blur",
        expect.any(Function)
      );
      expect(appMock.removeListener).toHaveBeenCalledWith(
        "browser-window-focus",
        expect.any(Function)
      );
    });

    it("calls takeBackup after 100ms debounce when no window is focused", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      const spy = vi.spyOn(svc, "takeBackup");
      (BrowserWindow.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

      getBlurHandler()();
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("does not call takeBackup when another window is focused after blur", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      const spy = vi.spyOn(svc, "takeBackup");
      (BrowserWindow.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(
        {} as Electron.BrowserWindow
      );

      getBlurHandler()();
      vi.advanceTimersByTime(100);

      expect(spy).not.toHaveBeenCalled();
    });

    it("cancels blur backup when focus arrives within debounce window", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      const spy = vi.spyOn(svc, "takeBackup");
      (BrowserWindow.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

      getBlurHandler()();
      vi.advanceTimersByTime(50);

      (BrowserWindow.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(
        {} as Electron.BrowserWindow
      );
      getFocusHandler()();

      vi.advanceTimersByTime(100);

      expect(spy).not.toHaveBeenCalled();
    });

    it("deduplicates rapid blur events (debounce reset)", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      const spy = vi.spyOn(svc, "takeBackup");
      (BrowserWindow.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

      getBlurHandler()();
      vi.advanceTimersByTime(50);
      getBlurHandler()();
      vi.advanceTimersByTime(50);

      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("startBackupTimer is idempotent for blur listeners", () => {
      const svc = makeService();
      svc.initialize();

      svc.startBackupTimer();
      const onCallCount = appMock.on.mock.calls.length;

      svc.startBackupTimer();
      expect(appMock.on.mock.calls.length).toBe(onCallCount);
    });

    it("stopBackupTimer clears pending blur debounce", () => {
      const svc = makeService();
      svc.initialize();
      svc.startBackupTimer();

      const spy = vi.spyOn(svc, "takeBackup");
      (BrowserWindow.getFocusedWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

      getBlurHandler()();
      svc.stopBackupTimer();

      vi.advanceTimersByTime(200);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("watchdog attribution", () => {
    function writeMarker(sessionStartMs: number): void {
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );
    }

    function writeWatchdogFlag(payload: unknown, mtimeMs?: number): string {
      const flagPath = path.join(userData, "watchdog-kill.flag");
      fs.writeFileSync(flagPath, JSON.stringify(payload), "utf8");
      if (typeof mtimeMs === "number") {
        const t = new Date(mtimeMs);
        fs.utimesSync(flagPath, t, t);
      }
      return flagPath;
    }

    it("annotates the crash entry when a fresh watchdog flag is present", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      const killedAt = sessionStartMs + 16_000;
      writeWatchdogFlag({ killedAt, missedBeats: 3, mainPid: 4242 }, killedAt);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.cause).toBe("watchdog-deadlock");
      expect(pending!.entry.watchdogKilledAt).toBe(killedAt);
      expect(pending!.entry.watchdogMissedBeats).toBe(3);
      expect(pending!.entry.watchdogMainPid).toBe(4242);
    });

    it("consumes (unlinks) the flag regardless of attribution outcome", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      const flagPath = writeWatchdogFlag(
        { killedAt: sessionStartMs + 16_000, missedBeats: 3, mainPid: 4242 },
        sessionStartMs + 16_000
      );

      const svc = makeService();
      svc.initialize();

      expect(fs.existsSync(flagPath)).toBe(false);
    });

    it("leaves entry without cause when no watchdog flag is present", () => {
      writeMarker(Date.now() - 5000);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.cause).toBeUndefined();
      expect(pending!.entry.watchdogKilledAt).toBeUndefined();
    });

    it("rejects a stale flag (mtime far earlier than current session) and still unlinks it", () => {
      const sessionStartMs = Date.now() - 1000;
      writeMarker(sessionStartMs);
      // Stale flag: mtime is 1 hour before this session started — clearly
      // a leftover from a previous run where unlink failed.
      const staleMtime = sessionStartMs - 3_600_000;
      const flagPath = writeWatchdogFlag(
        { killedAt: staleMtime, missedBeats: 3, mainPid: 4242 },
        staleMtime
      );

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.cause).toBeUndefined();
      // Flag is still cleaned up so it can't poison the next launch.
      expect(fs.existsSync(flagPath)).toBe(false);
    });

    it("accepts a flag whose mtime is within the 5-second grace window before sessionStartMs", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      // 3 seconds before sessionStartMs is within the 5s grace — should still
      // be treated as fresh (clock drift / fs mtime resolution).
      const mtime = sessionStartMs - 3_000;
      writeWatchdogFlag({ killedAt: mtime, missedBeats: 3, mainPid: 4242 }, mtime);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending!.entry.cause).toBe("watchdog-deadlock");
    });

    it("ignores a malformed JSON flag, warns, and unlinks it", () => {
      const sessionStartMs = Date.now() - 5_000;
      writeMarker(sessionStartMs);
      const flagPath = path.join(userData, "watchdog-kill.flag");
      fs.writeFileSync(flagPath, "not valid json{{{", "utf8");

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.cause).toBeUndefined();
      expect(fs.existsSync(flagPath)).toBe(false);
      expect(console.warn).toHaveBeenCalled();
    });

    it("ignores a flag whose payload is the right shape but missing fields", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      // missedBeats omitted
      writeWatchdogFlag(
        { killedAt: sessionStartMs + 16_000, mainPid: 4242 },
        sessionStartMs + 16_000
      );

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending!.entry.cause).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });

    it("annotates entries built from an existing crash log too", () => {
      const sessionStartMs = Date.now() - 20_000;
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-precrash.json");
      fs.writeFileSync(
        crashLogPath,
        JSON.stringify({
          id: "precrash",
          timestamp: Date.now() - 10_000,
          appVersion: "1.0.0",
          platform: "darwin",
          osVersion: "23.0",
          arch: "arm64",
          errorMessage: "pre-existing crash record",
        })
      );
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs,
          appVersion: "1.0.0",
          platform: "darwin",
          crashLogPath,
        })
      );
      const killedAt = sessionStartMs + 16_000;
      writeWatchdogFlag({ killedAt, missedBeats: 3, mainPid: 4242 }, killedAt);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending!.entry.errorMessage).toBe("pre-existing crash record");
      expect(pending!.entry.cause).toBe("watchdog-deadlock");
      expect(pending!.entry.watchdogMissedBeats).toBe(3);
    });

    it("persists the annotation back onto the on-disk crash log file", () => {
      const sessionStartMs = Date.now() - 20_000;
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-disk-update.json");
      fs.writeFileSync(
        crashLogPath,
        JSON.stringify({
          id: "disk-update",
          timestamp: Date.now() - 10_000,
          appVersion: "1.0.0",
          platform: "darwin",
          osVersion: "23.0",
          arch: "arm64",
        })
      );
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs,
          appVersion: "1.0.0",
          platform: "darwin",
          crashLogPath,
        })
      );
      const killedAt = sessionStartMs + 16_000;
      writeWatchdogFlag({ killedAt, missedBeats: 3, mainPid: 4242 }, killedAt);

      const svc = makeService();
      svc.initialize();

      const onDisk = JSON.parse(fs.readFileSync(crashLogPath, "utf8"));
      expect(onDisk.cause).toBe("watchdog-deadlock");
      expect(onDisk.watchdogKilledAt).toBe(killedAt);
      expect(onDisk.watchdogMissedBeats).toBe(3);
      expect(onDisk.watchdogMainPid).toBe(4242);
    });

    it("surfaces a dev-mode crash with a fresh watchdog flag (otherwise discarded as orphan)", () => {
      const sessionStartMs = Date.now() - 20_000;
      // Dev-mode orphan marker — no crashLogPath, isPackaged: false — that
      // would normally be discarded. The fresh watchdog flag must promote it
      // to a genuine watchdog-deadlock crash and the flag must be unlinked.
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs,
          appVersion: "1.0.0",
          platform: "darwin",
          isPackaged: false,
        })
      );
      const killedAt = sessionStartMs + 16_000;
      const flagPath = writeWatchdogFlag({ killedAt, missedBeats: 3, mainPid: 4242 }, killedAt);

      appMock.isPackaged = false;
      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.cause).toBe("watchdog-deadlock");
      expect(pending!.entry.watchdogMissedBeats).toBe(3);
      expect(fs.existsSync(flagPath)).toBe(false);
    });

    it("unlinks a stale flag even when the dev-mode marker is discarded as orphaned", () => {
      const sessionStartMs = Date.now() - 1000;
      // Dev orphan marker + stale flag from a prior session — the orphan is
      // correctly discarded but the stale flag must still be cleaned up so
      // it doesn't poison the next launch.
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs,
          appVersion: "1.0.0",
          platform: "darwin",
          isPackaged: false,
        })
      );
      const staleMtime = sessionStartMs - 3_600_000;
      const flagPath = writeWatchdogFlag(
        { killedAt: staleMtime, missedBeats: 3, mainPid: 4242 },
        staleMtime
      );

      appMock.isPackaged = false;
      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).toBeNull();
      expect(fs.existsSync(flagPath)).toBe(false);
    });

    it("rejects flag payloads with non-positive numeric values", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      const mtime = sessionStartMs + 16_000;
      // All-zero numbers: pass `typeof === "number"` but are not real values
      // produced by buildWatchdogKillPayload (killedAt = Date.now() > 0,
      // missedBeats >= 1, mainPid > 0).
      writeWatchdogFlag({ killedAt: 0, missedBeats: 0, mainPid: 0 }, mtime);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending!.entry.cause).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });

    it("accepts a flag just inside the inclusive grace window (sessionStartMs - 4900)", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      // 100ms inside the 5s grace boundary — comfortably above filesystem
      // mtime precision on Linux ext4 / macOS HFS+, so the test is reliable
      // across CI platforms. The exact boundary (sessionStartMs - 5000) is
      // unsafe to assert here because fs.utimesSync(Date) rounds through
      // float seconds and the round-trip can land 1-2ms either side.
      const insideMtime = sessionStartMs - 4_900;
      writeWatchdogFlag({ killedAt: insideMtime, missedBeats: 3, mainPid: 4242 }, insideMtime);

      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()!.entry.cause).toBe("watchdog-deadlock");
    });

    it("rejects a flag clearly outside the grace window", () => {
      const sessionStartMs = Date.now() - 20_000;
      writeMarker(sessionStartMs);
      // 100ms outside the 5s grace — clearly stale, robust to fs mtime
      // rounding on all platforms.
      const outsideMtime = sessionStartMs - 5_100;
      writeWatchdogFlag({ killedAt: outsideMtime, missedBeats: 3, mainPid: 4242 }, outsideMtime);

      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()!.entry.cause).toBeUndefined();
    });
  });

  describe("marker-only crash timestamp", () => {
    // Each test pins a marker at T0, advances the wall clock by DEAD_MS, then
    // initializes. The dead interval is the gap between when the previous
    // session died and when the current session discovered its corpse; the
    // bug (per #10062) was that the new entry stamped DEAD_MS as its
    // sessionDurationMs and relaunch time as the crash time.

    const T0 = 1_700_000_000_000;
    const DEAD_MS = 7_200_000; // 2 hours

    function writeMarkerWithHeartbeat(
      lastHeartbeatMs: number,
      extras: Record<string, unknown> = {}
    ): void {
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs: T0,
          appVersion: "1.0.0",
          platform: "darwin",
          lastHeartbeatMs,
          ...extras,
        })
      );
    }

    function writeBackup(terminals: Array<{ id: string; createdAt: number }>): string {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, "session-state.json");
      fs.writeFileSync(
        backupPath,
        JSON.stringify({ capturedAt: T0 + 60_000, appState: { terminals } })
      );
      return backupPath;
    }

    beforeEach(() => {
      // Fake timers must include Date so Date.now() advances with the clock —
      // the existing boundary test (1018-1069) collapses T0 and now because
      // they share the same tick, hiding the bug. Lesson #7917.
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      vi.setSystemTime(T0 + DEAD_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("uses the last heartbeat as the crash time when no other signal exists", () => {
      const heartbeat = T0 + 5 * 60_000; // 5 minutes into the session
      writeMarkerWithHeartbeat(heartbeat);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      // The bug: this used to be T0 + DEAD_MS (relaunch time).
      expect(pending!.entry.timestamp).toBe(heartbeat);
      expect(pending!.entry.sessionDurationMs).toBe(heartbeat - T0);
    });

    it("prefers the watchdog killedAt over the heartbeat when both exist", () => {
      const heartbeat = T0 + 30 * 60_000;
      const killedAt = T0 + 45 * 60_000;
      writeMarkerWithHeartbeat(heartbeat);
      // Flag mtime must be fresh (>= sessionStartMs - GRACE_MS) for
      // consumeWatchdogKillFlag to surface the annotation.
      const flagPath = path.join(userData, "watchdog-kill.flag");
      fs.writeFileSync(
        flagPath,
        JSON.stringify({ killedAt, missedBeats: 3, mainPid: 4242 }),
        "utf8"
      );
      fs.utimesSync(flagPath, new Date(killedAt), new Date(killedAt));

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(killedAt);
      expect(pending!.entry.sessionDurationMs).toBe(killedAt - T0);
      expect(pending!.entry.cause).toBe("watchdog-deadlock");
    });

    it("prefers lastSuspendStart over backup mtime and heartbeat", () => {
      const heartbeat = T0 + 30 * 60_000;
      const suspendStart = T0 + 50 * 60_000;
      // Write a backup whose mtime is later than suspendStart; if the
      // priority order is wrong (suspend < backup), this test will fail.
      const backupPath = writeBackup([{ id: "t1", createdAt: T0 }]);
      const backupMtime = suspendStart + 5 * 60_000;
      fs.utimesSync(backupPath, new Date(backupMtime), new Date(backupMtime));

      writeMarkerWithHeartbeat(heartbeat, { lastSuspendStart: suspendStart });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(suspendStart);
      expect(pending!.entry.crashCause).toBe("suspended-then-lost");
    });

    it("prefers backup capturedAt over the heartbeat when suspend/watchdog are absent", () => {
      const heartbeat = T0 + 30 * 60_000;
      const capturedAt = T0 + 40 * 60_000;
      const backupPath = writeBackup([{ id: "t1", createdAt: T0 }]);
      // Override capturedAt — it's the in-snapshot timestamp the resolver
      // reads, not the on-disk mtime. (See the Windows/EPERM regression
      // test below for why we trust capturedAt over the file mtime.)
      const raw = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      raw.capturedAt = capturedAt;
      fs.writeFileSync(backupPath, JSON.stringify(raw));
      fs.utimesSync(backupPath, new Date(T0 + 50 * 60_000), new Date(T0 + 50 * 60_000));

      writeMarkerWithHeartbeat(heartbeat);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(capturedAt);
    });

    it("clamps a heartbeat in the future down to the relaunch time", () => {
      // Clock skew: heartbeat is 5 minutes past relaunch (laptop woke from
      // sleep, NTP correction, or fs mtime precision drift). Must clamp to
      // relaunch time so sessionDurationMs is non-negative and the suspect
      // window is not future-dated.
      const futureHeartbeat = T0 + DEAD_MS + 5 * 60_000;
      writeMarkerWithHeartbeat(futureHeartbeat);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(T0 + DEAD_MS);
      expect(pending!.entry.sessionDurationMs).toBe(DEAD_MS);
    });

    it("ignores NaN/Infinity candidates and falls through to a finite one", () => {
      const heartbeat = T0 + 5 * 60_000;
      writeMarkerWithHeartbeat(heartbeat, {
        lastSuspendStart: Number.NaN,
        // backup mtime is undefined (no backup), but the marker has
        // a finite heartbeat that must still win.
      });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(heartbeat);
    });

    it("falls back to the relaunch time when no candidate is usable", () => {
      // Marker with no heartbeat, no suspend, no backup — pathological but
      // the fallback must still produce a finite, clamped timestamp.
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs: T0,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(T0 + DEAD_MS);
      expect(pending!.entry.sessionDurationMs).toBe(DEAD_MS);
    });

    it("drives the suspect window from the corrected timestamp (#10062 regression)", () => {
      // Headline regression test: a panel created 5min into the session
      // should be flagged as a suspect after a 2h dead interval, because
      // the crash happened (per the heartbeat) at T0+5min, not at the
      // relaunch time. The pre-fix code stamped relaunch time and the
      // panel would have been classified as safe — silently breaking
      // the OOM-kill-loop signal in PanelSuspectLedgerService.
      const heartbeat = T0 + 5 * 60_000;
      const backupPath = writeBackup([
        { id: "near", createdAt: heartbeat - 5_000 },
        { id: "far", createdAt: heartbeat + 3 * 60_000 },
      ]);
      // Pin the backup's capturedAt to the heartbeat. The resolver reads
      // capturedAt (not disk mtime) per the Windows/EPERM fix, so this
      // is the value that wins the priority chain. Make it equal to the
      // heartbeat so the heartbeat is the chosen estimate; set
      // heartbeat a hair after capturedAt so the "near" panel lands
      // inside the 30s window.
      const raw = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      raw.capturedAt = heartbeat - 1_000; // just before heartbeat
      fs.writeFileSync(backupPath, JSON.stringify(raw));
      fs.utimesSync(backupPath, new Date(heartbeat), new Date(heartbeat));
      writeMarkerWithHeartbeat(heartbeat);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      const near = pending!.panels!.find((p) => p.id === "near")!;
      const far = pending!.panels!.find((p) => p.id === "far")!;
      expect(near.isSuspect).toBe(true);
      expect(near.suspectReason).toBe("crash-window");
      // 3min past heartbeat is well outside the 30s window.
      expect(far.isSuspect).toBe(false);
      expect(far.suspectReason).toBeUndefined();
    });

    it("preserves the timestamp of an existing crash log (does not override with killedAt)", () => {
      // The recorder path wrote a crash log with its own timestamp; the
      // marker-only fix must not touch that path. The watchdog annotation
      // (cause + watchdogKilledAt) still applies, but the entry's timestamp
      // is the recorder's.
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-recorder.json");
      const recorderTimestamp = T0 + 12 * 60_000;
      fs.writeFileSync(
        crashLogPath,
        JSON.stringify({
          id: "recorder",
          timestamp: recorderTimestamp,
          appVersion: "1.0.0",
          platform: "darwin",
          osVersion: "23.0",
          arch: "arm64",
          errorMessage: "uncaught exception",
        })
      );
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs: T0,
          appVersion: "1.0.0",
          platform: "darwin",
          lastHeartbeatMs: T0 + 10 * 60_000,
          crashLogPath,
        })
      );
      const killedAt = T0 + 14 * 60_000;
      const flagPath = path.join(userData, "watchdog-kill.flag");
      fs.writeFileSync(
        flagPath,
        JSON.stringify({ killedAt, missedBeats: 3, mainPid: 4242 }),
        "utf8"
      );
      fs.utimesSync(flagPath, new Date(killedAt), new Date(killedAt));

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(recorderTimestamp);
      expect(pending!.entry.errorMessage).toBe("uncaught exception");
      expect(pending!.entry.cause).toBe("watchdog-deadlock");
    });

    it("uses the snapshot capturedAt as backup mtime (not the disk mtime of the copied crashed-* file)", () => {
      // Windows/EPERM copy-fallback regression: when preserveBackupForRecovery
      // falls back to copy-then-unlink, the new crashed-* file's disk mtime
      // is the relaunch time. Reading capturedAt from the parsed snapshot
      // (in-memory, set by the backup write itself) preserves the pre-crash
      // mtime, so the priority chain picks the heartbeat-derived estimate
      // instead of the relaunch time.
      const heartbeat = T0 + 5 * 60_000;
      const capturedAt = T0 + 4 * 60_000; // snapshot's capturedAt (older than heartbeat)
      const backupPath = writeBackup([{ id: "t1", createdAt: T0 }]);
      // Simulate the snapshot's capturedAt being the pre-crash write time.
      const raw = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      raw.capturedAt = capturedAt;
      fs.writeFileSync(backupPath, JSON.stringify(raw));
      writeMarkerWithHeartbeat(heartbeat);

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      // capturedAt (T0+4m) wins over the heartbeat (T0+5m) per the
      // priority chain. Without the capturedAt fix, the on-disk mtime
      // (≈T0+DEAD_MS) would win and reproduce #10062.
      expect(pending!.entry.timestamp).toBe(capturedAt);
    });

    it("rejects Infinity in the watchdog killedAt payload", () => {
      // JSON.parse('{"killedAt":1e309}') returns Infinity, which passes
      // `typeof === "number" && > 0`. Without the Number.isFinite guard
      // the report would render "Crashed at: Infinity" and the dialog
      // would show "Invalid Date".
      const sessionStartMs = T0;
      const flagMtime = T0 + 5 * 60_000;
      writeMarkerWithHeartbeat(sessionStartMs);
      const flagPath = path.join(userData, "watchdog-kill.flag");
      fs.writeFileSync(
        flagPath,
        // eslint-disable-next-line no-loss-of-precision -- sentinel: forces Infinity, exercises 2f134fabf hardening
        JSON.stringify({ killedAt: 1e309, missedBeats: 3, mainPid: 4242 }),
        "utf8"
      );
      fs.utimesSync(flagPath, new Date(flagMtime), new Date(flagMtime));

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.cause).toBeUndefined();
      expect(pending!.entry.watchdogKilledAt).toBeUndefined();
      // The resolver should still surface a real crash time from the
      // heartbeat — Infinity must not poison the priority chain.
      expect(pending!.entry.timestamp).toBe(T0);
    });

    it("clamps an out-of-range suspendStart to the relaunch time (not the heartbeat)", () => {
      // The clamp is applied to every priority source, not just the
      // heartbeat. A future suspendStart (e.g. clock-skewed file) must
      // clamp to nowMs.
      const heartbeat = T0 + 5 * 60_000;
      const futureSuspend = T0 + DEAD_MS + 60_000;
      writeMarkerWithHeartbeat(heartbeat, { lastSuspendStart: futureSuspend });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.timestamp).toBe(T0 + DEAD_MS);
    });

    it("ignores a marker with a non-finite or non-positive sessionStartMs", () => {
      // isValidMarker was tightened to require finite positive sessionStartMs.
      // Infinity, -1, NaN, or 0 in sessionStartMs would let the resolver
      // clamp to zero / produce a negative sessionDurationMs.
      for (const bad of [Number.POSITIVE_INFINITY, -1, Number.NaN, 0]) {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: bad,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: T0 + 5 * 60_000,
          })
        );

        const svc = makeService();
        svc.initialize();

        // Corrupt marker is rejected — no pending crash, no entry built.
        expect(svc.getPendingCrash()).toBeNull();
      }
    });
  });
});
