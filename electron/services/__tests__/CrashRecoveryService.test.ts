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

    it("consumes marker on detection — marker deleted before new one written", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 1000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      const svc = makeService();
      svc.initialize();

      // New marker is written for this session, but the crash is detected
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(svc.getPendingCrash()).not.toBeNull();
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

    it("surfaces legacy marker without isPackaged field in dev session", () => {
      const markerPath = path.join(userData, "running.lock");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionStartMs: Date.now() - 5000,
          appVersion: "1.0.0",
          platform: "darwin",
        })
      );

      appMock.isPackaged = false;
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
      expect(pending!.panels![1].isSuspect).toBe(true);
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

    it("setConfig persists to store", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      const result = svc.setConfig({ autoRestoreOnCrash: true });

      expect(result.autoRestoreOnCrash).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("crashRecovery", { autoRestoreOnCrash: true });
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
        "utf-8"
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
        "utf-8"
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
});
