import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/fake/userData"),
  getVersion: vi.fn(() => "1.0.0"),
  isPackaged: false as boolean,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [{}]),
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
              { id: "t2", kind: "agent" },
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
      expect(pending!.entry.panelKinds).toEqual({ terminal: 1, agent: 1 });
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
              { id: "t2", kind: "agent" },
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
      expect(entry.panelKinds).toEqual({ terminal: 2, agent: 1 });
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
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return { autoRestoreOnCrash: false };
      });

      const svc = makeService();
      svc.initialize();
      svc.takeBackup();

      const backupPath = path.join(userData, "backups", "session-state.json");
      expect(fs.existsSync(backupPath)).toBe(true);
      const snapshot = JSON.parse(fs.readFileSync(backupPath, "utf8"));
      expect(typeof snapshot.capturedAt).toBe("number");
      expect(snapshot.appState).toBeDefined();
      expect(snapshot.windowState).toBeDefined();
      expect(snapshot.projects).toBeUndefined();
    });

    it("restoreBackup applies snapshot to store", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const snapshot = {
        capturedAt: Date.now(),
        appState: { sidebarWidth: 999, terminals: [] },
        windowState: { width: 1400, height: 900, isMaximized: false },
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      const result = svc.restoreBackup();

      expect(result).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("appState", snapshot.appState);
      expect(storeMock.set).toHaveBeenCalledWith("windowState", snapshot.windowState);
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
            { id: "t2", kind: "agent", title: "T2" },
            { id: "t3", kind: "browser", title: "T3" },
          ],
        },
        windowState: { width: 1400, height: 900, isMaximized: false },
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
        windowState: { width: 1400, height: 900, isMaximized: false },
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
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return { autoRestoreOnCrash: false };
      });

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
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return { autoRestoreOnCrash: false };
      });

      const svc = makeService();
      svc.initialize();
      storeMock.get.mockClear();
      svc.takeBackup();

      const readKeys = storeMock.get.mock.calls.map((c: unknown[]) => c[0]);
      expect(readKeys).not.toContain("projects");
    });

    it("restoreBackup returns true but applies no state for legacy-only snapshot", () => {
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

      expect(result).toBe(true);
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
        { id: "t2", kind: "agent", title: "Claude", location: "dock", worktreeId: "w1" },
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
      expect(pending!.panels![1]).toMatchObject({ id: "t2", kind: "agent", location: "dock" });
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
          kind: "agent",
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
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return { autoRestoreOnCrash: false };
      });

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

    it("defaults to false for invalid stored value", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: "yes" });
      const svc = makeService();
      expect(svc.getConfig().autoRestoreOnCrash).toBe(false);
    });

    it("setConfig persists to store", () => {
      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });
      const svc = makeService();
      const result = svc.setConfig({ autoRestoreOnCrash: true });

      expect(result.autoRestoreOnCrash).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("crashRecovery", { autoRestoreOnCrash: true });
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
  });
});
