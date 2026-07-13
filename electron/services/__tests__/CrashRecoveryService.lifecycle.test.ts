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
});
