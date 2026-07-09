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

  describe("panel summaries", () => {
    it("populates panels from backup when crash is detected", () => {
      // Set up backup with terminals
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const terminals = [
        { id: "t1", kind: "terminal", title: "Shell", cwd: "/home", location: "grid" },
        { id: "t2", kind: "terminal", title: "Claude", location: "dock", worktreeId: "w1" },
      ];
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({ capturedAt: Date.now(), appState: { terminals } })
      );

      // Set up crash marker
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.panels).toBeDefined();
      expect(pending!.panels!.length).toBe(2);
      expect(pending!.panels![0]).toMatchObject({ id: "t1", kind: "terminal", title: "Shell" });
      expect(pending!.panels![1]).toMatchObject({ id: "t2", kind: "terminal", location: "dock" });
    });

    it("marks panels as suspect when created near crash time", () => {
      const crashTime = Date.now();
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const terminals = [
        {
          id: "t1",
          kind: "terminal",
          title: "Old",
          location: "grid",
          createdAt: crashTime - 120_000,
        },
        {
          id: "t2",
          kind: "terminal",
          title: "New",
          location: "grid",
          createdAt: crashTime - 5_000,
        },
      ];
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({ capturedAt: Date.now(), appState: { terminals } })
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

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending!.panels![0].isSuspect).toBe(false);
      expect(pending!.panels![0].suspectReason).toBeUndefined();
      expect(pending!.panels![1].isSuspect).toBe(true);
      expect(pending!.panels![1].suspectReason).toBe("crash-window");
    });

    it("pins the suspect window boundary against the crash entry timestamp", () => {
      const crashTime = Date.now();
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const terminals = [
        {
          id: "inside",
          kind: "terminal",
          title: "Inside",
          location: "grid",
          createdAt: crashTime - 29_000,
        },
        {
          id: "outside",
          kind: "terminal",
          title: "Outside",
          location: "grid",
          createdAt: crashTime - 31_000,
        },
      ];
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({ capturedAt: Date.now(), appState: { terminals } })
      );

      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: crashTime - 600_000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      const ref = pending!.entry.timestamp;
      const inside = pending!.panels!.find((p) => p.id === "inside")!;
      const outside = pending!.panels!.find((p) => p.id === "outside")!;
      // Reference must be the crash entry timestamp, not sessionStartMs (set 10m earlier).
      expect(Math.abs(ref - (crashTime - 29_000))).toBeLessThan(30_000);
      expect(Math.abs(ref - (crashTime - 31_000))).toBeGreaterThanOrEqual(30_000);
      expect(inside.isSuspect).toBe(true);
      expect(inside.suspectReason).toBe("crash-window");
      expect(outside.isSuspect).toBe(false);
      expect(outside.suspectReason).toBeUndefined();
    });

    it("includes agent state in panel summaries", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const terminals = [
        {
          id: "t1",
          kind: "terminal",
          title: "Shell",
          location: "grid",
        },
        {
          id: "t2",
          kind: "terminal",
          title: "Claude",
          location: "dock",
          agentState: "working",
          lastStateChange: 1700000000000,
        },
      ];
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({ capturedAt: Date.now(), appState: { terminals } })
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

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending!.panels![0].agentState).toBeUndefined();
      expect(pending!.panels![0].lastStateChange).toBeUndefined();
      expect(pending!.panels![1].agentState).toBe("working");
      expect(pending!.panels![1].lastStateChange).toBe(1700000000000);
    });

    it("returns undefined panels when no backup exists", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();

      const pending = svc.getPendingCrash();
      expect(pending).not.toBeNull();
      expect(pending!.panels).toBeUndefined();
    });
  });

  describe("panel filter", () => {
    it("setPanelFilter and consumePanelFilter work as one-shot", () => {
      const svc = makeService();
      expect(svc.consumePanelFilter()).toBeNull();

      svc.setPanelFilter(["t1", "t2"]);
      expect(svc.consumePanelFilter()).toEqual(["t1", "t2"]);
      expect(svc.consumePanelFilter()).toBeNull();
    });
  });

  describe("scheduleBackup", () => {
    it("debounces backup calls", () => {
      vi.useFakeTimers();
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 400, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();

      const spy = vi.spyOn(svc, "takeBackup");
      svc.scheduleBackup();
      svc.scheduleBackup();
      svc.scheduleBackup();

      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1500);
      expect(spy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("stopBackupTimer cancels pending debounce", () => {
      vi.useFakeTimers();
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();

      const spy = vi.spyOn(svc, "takeBackup");
      svc.scheduleBackup();
      svc.stopBackupTimer();

      vi.advanceTimersByTime(2000);
      expect(spy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("config", () => {
    it("returns normalized config", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: true });
      const svc = makeService();
      expect(svc.getConfig()).toEqual({ autoRestoreOnCrash: true });
    });

    it("defaults to true for invalid stored value", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: "yes" });
      const svc = makeService();
      expect(svc.getConfig().autoRestoreOnCrash).toBe(true);
    });

    it("defaults to true when stored value is undefined", () => {
      storeMock.get.mockReturnValue(undefined);
      const svc = makeService();
      expect(svc.getConfig().autoRestoreOnCrash).toBe(true);
    });

    it("setConfig persists to store", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      const result = svc.setConfig({ autoRestoreOnCrash: true });

      expect(result.autoRestoreOnCrash).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("crashRecovery", { autoRestoreOnCrash: true });
    });

    it("setConfig ignores non-boolean autoRestoreOnCrash so an opt-out survives a malformed patch", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      const result = svc.setConfig({
        autoRestoreOnCrash: undefined as unknown as boolean,
      });

      expect(result.autoRestoreOnCrash).toBe(false);
      expect(storeMock.set).toHaveBeenCalledWith("crashRecovery", { autoRestoreOnCrash: false });
    });

    it("getConfig memoizes the store read so repeated calls don't re-parse config.json", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();

      expect(svc.getConfig()).toEqual({ autoRestoreOnCrash: false });
      expect(svc.getConfig()).toEqual({ autoRestoreOnCrash: false });

      expect(storeMock.get.mock.calls.filter(([key]) => key === "crashRecovery")).toHaveLength(1);
    });

    it("setConfig refreshes the memo so the settings tab round-trips the new value", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      expect(svc.getConfig().autoRestoreOnCrash).toBe(false);

      svc.setConfig({ autoRestoreOnCrash: true });

      // Even if the store mock still serves the stale value, the memo must
      // reflect the write — otherwise a cached false would shadow the toggle.
      expect(svc.getConfig().autoRestoreOnCrash).toBe(true);
    });
  });

  describe("getLastBackupTimestamp", () => {
    it("returns null when no backup file exists", () => {
      const svc = makeService();
      svc.initialize();
      expect(svc.getLastBackupTimestamp()).toBeNull();
    });

    it("returns mtimeMs when backup file exists", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, "session-state.json");
      fs.writeFileSync(backupPath, JSON.stringify({ capturedAt: Date.now(), appState: {} }));

      const svc = makeService();
      svc.initialize();

      const ts = svc.getLastBackupTimestamp();
      const stat = fs.statSync(backupPath);
      expect(ts).toBe(stat.mtimeMs);
    });
  });

  describe("getBackupPanelCount", () => {
    it("returns null when no backup snapshot is cached", () => {
      const svc = makeService();
      svc.initialize();
      expect(svc.getBackupPanelCount()).toBeNull();
    });

    it("returns terminal count from cached snapshot after crash detection", () => {
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
              { id: "t3", kind: "browser" },
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

      expect(svc.getBackupPanelCount()).toBe(3);
    });

    it("returns zero when cached snapshot has an empty terminals array", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: { terminals: [] },
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

      expect(svc.getBackupPanelCount()).toBe(0);
    });

    it("returns null when cached snapshot has no appState", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({ capturedAt: Date.now() })
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

      expect(svc.getBackupPanelCount()).toBeNull();
    });

    it("returns null when backup file exists on disk but no crash marker is present", () => {
      // Defends the cache-only contract: a stale disk backup must never bleed
      // into the panel count on a fresh boot. cachedBackupSnapshot is only
      // populated by consumeMarker(), which requires a marker file.
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: { terminals: [{ id: "t1", kind: "terminal" }] },
        })
      );

      const svc = makeService();
      svc.initialize();

      expect(svc.getBackupPanelCount()).toBeNull();
    });

    it("returns null when terminals is not an array", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: { terminals: "not an array" },
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

      expect(svc.getBackupPanelCount()).toBeNull();
    });

    it("falls back to disk when allowDiskFallback is true and no crash marker is present", () => {
      // Renderer-crash mid-session: no marker was ever consumed, so the
      // cache is empty. The default-arg call must still return null
      // (the line-1346 contract), but opting in to the disk fallback must
      // surface the live session's terminal count.
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });

      const svc = makeService();
      svc.initialize();

      // capturedAt must be >= sessionStartMs (the freshness gate at
      // line 131 of CrashRecoveryService.ts) — write the snapshot AFTER
      // initialize() so the timestamp is deterministically fresh.
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: {
            terminals: [
              { id: "t1", kind: "terminal" },
              { id: "t2", kind: "terminal" },
              { id: "t3", kind: "browser" },
              { id: "t4", kind: "terminal" },
            ],
          },
        })
      );

      expect(svc.getBackupPanelCount()).toBeNull();
      expect(svc.getBackupPanelCount(true)).toBe(4);
    });

    it("returns cached count even when allowDiskFallback is true (cache wins over disk)", () => {
      // consumeMarker() reads the disk backup into cachedBackupSnapshot.
      // After that, the disk file is rotated/overwritten by the live backup
      // tick. The cache must continue to drive getBackupPanelCount(true)
      // so the main-crash dialog keeps showing the pre-crash panel count
      // (mirrors the "snapshot at the moment we learned about the crash"
      // contract on consumeMarker).
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const preCrash = {
        capturedAt: Date.now() - 60_000,
        appState: {
          terminals: [
            { id: "t1", kind: "terminal" },
            { id: "t2", kind: "terminal" },
            { id: "t3", kind: "terminal" },
          ],
        },
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(preCrash));

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

      // Overwrite the disk file with a divergent post-recovery snapshot.
      // The cache must NOT be replaced; the fallback must not perturb it.
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: {
            terminals: [
              { id: "n1", kind: "terminal" },
              { id: "n2", kind: "terminal" },
              { id: "n3", kind: "terminal" },
              { id: "n4", kind: "terminal" },
              { id: "n5", kind: "browser" },
              { id: "n6", kind: "terminal" },
              { id: "n7", kind: "terminal" },
            ],
          },
        })
      );

      expect(svc.getBackupPanelCount(true)).toBe(3);
    });

    it("returns null on malformed disk snapshot when fallback is allowed", () => {
      // readBackupFile + Array.isArray already defend the wiring. This test
      // pins that the fallback returns null (not garbage, not a throw) when
      // the disk snapshot has a non-array `terminals` field.
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: Date.now(),
          appState: { terminals: "not an array" },
        })
      );

      const svc = makeService();
      svc.initialize();

      expect(svc.getBackupPanelCount(true)).toBeNull();
    });

    it("returns null when on-disk snapshot is from a prior session (freshness gate)", () => {
      // The freshness gate prevents a previous session's snapshot from
      // surfacing on a fresh boot that happens to crash the renderer
      // immediately. Mirrors the watchdog freshness pattern at
      // consumeWatchdogKillFlag (line 637).
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const svc = makeService();
      const sessionStart = Date.now();
      // Service constructor already called Date.now() once for sessionStartMs;
      // make the snapshot strictly older.
      fs.writeFileSync(
        path.join(backupDir, "session-state.json"),
        JSON.stringify({
          capturedAt: sessionStart - 5_000,
          appState: {
            terminals: [{ id: "t1", kind: "terminal" }],
          },
        })
      );
      svc.initialize();

      expect(svc.getBackupPanelCount(true)).toBeNull();
    });
  });
});
