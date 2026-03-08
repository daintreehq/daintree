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
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("electron", () => ({
  app: appMock,
}));

import { CrashRecoveryService } from "../CrashRecoveryService.js";

function makeService(): CrashRecoveryService {
  return new CrashRecoveryService();
}

describe("CrashRecoveryService", () => {
  let tmpDir: string;
  let userData: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-test-"));
    userData = tmpDir;
    appMock.getPath.mockReturnValue(userData);
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
  });

  describe("recordCrash", () => {
    it("writes crash log to crashes directory", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordCrash(new Error("Test error"));

      const crashDir = path.join(userData, "crashes");
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);

      const entry = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), "utf8"));
      expect(entry.errorMessage).toBe("Test error");
      expect(entry.appVersion).toBe("1.0.0");
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
        if (key === "projects") return { list: [], currentProjectId: undefined };
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
    });

    it("restoreBackup applies snapshot to store", () => {
      const backupDir = path.join(userData, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const snapshot = {
        capturedAt: Date.now(),
        appState: { sidebarWidth: 999, terminals: [] },
        projects: { list: [], currentProjectId: "p1" },
        windowState: { width: 1400, height: 900, isMaximized: false },
      };
      fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));

      storeMock.get.mockReturnValue({ autoRestoreOnCrash: false });

      const svc = makeService();
      svc.initialize();
      const result = svc.restoreBackup();

      expect(result).toBe(true);
      expect(storeMock.set).toHaveBeenCalledWith("appState", snapshot.appState);
      expect(storeMock.set).toHaveBeenCalledWith("projects", snapshot.projects);
    });

    it("returns false when no backup exists", () => {
      const svc = makeService();
      svc.initialize();
      expect(svc.restoreBackup()).toBe(false);
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
