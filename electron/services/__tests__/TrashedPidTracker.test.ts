import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/fake/userData") },
}));

const MOCK_START_TIME =
  process.platform === "win32"
    ? "CreationDate=20260101000000.000000+000\n"
    : "Thu Jan  1 00:00:00 2026\n";

const MOCK_START_TIME_PARSED =
  process.platform === "win32" ? "20260101000000.000000+000" : "Thu Jan  1 00:00:00 2026";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from(MOCK_START_TIME)),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

import { TrashedPidTracker } from "../TrashedPidTracker.js";
import { execFileSync, spawnSync } from "node:child_process";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);

describe("TrashedPidTracker", () => {
  let tmpDir: string;
  let tracker: TrashedPidTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trashed-pid-test-"));
    tracker = new TrashedPidTracker(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function readFile(): unknown[] {
    const filePath = path.join(tmpDir, "trashed-pids.json");
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  function writeFile(data: unknown[]): void {
    fs.writeFileSync(path.join(tmpDir, "trashed-pids.json"), JSON.stringify(data));
  }

  describe("persistTrashed", () => {
    it("writes a valid entry to the file", () => {
      tracker.persistTrashed("term-1", 12345);
      const entries = readFile() as Array<{ terminalId: string; pid: number; startTime: string }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].terminalId).toBe("term-1");
      expect(entries[0].pid).toBe(12345);
      expect(entries[0].startTime).toBe(MOCK_START_TIME_PARSED);
    });

    it("skips undefined or invalid PIDs", () => {
      tracker.persistTrashed("term-1", undefined);
      tracker.persistTrashed("term-2", -1);
      tracker.persistTrashed("term-3", NaN);
      expect(readFile()).toHaveLength(0);
    });

    it("skips when start time cannot be retrieved", () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error("no such process");
      });
      tracker.persistTrashed("term-1", 12345);
      expect(readFile()).toHaveLength(0);
    });

    it("updates existing entry for same terminal", () => {
      tracker.persistTrashed("term-1", 100);
      tracker.persistTrashed("term-1", 200);
      const entries = readFile() as Array<{ pid: number }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].pid).toBe(200);
    });

    it("appends multiple entries for different terminals", () => {
      tracker.persistTrashed("term-1", 100);
      tracker.persistTrashed("term-2", 200);
      expect(readFile()).toHaveLength(2);
    });
  });

  describe("removeTrashed", () => {
    it("removes an entry from the file", () => {
      tracker.persistTrashed("term-1", 100);
      tracker.persistTrashed("term-2", 200);
      tracker.removeTrashed("term-1");
      const entries = readFile() as Array<{ terminalId: string }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].terminalId).toBe("term-2");
    });

    it("deletes file when last entry is removed", () => {
      tracker.persistTrashed("term-1", 100);
      tracker.removeTrashed("term-1");
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("does nothing for unknown terminal", () => {
      tracker.persistTrashed("term-1", 100);
      tracker.removeTrashed("term-unknown");
      expect(readFile()).toHaveLength(1);
    });
  });

  describe("clearAll", () => {
    it("deletes the file", () => {
      tracker.persistTrashed("term-1", 100);
      tracker.clearAll();
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("does nothing if file does not exist", () => {
      expect(() => tracker.clearAll()).not.toThrow();
    });
  });

  describe("cleanupOrphans", () => {
    it("kills processes with matching start times", () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: 9999,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      tracker.cleanupOrphans();

      if (process.platform === "win32") {
        expect(mockedSpawnSync).toHaveBeenCalledWith(
          "taskkill",
          ["/T", "/F", "/PID", "9999"],
          expect.objectContaining({ windowsHide: true })
        );
      } else {
        expect(killSpy).toHaveBeenCalledWith(-9999, "SIGKILL");
      }
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("skips processes with mismatched start times (PID recycling)", () => {
      writeFile([
        { terminalId: "term-1", pid: 9999, startTime: "different-time", trashedAt: Date.now() },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      tracker.cleanupOrphans();

      expect(killSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("handles corrupt JSON gracefully", () => {
      fs.writeFileSync(path.join(tmpDir, "trashed-pids.json"), "not json{{{");

      expect(() => tracker.cleanupOrphans()).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("handles missing file gracefully", () => {
      expect(() => tracker.cleanupOrphans()).not.toThrow();
    });

    it("skips entries with invalid PIDs", () => {
      writeFile([
        { terminalId: "term-1", pid: -1, startTime: "some-time", trashedAt: Date.now() },
        { terminalId: "term-2", pid: 0, startTime: "some-time", trashedAt: Date.now() },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      tracker.cleanupOrphans();

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("skips current process PID", () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: process.pid,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      tracker.cleanupOrphans();

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("filters out invalid entries in file", () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: 9999,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
        { bad: "entry" },
        "not an object",
        null,
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      tracker.cleanupOrphans();

      if (process.platform === "win32") {
        expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
      } else {
        expect(killSpy).toHaveBeenCalledTimes(1);
      }
    });
  });
});
