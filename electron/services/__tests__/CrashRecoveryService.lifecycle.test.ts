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

const loggerMock = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/logger.js")>()),
  ...loggerMock,
}));

import { CrashRecoveryService } from "../CrashRecoveryService.js";
import {
  _resetCrashRecoveryInspectionForTests,
  getInspectedSessionStartMs,
  pruneCrashDumps,
} from "../../utils/crashDumpRetention.js";

function makeService(): CrashRecoveryService {
  return new CrashRecoveryService();
}

describe("CrashRecoveryService", () => {
  let tmpDir: string;
  let userData: string;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetCrashRecoveryInspectionForTests();
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

  describe("initialize", () => {
    it("writes marker on first launch with no existing marker", () => {
      const svc = makeService();
      svc.initialize();

      const markerPath = path.join(userData, "running.lock");
      expect(fs.existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      expect(typeof marker.sessionStartMs).toBe("number");
      expect(marker.appVersion).toBe("1.0.0");
      expect(marker.isPackaged).toBe(false);
    });

    it("returns null pending crash when no marker exists", () => {
      const svc = makeService();
      svc.initialize();
      expect(svc.getPendingCrash()).toBeNull();
    });

    it("requests owner-only writes and tightens the crashes directory", () => {
      const svc = makeService();
      svc.initialize();
      utilsMock.resilientAtomicWriteFileSync.mockClear();
      utilsMock.tightenDirPermissionsSync.mockClear();

      svc.recordCrash(new Error("boom"));

      const crashesDir = path.join(userData, "crashes");
      // The service asks the (separately unit-tested) helper to tighten the dir —
      // this is what fixes an upgrading install's pre-existing 0755 crashes dir.
      expect(utilsMock.tightenDirPermissionsSync).toHaveBeenCalledWith(crashesDir);

      // Every crash-recovery write requests 0o600 as its 4th argument. Asserting
      // the requested mode (not a mock-produced file mode) proves the real service
      // behavior; the helper's own suite proves the mode is honored on disk.
      const calls = utilsMock.resilientAtomicWriteFileSync.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[3]).toEqual({ mode: 0o600 });
      }
    });

    it("detects crash from orphaned marker on next launch", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.appVersion).toBe("1.0.0");
    });

    it("clearPendingCrash() zeroes the pending record so cold reboots see no crash (#10809)", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      const svc = makeService();
      svc.initialize();
      expect(svc.getPendingCrash()).not.toBeNull();

      svc.clearPendingCrash();
      expect(svc.getPendingCrash()).toBeNull();

      // Idempotent — a second call must not throw and stays null.
      svc.clearPendingCrash();
      expect(svc.getPendingCrash()).toBeNull();
    });

    it("ignores corrupted marker file", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(markerPath, "not-valid-json{{{{");

      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).toBeNull();
    });

    it("ignores marker with missing required fields", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(markerPath, JSON.stringify({ platform: "darwin" }));

      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).toBeNull();
    });

    it("silently discards orphaned dev-mode marker in dev session", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "win32",
          isPackaged: false,
        })
      );

      appMock.isPackaged = false;
      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).toBeNull();
    });

    it("marker-derived entry includes runtime metadata and panel data from backup", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: {
            terminals: [
              { id: "t1", kind: "terminal" },
              { id: "t2", kind: "terminal" },
            ],
          },
        })
      );

      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(typeof pending!.entry.nodeVersion).toBe("string");
      expect(typeof pending!.entry.totalMemory).toBe("number");
      expect(pending!.entry.panelCount).toBe(2);
      expect(pending!.entry.panelKinds).toEqual({ terminal: 2 });
    });

    it("surfaces dev-mode marker with crashLogPath as a genuine crash", () => {
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-dev-123.json");
      fs.writeFileSync(
        crashLogPath,
        JSON.stringify({
          id: "dev-123",
          timestamp: Date.now(),
          appVersion: "1.0.0",
          platform: "win32",
          osVersion: "10.0",
          arch: "x64",
          errorMessage: "real dev crash",
        })
      );

      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "win32",
          isPackaged: false,
          crashLogPath,
        })
      );

      appMock.isPackaged = false;
      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.entry.errorMessage).toBe("real dev crash");
    });

    it("surfaces dev-mode marker when current session is packaged", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "win32",
          isPackaged: false,
        })
      );

      appMock.isPackaged = true;
      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).not.toBeNull();
    });

    it("surfaces packaged marker in dev session", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
          isPackaged: true,
        })
      );

      appMock.isPackaged = false;
      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).not.toBeNull();
    });
  });

  describe("recordCrash", () => {
    it("writes crash log to crashes directory with environment metadata", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState")
          return {
            terminals: [
              { id: "t1", kind: "terminal" },
              { id: "t2", kind: "terminal" },
              { id: "t3", kind: "terminal" },
            ],
          };
        return { autoRestoreOnCrash: false };
      });

      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("Test error"));

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);

      const entry = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), "utf8"));
      expect(entry.errorMessage).toBe("Test error");
      expect(entry.appVersion).toBe("1.0.0");
      expect(typeof entry.nodeVersion).toBe("string");
      expect(typeof entry.totalMemory).toBe("number");
      expect(typeof entry.freeMemory).toBe("number");
      expect(typeof entry.heapUsed).toBe("number");
      expect(typeof entry.rss).toBe("number");
      expect(typeof entry.processUptime).toBe("number");
      expect(typeof entry.cpuCount).toBe("number");
      expect(entry.windowCount).toBe(1);
      expect(entry.gpuAccelerationDisabled).toBe(false);
      expect(entry.panelCount).toBe(3);
      expect(entry.panelKinds).toEqual({ terminal: 3 });
    });

    it("does not record crash twice (idempotent)", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("First"));
      svc.recordCrash(new Error("Second"));

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
    });

    it("still records version fields when memoryUsage throws", () => {
      const origMemUsage = process.memoryUsage;
      process.memoryUsage = (() => {
        throw new Error("OOM");
      }) as unknown as typeof process.memoryUsage;

      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("oom crash"));

      process.memoryUsage = origMemUsage;

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      const entry = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), "utf8"));
      expect(typeof entry.nodeVersion).toBe("string");
      expect(entry.heapUsed).toBeUndefined();
    });

    it("handles non-Error crash argument", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordCrash("string error");

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      const entry = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), "utf8"));
      expect(entry.errorMessage).toBe("string error");
    });

    it("includes recentActions in crash entry when the ring has entries", () => {
      const actions = [
        {
          id: "a1",
          actionId: "panel.focus",
          category: "panel",
          source: "user",
          durationMs: 2,
          timestamp: 1_700_000_000_000,
          count: 1,
        },
      ];
      getRecentActionsMock.mockReturnValueOnce(actions);

      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("boom"));

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      const entry = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), "utf8"));
      expect(entry.recentActions).toEqual(actions);
    });

    it("omits recentActions when the ring is empty", () => {
      getRecentActionsMock.mockReturnValueOnce([]);

      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("boom"));

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      const entry = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), "utf8"));
      expect(entry.recentActions).toBeUndefined();
    });

    it("still records crash when ActionBreadcrumbService throws", () => {
      getRecentActionsMock.mockImplementationOnce(() => {
        throw new Error("ring corrupted");
      });

      const svc = makeService();
      svc.initialize();
      expect(() => svc.recordCrash(new Error("boom"))).not.toThrow();

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
    });
  });

  describe("pruning", () => {
    it("retains at most 10 crash logs", () => {
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });

      for (let i = 0; i < 12; i++) {
        fs.writeFileSync(
          path.join(crashDir, `crash-${Date.now() + i}-abc${i}.json`),
          JSON.stringify({
            id: `abc${i}`,
            timestamp: Date.now() + i,
            appVersion: "1.0.0",
            platform: "darwin",
            osVersion: "22.0",
            arch: "x64",
          })
        );
      }

      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("pruning test"));

      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBeLessThanOrEqual(10);
    });
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

    it("deletes marker on exit after a renderer death the app survived (#12884)", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordRendererGone({ process: "project-view", reason: "killed", exitCode: 15 });

      svc.cleanupOnExit();

      expect(fs.existsSync(path.join(userData, "running.lock"))).toBe(false);
      const next = makeService();
      next.initialize();
      expect(next.getPendingCrash()).toBeNull();
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

    it("returns 'uncaught-exception' when marker has a legacy crashLogPath without a cause", () => {
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

    it("keeps 'native-crash' after retention deletes the dump it was classified from", async () => {
      const dumpsDir = path.join(userData, "crashpad-dumps");
      const pendingDir = path.join(dumpsDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });
      const dumpPath = path.join(pendingDir, "abc-xyz.dmp");
      fs.writeFileSync(dumpPath, "fake-minidump");
      const sessionStartMs = Date.now() - 60_000;
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
            platform: "linux",
            lastHeartbeatMs: Date.now() - 30_000,
          })
        );

        const constructedAfterMs = Date.now();
        const svc = makeService();
        expect(getInspectedSessionStartMs()).toBeNull();
        svc.initialize();
        // The gate opens with the running session's start, not the one just
        // classified.
        expect(getInspectedSessionStartMs()).toBeGreaterThanOrEqual(constructedAfterMs);

        // A zero budget with no grace window deletes even the fresh dump.
        const result = await pruneCrashDumps(dumpsDir, {
          policy: { maxAgeMs: 0, maxCount: 0, maxBytes: 0, activeWriteGraceMs: 0 },
          platform: "linux",
        });
        expect(result.deletedCount).toBe(1);
        expect(fs.existsSync(dumpPath)).toBe(false);

        const pending = svc.getPendingCrash()!;
        expect(pending.entry.crashCause).toBe("native-crash");
        const persisted = JSON.parse(fs.readFileSync(pending.logPath, "utf8"));
        expect(persisted.crashCause).toBe("native-crash");
      } finally {
        getPathMock.mockReturnValue(userData);
      }
    });

    it("recognizes a Windows reports/ dump as a native crash", () => {
      const dumpsDir = path.join(userData, "crashpad-dumps");
      const reportsDir = path.join(dumpsDir, "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      const dumpPath = path.join(reportsDir, "abc-xyz.dmp");
      fs.writeFileSync(dumpPath, "fake-minidump");
      const sessionStartMs = Date.now() - 60_000;
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
            platform: "win32",
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

  describe("stored crash cause", () => {
    it("keeps the cause the crash log recorded instead of inferring it (#12884)", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("boom"), "native-crash");

      const next = makeService();
      next.initialize();

      expect(next.getPendingCrash()!.entry.crashCause).toBe("native-crash");
    });

    it("falls back to classification when the stored cause is not a known value", () => {
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-bad.json");
      fs.writeFileSync(
        crashLogPath,
        JSON.stringify({ id: "bad", timestamp: Date.now(), crashCause: "gremlins" })
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

  describe("previous session evidence (#13527)", () => {
    const HOUR = 60 * 60 * 1000;
    const RELAUNCH = Date.UTC(2026, 9, 19, 12, 0, 0);
    const uncleanWarns = () =>
      loggerMock.logWarn.mock.calls.filter((c) => c[0] === "Previous session ended uncleanly");

    function writeMarker(fields: Record<string, unknown>): void {
      fs.writeFileSync(
        path.join(userData, "running.lock"),
        JSON.stringify({ appVersion: "0.9.0", platform: "darwin", ...fields })
      );
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(RELAUNCH);
      vi.spyOn(os, "uptime").mockReturnValue(24 * 60 * 60);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("dates a killed session by its last heartbeat, not by the relaunch hours later", () => {
      // The session died two hours before this launch; nothing ran in between.
      const heartbeat = RELAUNCH - 2 * HOUR;
      writeMarker({ sessionStartMs: heartbeat - 3 * HOUR, lastHeartbeatMs: heartbeat });

      const svc = makeService();
      svc.initialize();

      const entry = svc.getPendingCrash()!.entry;
      expect(entry.timestamp).toBe(heartbeat);
      expect(entry.timestampSource).toBe("heartbeat");
      expect(entry.lastHeartbeatMs).toBe(heartbeat);
      expect(entry.sessionDurationMs).toBe(3 * HOUR);

      const persisted = JSON.parse(
        fs.readFileSync(path.join(userData, "crashes", `crash-${entry.id}.json`), "utf-8")
      );
      expect(persisted).toMatchObject({ timestamp: heartbeat, timestampSource: "heartbeat" });
    });

    it("writes one durable line saying the previous session ended uncleanly", () => {
      const heartbeat = RELAUNCH - 2 * HOUR;
      writeMarker({ sessionStartMs: heartbeat - 3 * HOUR, lastHeartbeatMs: heartbeat });

      const svc = makeService();
      svc.initialize();

      const warns = uncleanWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0]![1]).toMatchObject({
        crashId: svc.getPendingCrash()!.entry.id,
        crashCause: "external-kill",
        endedAt: new Date(heartbeat).toISOString(),
        endedAtSource: "heartbeat",
        sessionStartedAt: new Date(heartbeat - 3 * HOUR).toISOString(),
        lastHeartbeatAt: new Date(heartbeat).toISOString(),
        sessionDurationMs: 3 * HOUR,
        downtimeMs: 2 * HOUR,
        appVersion: "0.9.0",
      });
    });

    it("says nothing about an unclean exit after a clean one", () => {
      const first = makeService();
      first.initialize();
      first.cleanupOnExit();
      expect(loggerMock.logInfo).toHaveBeenCalledWith("Clean exit, crash marker removed");

      vi.setSystemTime(RELAUNCH + HOUR);
      const next = makeService();
      next.initialize();

      expect(next.getPendingCrash()).toBeNull();
      expect(uncleanWarns()).toHaveLength(0);
    });

    it("marks a recorded crash as recorded and logs it on the synchronous level", () => {
      const first = makeService();
      first.initialize();
      first.recordCrash(new Error("boom"));
      expect(loggerMock.logError).toHaveBeenCalledWith(
        "Crash recorded",
        undefined,
        expect.objectContaining({ crashCause: "uncaught-exception" })
      );

      vi.setSystemTime(RELAUNCH + 2 * HOUR);
      const next = makeService();
      next.initialize();

      const entry = next.getPendingCrash()!.entry;
      expect(entry.timestamp).toBe(RELAUNCH);
      expect(entry.timestampSource).toBe("recorded");
      expect(uncleanWarns()[0]![1]).toMatchObject({
        endedAt: new Date(RELAUNCH).toISOString(),
        endedAtSource: "recorded",
        downtimeMs: 2 * HOUR,
      });
    });

    it("rebuilds an unreadable crash log from the marker instead of stamping the relaunch", () => {
      const crashDir = path.join(userData, "crashes");
      fs.mkdirSync(crashDir, { recursive: true });
      const crashLogPath = path.join(crashDir, "crash-torn.json");
      fs.writeFileSync(crashLogPath, '{"id": "torn", "timest');
      const heartbeat = RELAUNCH - HOUR;
      writeMarker({ sessionStartMs: heartbeat - HOUR, lastHeartbeatMs: heartbeat, crashLogPath });

      const svc = makeService();
      svc.initialize();

      const entry = svc.getPendingCrash()!.entry;
      expect(entry.timestamp).toBe(heartbeat);
      expect(entry.timestampSource).toBe("heartbeat");
      expect(entry.sessionDurationMs).toBe(HOUR);
    });

    it("falls back to the relaunch time, and says so, when the marker carries no evidence", () => {
      writeMarker({ sessionStartMs: RELAUNCH - HOUR });

      const svc = makeService();
      svc.initialize();

      const entry = svc.getPendingCrash()!.entry;
      expect(entry.timestamp).toBe(RELAUNCH);
      expect(entry.timestampSource).toBe("relaunch");
      expect(entry).not.toHaveProperty("lastHeartbeatMs");
      expect(uncleanWarns()[0]![1]).toMatchObject({
        endedAtSource: "relaunch",
        lastHeartbeatAt: undefined,
      });
    });

    it("still recovers when the logger throws", () => {
      loggerMock.logWarn.mockImplementationOnce(() => {
        throw new Error("logger down");
      });
      writeMarker({ sessionStartMs: RELAUNCH - 3 * HOUR, lastHeartbeatMs: RELAUNCH - HOUR });

      const svc = makeService();
      svc.initialize();

      expect(svc.getPendingCrash()).not.toBeNull();
      // The marker on disk is this session's, not the dead one.
      const marker = JSON.parse(fs.readFileSync(path.join(userData, "running.lock"), "utf8"));
      expect(marker.sessionStartMs).toBe(RELAUNCH);
    });
  });
});
