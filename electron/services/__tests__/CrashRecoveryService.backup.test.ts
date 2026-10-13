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

  describe("backup / restore", () => {
    it("restoreBackup applies snapshot to store", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const windowStates = {
        "/home/user/project-a": { width: 1400, height: 900, isMaximized: false },
      };
      const snapshot = {
        capturedAt: Date.now(),
        appState: { sidebarWidth: 999, terminals: [] },
        windowStates,
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      const result = svc.restoreBackup();

      expect(result).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("appState", snapshot.appState);
      expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", windowStates);
    });

    it("restoreBackup filters terminals when panelIds is provided", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const snapshot = {
        capturedAt: Date.now(),
        appState: {
          sidebarWidth: 999,
          terminals: [
            { id: "t1", kind: "terminal", title: "T1" },
            { id: "t2", kind: "terminal", title: "T2" },
            { id: "t3", kind: "browser", title: "T3" },
          ],
        },
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      const result = svc.restoreBackup(["t1", "t3"]);

      expect(result).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith(
        "appState",
        expect.objectContaining({
          terminals: [
            { id: "t1", kind: "terminal", title: "T1" },
            { id: "t3", kind: "browser", title: "T3" },
          ],
        })
      );
    });

    it("restoreBackup never writes to projects store", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const snapshot = {
        capturedAt: Date.now(),
        appState: { sidebarWidth: 999, terminals: [] },
        projects: { list: [{ id: "p1", name: "Old" }], currentProjectId: "p1" },
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      storeMock.set.mockClear();
      svc.restoreBackup();

      const setKeys = storeMock.set.mock.calls.map((c: unknown[]) => c[0]);
      expect(setKeys).not.toContain("projects");
    });

    it("returns false when no backup exists", () => {
      const svc = makeService();
      svc.initialize();
      expect(svc.restoreBackup()).toBe(false);
    });

    it("snapshot does not capture projects from store", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 400, terminals: [] };
        if (key === "projects") return { list: [{ id: "p1" }], currentProjectId: "p1" };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      const backupPath = path.join(userData, "backups", "session-state.json");
      const snapshot = JSON.parse(fs.readFileSync(backupPath, "utf8"));
      expect(snapshot.projects).toBeUndefined();
    });

    it("restoreBackup returns false and applies no state for legacy-only snapshot", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const snapshot = {
        capturedAt: Date.now(),
        projects: { list: [{ id: "p1", name: "Old" }], currentProjectId: "p1" },
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      storeMock.set.mockClear();
      const result = svc.restoreBackup();

      expect(result).toBe(false);
      expect(storeMock.set).not.toHaveBeenCalled();
    });
  });

  describe("backup rotation (rolling pair)", () => {
    it("rotates current → previous before writing new current", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const currentPath = path.join(backupDir, "session-state.json");
      const previousPath = path.join(backupDir, "session-state.previous.json");
      const firstSnapshot = {
        capturedAt: 1_000,
        appState: { sidebarWidth: 100, terminals: [{ id: "t1", kind: "terminal" }] },
      };
      fs.writeFileSync(currentPath, JSON.stringify(firstSnapshot));

      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 200, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      // After rotation, previous contains the original snapshot and current
      // contains the freshly written one.
      expect(fs.existsSync(previousPath)).toBe(true);
      const rotated = JSON.parse(fs.readFileSync(previousPath, "utf8"));
      expect(rotated.capturedAt).toBe(1_000);
      const fresh = JSON.parse(fs.readFileSync(currentPath, "utf8"));
      expect(fresh.appState.sidebarWidth).toBe(200);
    });

    it("tightens the rotated previous backup (rename carries the source mode)", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const currentPath = path.join(backupDir, "session-state.json");
      const previousPath = path.join(backupDir, "session-state.previous.json");
      fs.writeFileSync(currentPath, JSON.stringify({ capturedAt: 1_000, appState: {} }));

      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 200, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      utilsMock.tightenFilePermissionsSync.mockClear();
      svc.takeBackup();

      // rename preserves the source mode, so a pre-fix 0644 current would land as
      // `previous` world-readable — the service must tighten it explicitly.
      expect(utilsMock.tightenFilePermissionsSync).toHaveBeenCalledWith(previousPath);
    });

    it("tightens the crashed backup preserved on consumeMarker", () => {
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

      const crashedPath = path.join(backupDir, `session-state.crashed-${markerSessionStart}.json`);
      expect(utilsMock.tightenFilePermissionsSync).toHaveBeenCalledWith(crashedPath);
    });

    it("does not rotate when no current backup exists yet", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 100, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      const previousPath = path.join(userData, "backups", "session-state.previous.json");
      expect(fs.existsSync(previousPath)).toBe(false);
      // resilientRenameSync must not have been called when there is no source file.
      expect(utilsMock.resilientRenameSync).not.toHaveBeenCalled();
    });

    it("still writes new current when rotation rename throws (best-effort)", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const currentPath = path.join(backupDir, "session-state.json");
      fs.writeFileSync(
        currentPath,
        JSON.stringify({ capturedAt: 1_000, appState: { terminals: [] } })
      );

      utilsMock.resilientRenameSync.mockImplementationOnce(() => {
        throw new Error("EPERM: rename failed");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 999, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      // Rotation failed but the new current was written anyway.
      const fresh = JSON.parse(fs.readFileSync(currentPath, "utf8"));
      expect(fresh.appState.sidebarWidth).toBe(999);
      expect(warnSpy).toHaveBeenCalledWith(
        "[CrashRecovery] Backup rotation rename failed:",
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });

    it("restoreBackup falls back to previous when current is missing", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const previousSnapshot = {
        capturedAt: Date.now() - 60_000,
        appState: { sidebarWidth: 777, terminals: [{ id: "t-prev", kind: "terminal" }] },
      };
      fs.writeFileSync(
        path.join(backupDir, "session-state.previous.json"),
        JSON.stringify(previousSnapshot)
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      const result = svc.restoreBackup();

      expect(result).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("appState", previousSnapshot.appState);
    });

    it("restoreBackup falls back to previous when current is corrupt", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, "session-state.json"), "{ this is not json");
      const previousSnapshot = {
        capturedAt: Date.now() - 60_000,
        appState: { sidebarWidth: 555, terminals: [] },
      };
      fs.writeFileSync(
        path.join(backupDir, "session-state.previous.json"),
        JSON.stringify(previousSnapshot)
      );

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      const result = svc.restoreBackup();

      expect(result).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("appState", previousSnapshot.appState);
    });

    it("restoreBackup returns false when both current and previous are corrupt", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, "session-state.json"), "not json");
      fs.writeFileSync(path.join(backupDir, "session-state.previous.json"), "also not json");

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      storeMock.set.mockClear();
      const result = svc.restoreBackup();

      expect(result).toBe(false);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("readBackupInfo (via getLastBackupTimestamp) falls back to previous when current is missing", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const previousPath = path.join(backupDir, "session-state.previous.json");
      fs.writeFileSync(
        previousPath,
        JSON.stringify({ capturedAt: Date.now(), appState: { terminals: [] } })
      );

      const svc = makeService();
      svc.initialize();

      const ts = svc.getLastBackupTimestamp();
      const stat = fs.statSync(previousPath);
      expect(ts).toBe(stat.mtimeMs);
    });

    it("readBackupInfo skips corrupt current and reports previous timestamp", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      // Corrupt current — exists on disk but unparseable.
      const currentPath = path.join(backupDir, "session-state.json");
      fs.writeFileSync(currentPath, "{ corrupt");
      // Valid previous.
      const previousPath = path.join(backupDir, "session-state.previous.json");
      fs.writeFileSync(
        previousPath,
        JSON.stringify({ capturedAt: Date.now() - 30_000, appState: { terminals: [] } })
      );

      const svc = makeService();
      svc.initialize();

      // Without the parseability gate, getLastBackupTimestamp would return the
      // corrupt current's mtimeMs and mislead the UI into showing a backup
      // exists at a timestamp it can't actually restore from.
      const ts = svc.getLastBackupTimestamp();
      const previousStat = fs.statSync(previousPath);
      expect(ts).toBe(previousStat.mtimeMs);
    });

    it("a scheduled backup of unchanged state does not rotate the previous generation away", () => {
      vi.useFakeTimers();
      try {
        const backupDir = path.join(userData, "backups");
        const currentPath = path.join(backupDir, "session-state.json");
        const previousPath = path.join(backupDir, "session-state.previous.json");
        let width = 1;
        storeMock.get.mockImplementation((key: string) => {
          if (key === "appState") return { sidebarWidth: width, terminals: [] };
          return { autoRestoreOnCrash: false };
        });
        windowStatesStoreMock.get.mockReturnValue({});

        const svc = makeService();
        svc.initialize();
        svc.takeBackup();
        width = 2;
        svc.scheduleBackup();
        vi.advanceTimersByTime(1500);
        expect(JSON.parse(fs.readFileSync(currentPath, "utf8")).appState.sidebarWidth).toBe(2);
        expect(JSON.parse(fs.readFileSync(previousPath, "utf8")).appState.sidebarWidth).toBe(1);

        const writes = utilsMock.resilientAtomicWriteFileSync.mock.calls.length;
        svc.scheduleBackup();
        vi.advanceTimersByTime(1500);
        expect(utilsMock.resilientAtomicWriteFileSync.mock.calls.length).toBe(writes);
        expect(JSON.parse(fs.readFileSync(previousPath, "utf8")).appState.sidebarWidth).toBe(1);

        width = 3;
        svc.scheduleBackup();
        vi.advanceTimersByTime(1500);
        expect(JSON.parse(fs.readFileSync(currentPath, "utf8")).appState.sidebarWidth).toBe(3);
        expect(JSON.parse(fs.readFileSync(previousPath, "utf8")).appState.sidebarWidth).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rewrites unchanged state when the current backup has gone missing", () => {
      const currentPath = path.join(userData, "backups", "session-state.json");
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 1, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();
      fs.unlinkSync(currentPath);
      svc.takeBackup();
      expect(JSON.parse(fs.readFileSync(currentPath, "utf8")).appState.sidebarWidth).toBe(1);
    });

    it("rewrites unchanged state when the current backup was corrupted on disk", () => {
      const currentPath = path.join(userData, "backups", "session-state.json");
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 1, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();
      fs.writeFileSync(currentPath, "{trunc");
      svc.takeBackup();
      expect(JSON.parse(fs.readFileSync(currentPath, "utf8")).appState.sidebarWidth).toBe(1);
    });

    it("rolling pair stays a pair across multiple takeBackup calls (no chain accumulation)", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const currentPath = path.join(backupDir, "session-state.json");
      const previousPath = path.join(backupDir, "session-state.previous.json");

      // First write to set the baseline (no previous yet).
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 1, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      // Change state and write again — previous now holds gen-1, current holds gen-2.
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 2, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      svc.takeBackup();

      // Change state and write a third time — previous now holds gen-2, current holds gen-3.
      // Critically: gen-1 must be gone (no `.previous.previous.json` accumulation).
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 3, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      svc.takeBackup();

      const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
      const previous = JSON.parse(fs.readFileSync(previousPath, "utf8"));
      expect(current.appState.sidebarWidth).toBe(3);
      expect(previous.appState.sidebarWidth).toBe(2);
      // No third-generation file ever created — the directory must hold at
      // most two backup files (plus crash logs in a sibling dir).
      const backupFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith(".json"));
      expect(backupFiles.sort()).toEqual(["session-state.json", "session-state.previous.json"]);
    });

    it("consumeMarker caches previous-generation snapshot when current is corrupt", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, "session-state.json"), "corrupt");
      const previousSnapshot = {
        capturedAt: Date.now() - 30_000,
        appState: { sidebarWidth: 321, terminals: [{ id: "p1", kind: "terminal" }] },
      };
      fs.writeFileSync(
        path.join(backupDir, "session-state.previous.json"),
        JSON.stringify(previousSnapshot)
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
      expect(pending).not.toBeNull();
      expect(pending!.hasBackup).toBe(true);
      expect(pending!.panels).toBeDefined();
      expect(pending!.panels![0]).toMatchObject({ id: "p1", kind: "terminal" });

      // Cached snapshot ensures restoreBackup applies the previous-generation
      // appState even if the backup files are deleted under it. consumeMarker
      // renames the current backup to a crashed-* path during initialize, so
      // we sweep all .json files instead of unlinking specific paths.
      for (const file of fs.readdirSync(backupDir)) {
        if (file.endsWith(".json")) fs.unlinkSync(path.join(backupDir, file));
      }
      const restored = svc.restoreBackup();
      expect(restored).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("appState", previousSnapshot.appState);
    });
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
