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

  describe("resetToFresh", () => {
    it("resets appState to clean workspace defaults", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      svc.initialize();
      storeMock.set.mockClear();
      svc.resetToFresh();

      expect(storeMock.set).toHaveBeenCalledWith(
        "appState",
        expect.objectContaining({
          focusMode: false,
          terminals: [],
          hasSeenWelcome: true,
        })
      );
    });

    it("only writes appState — does not touch projects or other store keys", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      svc.initialize();
      storeMock.set.mockClear();
      svc.resetToFresh();

      expect(storeMock.set).toHaveBeenCalledTimes(1);
      expect(storeMock.set.mock.calls[0][0]).toBe("appState");
    });

    it("removes the renamed crashed-backup file so restoreBackup has no source", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: { sidebarWidth: 999, terminals: [] },
        })
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      svc.initialize();

      // After initialize the live backup has been renamed to
      // session-state.crashed-*.json. resetToFresh must unlink it so the
      // user can't restore stale state by accident after explicitly
      // choosing a fresh start.
      storeMock.set.mockClear();
      svc.resetToFresh();

      expect(svc.restoreBackup()).toBe(false);
      const remaining = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("session-state.crashed-"));
      expect(remaining).toEqual([]);
    });
  });

  describe("cleanupOnExit", () => {
    it("deletes marker on clean exit", () => {
      const svc = makeService();
      svc.initialize();

      const markerPath = path.join(userData, "running.lock");
      expect(fs.existsSync(markerPath)).toBe(true);

      svc.cleanupOnExit();
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it("does not delete marker if crash was recorded", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("crash"));

      svc.cleanupOnExit();

      const markerPath = path.join(userData, "running.lock");
      // After crash, marker has been updated with crash info — it should still exist
      // (crash marker is not a lock file after a crash — it persists for next launch detection)
      // Actually in our impl, recordCrash writes a new lock with crash info, so it still exists
      // cleanupOnExit skips deletion when crashRecorded=true
      expect(fs.existsSync(markerPath)).toBe(true);
    });

    it("unlinks crashed-backup file on cleanupOnExit even when crashRecorded skips marker cleanup", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: { sidebarWidth: 999, terminals: [] },
        })
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      svc.initialize();

      svc.recordCrash(new Error("test crash"));
      svc.cleanupOnExit();

      // The crashed-* file is unlinked regardless of crashRecorded so a
      // re-run during the dying process doesn't restore stale state. The
      // crashed-* file is owned by this service instance only.
      expect(svc.restoreBackup()).toBe(false);
    });
  });

  describe("atomic write routing", () => {
    it("routes initialize() marker write through resilientAtomicWriteFileSync", () => {
      const svc = makeService();
      svc.initialize();

      const markerPath = path.join(userData, "running.lock");
      expect(utilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
        markerPath,
        expect.any(String),
        "utf-8",
        { mode: 0o600 }
      );
    });

    it("routes recordCrash() log and marker rewrite through resilientAtomicWriteFileSync", () => {
      const svc = makeService();
      svc.initialize();
      utilsMock.resilientAtomicWriteFileSync.mockClear();

      svc.recordCrash(new Error("boom"));

      const markerPath = path.join(userData, "running.lock");
      const calls = utilsMock.resilientAtomicWriteFileSync.mock.calls;
      const crashLogCalls = calls.filter(([fp]) =>
        String(fp).startsWith(path.join(userData, "crashes", "crash-"))
      );
      const markerCalls = calls.filter(([fp]) => fp === markerPath);

      expect(crashLogCalls).toHaveLength(1);
      expect(markerCalls).toHaveLength(1);
      expect(crashLogCalls[0][2]).toBe("utf-8");
      expect(markerCalls[0][2]).toBe("utf-8");
      // Both writes must request owner-only permissions.
      expect(crashLogCalls[0][3]).toEqual({ mode: 0o600 });
      expect(markerCalls[0][3]).toEqual({ mode: 0o600 });
    });

    it("routes takeBackup() through resilientAtomicWriteFileSync", () => {
      const svc = makeService();
      svc.initialize();
      utilsMock.resilientAtomicWriteFileSync.mockClear();

      svc.takeBackup();

      const backupPath = path.join(userData, "backups", "session-state.json");
      expect(utilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
        backupPath,
        expect.any(String),
        "utf-8",
        { mode: 0o600 }
      );
    });

    it("routes consumeMarker backup rename through resilientRenameSync", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({ capturedAt: Date.now(), appState: { terminals: [] } })
      );
      const markerSessionStart = Date.now() - 5000;
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs: markerSessionStart,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      const svc = makeService();
      svc.initialize();

      const expectedDest = path.join(backupDir, `session-state.crashed-${markerSessionStart}.json`);
      expect(utilsMock.resilientRenameSync).toHaveBeenCalledWith(
        path.join(backupDir, "session-state.json"),
        expectedDest
      );
      expect(fs.existsSync(expectedDest)).toBe(true);
      expect(fs.existsSync(path.join(backupDir, "session-state.json"))).toBe(false);
    });
  });

  describe("crash cause classification", () => {
    function osUptimeSpy(returnValue: number): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(os, "uptime").mockReturnValue(returnValue);
    }

    it("returns 'uncaught-exception' when marker has crashLogPath", () => {
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-abc.json");
      fs.writeFileSync(
        crashLogPath,
        JSON.stringify({
          id: "abc",
          timestamp: Date.now(),
          appVersion: "1.0.0",
          platform: "darwin",
          osVersion: "22.0",
          arch: "x64",
        })
      );

      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({
          sessionStartMs: Date.now() - 5_000,
          appVersion: "1.0.0",
          platform: "darwin",
          crashLogPath,
        })
      );

      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()!.entry.crashCause).toBe("uncaught-exception");
    });

    it("returns 'suspended-then-lost' when marker has lastSuspendStart", () => {
      const uptime = osUptimeSpy(10_000);
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 5_000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastSuspendStart: Date.now() - 4_000,
            lastHeartbeatMs: Date.now() - 4_500,
          })
        );

        const svc = makeService();
        svc.initialize();

        expect(svc.getPendingCrash()!.entry.crashCause).toBe("suspended-then-lost");
      } finally {
        uptime.mockRestore();
      }
    });

    it("returns 'power-loss' when os.uptime is shorter than elapsed wall time", () => {
      // sessionStart = 5min ago, but uptime is only 10 seconds — definitive reboot
      const uptime = osUptimeSpy(10);
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 5 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 60_000,
          })
        );

        const svc = makeService();
        svc.initialize();

        expect(svc.getPendingCrash()!.entry.crashCause).toBe("power-loss");
      } finally {
        uptime.mockRestore();
      }
    });

    it("returns 'external-kill' when heartbeat stale but system did not reboot", () => {
      // uptime far exceeds elapsed wall time → no reboot. Heartbeat is 5min
      // stale → external kill (SIGKILL, OOM killer, force-quit).
      const uptime = osUptimeSpy(24 * 60 * 60);
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 10 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 5 * 60 * 1000,
          })
        );

        const svc = makeService();
        svc.initialize();

        expect(svc.getPendingCrash()!.entry.crashCause).toBe("external-kill");
      } finally {
        uptime.mockRestore();
      }
    });

    it("returns 'unknown' when no attribution signal fires", () => {
      const uptime = osUptimeSpy(24 * 60 * 60);
      try {
        const now = Date.now();
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: now - 10_000,
            appVersion: "1.0.0",
            platform: "darwin",
            // Fresh heartbeat → not stale. No suspend stamp. uptime >> elapsed.
            lastHeartbeatMs: now - 5_000,
          })
        );

        const svc = makeService();
        svc.initialize();

        expect(svc.getPendingCrash()!.entry.crashCause).toBe("unknown");
      } finally {
        uptime.mockRestore();
      }
    });

    it("returns 'native-crash' when a Crashpad .dmp newer than sessionStart exists", () => {
      const dumpsDir = path.join(userData, "crashpad-dumps");
      const completedDir = path.join(dumpsDir, "completed");
      fs.mkdirSync(completedDir, { recursive: true });
      const dumpPath = path.join(completedDir, "abc-xyz.dmp");
      fs.writeFileSync(dumpPath, "fake-minidump");
      const sessionStartMs = Date.now() - 60_000;
      // Backdate the dump's mtime so it's between sessionStart and now.
      const dumpMtime = new Date(sessionStartMs + 5_000);
      fs.utimesSync(dumpPath, dumpMtime, dumpMtime);

      const getPathMock = appMock.getPath as ReturnType<typeof vi.fn>;
      getPathMock.mockImplementation((key: string) => {
        if (key === "crashDumps") return dumpsDir;
        return userData;
      });

      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 30_000,
          })
        );

        const svc = makeService();
        svc.initialize();

        expect(svc.getPendingCrash()!.entry.crashCause).toBe("native-crash");
      } finally {
        getPathMock.mockReturnValue(userData);
      }
    });
  });

  describe("marker-only persistence", () => {
    function osUptimeSpy(returnValue: number): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(os, "uptime").mockReturnValue(returnValue);
    }

    it("writes crash-{id}.json to crashesDir when marker has no crashLogPath (external-kill)", () => {
      const uptime = osUptimeSpy(24 * 60 * 60);
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 10 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 5 * 60 * 1000,
          })
        );

        const svc = makeService();
        svc.initialize();

        const pending = svc.getPendingCrash();
        expect(pending).not.toBeNull();
        expect(pending!.entry.crashCause).toBe("external-kill");

        // The on-disk log file is now real and lives under userData/crashes/.
        const crashesDir = path.join(userData, "crashes");
        const logFile = path.join(crashesDir, `crash-${pending!.entry.id}.json`);
        expect(fs.existsSync(logFile)).toBe(true);
        expect(pending!.logPath).toBe(logFile);

        // Round-trip the JSON and verify the cause survives.
        const persisted = JSON.parse(fs.readFileSync(logFile, "utf-8"));
        expect(persisted.id).toBe(pending!.entry.id);
        expect(persisted.crashCause).toBe("external-kill");
      } finally {
        uptime.mockRestore();
      }
    });

    it("PendingCrash.logPath points at the persisted file for power-loss (marker-only)", () => {
      const uptime = osUptimeSpy(10);
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 5 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 60_000,
          })
        );

        const svc = makeService();
        svc.initialize();

        const pending = svc.getPendingCrash();
        expect(pending!.entry.crashCause).toBe("power-loss");
        expect(fs.existsSync(pending!.logPath)).toBe(true);
      } finally {
        uptime.mockRestore();
      }
    });

    it("writes the synthesized log before deleteMarker (preserve-before-delete per #8728)", () => {
      const uptime = osUptimeSpy(24 * 60 * 60);
      // Track the order in which the marker is unlinked and the synthesized
      // crash log is written. The marker must still be present at the moment
      // writeCrashLog fires — a kill in the gap would otherwise leave the
      // next launch with a real log file but no marker to consume it.
      const events: string[] = [];
      const realUnlink = fs.unlinkSync;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
        if (String(target).endsWith("running.lock")) events.push("unlink-marker");
        return realUnlink(target);
      }) as typeof fs.unlinkSync);
      utilsMock.resilientAtomicWriteFileSync.mockImplementation((fp, data, enc) => {
        if (fp.includes("crash-") && !fp.includes("session-state")) events.push("write-crash-log");
        fs.writeFileSync(fp, data, enc ?? "utf-8");
      });
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 10 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 5 * 60 * 1000,
          })
        );

        const svc = makeService();
        svc.initialize();

        // The crash log was written first; the marker was unlinked afterwards.
        const writeIdx = events.indexOf("write-crash-log");
        const unlinkIdx = events.indexOf("unlink-marker");
        expect(writeIdx).toBeGreaterThanOrEqual(0);
        expect(unlinkIdx).toBeGreaterThan(writeIdx);
      } finally {
        unlinkSpy.mockRestore();
        uptime.mockRestore();
      }
    });

    it("falls back to the synthetic path without throwing when writeCrashLog fails", () => {
      const uptime = osUptimeSpy(24 * 60 * 60);
      // Force the atomic write to throw — the dialog's defensive openPath
      // handler covers the missing-file case, but the path field must stay
      // stable so the renderer never sees `undefined`.
      utilsMock.resilientAtomicWriteFileSync.mockImplementationOnce(() => {
        throw new Error("ENOSPC: disk full");
      });
      try {
        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 10 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 5 * 60 * 1000,
          })
        );

        const svc = makeService();
        svc.initialize();

        const pending = svc.getPendingCrash();
        expect(pending).not.toBeNull();
        expect(pending!.entry.crashCause).toBe("external-kill");
        // Falls back to the synthetic path so the renderer always gets a string.
        expect(pending!.logPath).toBe(
          path.join(userData, "crashes", `crash-${pending!.entry.id}.json`)
        );
      } finally {
        uptime.mockRestore();
      }
    });

    it("prunes old crash logs after writing a synthesized marker-only log", () => {
      const uptime = osUptimeSpy(24 * 60 * 60);
      try {
        // Seed 12 pre-existing crash-{id}.json files to exceed MAX_CRASH_LOGS=10.
        const crashesDir = path.join(userData, "crashes");
        fs.mkdirSync(crashesDir, { recursive: true });
        for (let i = 0; i < 12; i++) {
          fs.writeFileSync(
            path.join(crashesDir, `crash-seed-${i}.json`),
            JSON.stringify({ id: `seed-${i}`, timestamp: Date.now() - (12 - i) * 1000 })
          );
        }

        fs.writeFileSync(
          path.join(userData, "running.lock"),
          JSON.stringify({
            sessionStartMs: Date.now() - 10 * 60 * 1000,
            appVersion: "1.0.0",
            platform: "darwin",
            lastHeartbeatMs: Date.now() - 5 * 60 * 1000,
          })
        );

        const svc = makeService();
        svc.initialize();

        const remaining = fs.readdirSync(crashesDir).filter((f) => f.startsWith("crash-"));
        // 12 seeded + 1 synthesized = 13 → pruned down to MAX_CRASH_LOGS=10.
        expect(remaining.length).toBeLessThanOrEqual(10);
      } finally {
        uptime.mockRestore();
      }
    });
  });

  describe("recordCrash crashCause default", () => {
    it("persists crashCause: 'uncaught-exception' on the entry", () => {
      const svc = makeService();
      svc.recordCrash(new Error("boom"));

      const crashesDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashesDir).filter((f) => f.startsWith("crash-"));
      expect(files.length).toBe(1);
      const persisted = JSON.parse(fs.readFileSync(path.join(crashesDir, files[0]!), "utf-8"));
      expect(persisted.crashCause).toBe("uncaught-exception");
      expect(persisted.errorMessage).toBe("boom");
    });
  });

  describe("heartbeat and suspend stamping", () => {
    it("writes lastHeartbeatMs on initialize", () => {
      const before = Date.now();
      const svc = makeService();
      svc.initialize();
      const after = Date.now();

      const marker = JSON.parse(fs.readFileSync(path.join(userData, "running.lock"), "utf8"));
      expect(typeof marker.lastHeartbeatMs).toBe("number");
      expect(marker.lastHeartbeatMs).toBeGreaterThanOrEqual(before);
      expect(marker.lastHeartbeatMs).toBeLessThanOrEqual(after);
    });

    it("refreshes lastHeartbeatMs on each backup-timer tick", () => {
      vi.useFakeTimers();
      try {
        const svc = makeService();
        svc.initialize();
        svc.startBackupTimer();

        const firstMarker = JSON.parse(
          fs.readFileSync(path.join(userData, "running.lock"), "utf8")
        );
        const firstHeartbeat = firstMarker.lastHeartbeatMs;

        vi.advanceTimersByTime(60_000);

        const secondMarker = JSON.parse(
          fs.readFileSync(path.join(userData, "running.lock"), "utf8")
        );
        expect(secondMarker.lastHeartbeatMs).toBeGreaterThan(firstHeartbeat);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
