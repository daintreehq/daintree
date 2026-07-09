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

  describe("backup / restore", () => {
    it("creates backup on takeBackup", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 400, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project-a": { width: 1200, height: 800, isMaximized: false },
      });

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      const backupPath = path.join(userData, "backups", "session-state.json");
      expect(fs.existsSync(backupPath)).toBe(true);
      const snapshot = JSON.parse(fs.readFileSync(backupPath, "utf8"));
      expect(typeof snapshot.capturedAt).toBe("number");
      expect(snapshot.appState).toBeDefined();
      expect(snapshot.windowStates).toBeDefined();
      expect(snapshot.projects).toBeUndefined();
    });

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

    it("captureSessionSnapshot never reads projects key from store", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "appState") return { sidebarWidth: 400, terminals: [] };
        return { autoRestoreOnCrash: false };
      });
      windowStatesStoreMock.get.mockReturnValue({});

      const svc = makeService();
      svc.initialize();
      storeMock.get.mockClear();
      svc.takeBackup();

      const readKeys = storeMock.get.mock.calls.map((c: unknown[]) => c[0]);
      expect(readKeys).not.toContain("projects");
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
});
