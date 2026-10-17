import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/fake/userData") },
}));

const MOCK_START_TIME =
  process.platform === "win32"
    ? "2026-01-01T00:00:00.0000000+00:00\n"
    : "Thu Jan  1 00:00:00 2026\n";

const MOCK_START_TIME_PARSED =
  process.platform === "win32" ? "2026-01-01T00:00:00.0000000+00:00" : "Thu Jan  1 00:00:00 2026";

// Hoisted: vi.mock factories run before module-scope code, so the mock binding
// must be created via vi.hoisted to be available inside the factory. We model
// the promisified execFile directly because Node's real execFile carries a
// hidden `customPromisifyArgs` symbol that makes `promisify(execFile)` resolve
// as `{stdout, stderr}`. A naive callback-style mock would resolve as a bare
// string and the destructure in TrashedPidTracker would yield `undefined`.
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const wrapperExecFile = (() => {
    throw new Error("callback-style execFile is not exercised in TrashedPidTracker tests");
  }) as unknown as ((...a: unknown[]) => void) & Record<symbol, unknown>;
  wrapperExecFile[util.promisify.custom] = (...args: unknown[]) =>
    (mockExecFileAsync as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  return {
    execFile: wrapperExecFile,
  };
});

vi.mock("../../utils/windowsTreeKill.js", () => ({
  killWindowsProcessTree: vi.fn(async () => ({
    mode: "tree",
    targeted: [],
    failed: [],
    stale: [],
    rootEnded: true,
  })),
}));

import { TrashedPidTracker } from "../TrashedPidTracker.js";
import { killWindowsProcessTree } from "../../utils/windowsTreeKill.js";

const mockedTreeKill = vi.mocked(killWindowsProcessTree);

async function defaultExecFileAsync(): Promise<{ stdout: string; stderr: string }> {
  return { stdout: MOCK_START_TIME, stderr: "" };
}

describe("TrashedPidTracker", () => {
  let tmpDir: string;
  let tracker: TrashedPidTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockImplementation(defaultExecFileAsync as never);
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
    it("writes a valid entry to the file", async () => {
      await tracker.persistTrashed("term-1", 12345);
      const entries = readFile() as Array<{ terminalId: string; pid: number; startTime: string }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].terminalId).toBe("term-1");
      expect(entries[0].pid).toBe(12345);
      expect(entries[0].startTime).toBe(MOCK_START_TIME_PARSED);
    });

    it("skips undefined or invalid PIDs", async () => {
      await tracker.persistTrashed("term-1", undefined);
      await tracker.persistTrashed("term-2", -1);
      await tracker.persistTrashed("term-3", NaN);
      expect(readFile()).toHaveLength(0);
    });

    it("skips when start time cannot be retrieved", async () => {
      mockExecFileAsync.mockImplementationOnce((async () => {
        throw new Error("no such process");
      }) as never);
      await tracker.persistTrashed("term-1", 12345);
      expect(readFile()).toHaveLength(0);
    });

    it("updates existing entry for same terminal", async () => {
      await tracker.persistTrashed("term-1", 100);
      await tracker.persistTrashed("term-1", 200);
      const entries = readFile() as Array<{ pid: number }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].pid).toBe(200);
    });
  });

  describe("removeTrashed", () => {
    it("removes an entry from the file", async () => {
      await tracker.persistTrashed("term-1", 100);
      await tracker.persistTrashed("term-2", 200);
      tracker.removeTrashed("term-1");
      const entries = readFile() as Array<{ terminalId: string }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].terminalId).toBe("term-2");
    });

    it("deletes file when last entry is removed", async () => {
      await tracker.persistTrashed("term-1", 100);
      tracker.removeTrashed("term-1");
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("does nothing for unknown terminal", async () => {
      await tracker.persistTrashed("term-1", 100);
      tracker.removeTrashed("term-unknown");
      expect(readFile()).toHaveLength(1);
    });

    it("cancels an in-flight persistTrashed for the same terminal (trash→restore race)", async () => {
      let resolveProbe: ((value: { stdout: string; stderr: string }) => void) | null = null;
      mockExecFileAsync.mockImplementation((() => {
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          resolveProbe = resolve;
        });
      }) as never);

      const persistPromise = tracker.persistTrashed("term-1", 100);
      // Yield so persistTrashed enters its await on getProcessStartTime.
      await Promise.resolve();
      tracker.removeTrashed("term-1");

      expect(resolveProbe).not.toBeNull();
      resolveProbe!({ stdout: MOCK_START_TIME, stderr: "" });
      await persistPromise;

      expect(readFile()).toHaveLength(0);
    });
  });

  describe("clearAll", () => {
    it("deletes the file", async () => {
      await tracker.persistTrashed("term-1", 100);
      tracker.clearAll();
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("does nothing if file does not exist", () => {
      expect(() => tracker.clearAll()).not.toThrow();
    });
  });

  describe("cleanupOrphans", () => {
    it("kills processes with matching start times", async () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: 9999,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      await tracker.cleanupOrphans();

      if (process.platform === "win32") {
        expect(mockedTreeKill).toHaveBeenCalledWith(
          { pid: 9999, startTime: MOCK_START_TIME_PARSED },
          { timeoutMs: 3000 }
        );
      } else {
        expect(killSpy).toHaveBeenCalledWith(-9999, "SIGKILL");
      }
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("on Windows, passes the recorded identity and never falls back to a bare-PID kill", async () => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        writeFile([
          {
            terminalId: "term-1",
            pid: 9999,
            startTime: MOCK_START_TIME_PARSED,
            trashedAt: Date.now(),
          },
        ]);
        mockedTreeKill.mockResolvedValueOnce({
          mode: "tree",
          targeted: [9999],
          killed: [],
          alreadyGone: [],
          timedOut: [],
          unconfirmed: [],
          failed: [{ pid: 9999, code: "win32-5" }],
          identityMismatch: [],
          stale: [],
          rootEnded: false,
        });
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

        await tracker.cleanupOrphans();

        expect(mockedTreeKill).toHaveBeenCalledWith(
          { pid: 9999, startTime: MOCK_START_TIME_PARSED },
          { timeoutMs: 3000 }
        );
        // The PID is not pinned by any handle here; only the helper may end it.
        expect(killSpy).not.toHaveBeenCalled();
        // The start-time probe runs PowerShell by absolute path.
        expect(mockExecFileAsync).toHaveBeenCalledWith(
          expect.stringMatching(
            /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i
          ),
          expect.any(Array),
          expect.any(Object)
        );
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    });

    it("skips processes with mismatched start times (PID recycling)", async () => {
      writeFile([
        { terminalId: "term-1", pid: 9999, startTime: "different-time", trashedAt: Date.now() },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      await tracker.cleanupOrphans();

      expect(killSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("handles corrupt JSON gracefully", async () => {
      fs.writeFileSync(path.join(tmpDir, "trashed-pids.json"), "not json{{{");

      await expect(tracker.cleanupOrphans()).resolves.not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("handles missing file gracefully", async () => {
      await expect(tracker.cleanupOrphans()).resolves.not.toThrow();
    });

    it("skips entries with invalid PIDs", async () => {
      writeFile([
        { terminalId: "term-1", pid: -1, startTime: "some-time", trashedAt: Date.now() },
        { terminalId: "term-2", pid: 0, startTime: "some-time", trashedAt: Date.now() },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      await tracker.cleanupOrphans();

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("skips current process PID", async () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: process.pid,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      await tracker.cleanupOrphans();

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("filters out invalid entries in file", async () => {
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

      await tracker.cleanupOrphans();

      if (process.platform === "win32") {
        expect(mockedTreeKill).toHaveBeenCalledTimes(1);
      } else {
        expect(killSpy).toHaveBeenCalledTimes(1);
      }
    });

    it("probes entries in parallel — one slow probe does not block others", async () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: 1001,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
        {
          terminalId: "term-2",
          pid: 1002,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      const callOrder: number[] = [];
      const slowResolvers: Array<(value: { stdout: string; stderr: string }) => void> = [];
      // PID lives in args[1] for `ps -p <pid>` (Unix) and inside the inline
      // powershell `-Command` string for Win32 (`ProcessId=<pid>`). Extract
      // either form so the test works on every host platform.
      const extractPid = (args: string[]): string | null => {
        if (process.platform === "win32") {
          const cmdIdx = args.indexOf("-Command");
          const cmd = cmdIdx >= 0 ? (args[cmdIdx + 1] ?? "") : "";
          const match = cmd.match(/ProcessId=(\d+)/);
          return match?.[1] ?? null;
        }
        return args[1] ?? null;
      };
      mockExecFileAsync.mockImplementation(((_cmd: string, args: string[]) => {
        const pidArg = extractPid(args);
        if (pidArg) callOrder.push(Number(pidArg));
        if (pidArg === "1001") {
          return new Promise<{ stdout: string; stderr: string }>((resolve) => {
            slowResolvers.push(resolve);
          });
        }
        return Promise.resolve({ stdout: MOCK_START_TIME, stderr: "" });
      }) as never);

      vi.spyOn(process, "kill").mockImplementation(() => true);

      const cleanupPromise = tracker.cleanupOrphans();
      // Yield so both probes initiate before the slow one resolves.
      await Promise.resolve();
      await Promise.resolve();

      expect(callOrder).toEqual([1001, 1002]);
      expect(slowResolvers).toHaveLength(1);
      slowResolvers[0]!({ stdout: MOCK_START_TIME, stderr: "" });

      await cleanupPromise;
      expect(fs.existsSync(path.join(tmpDir, "trashed-pids.json"))).toBe(false);
    });

    it("one probe failure does not abort other entries", async () => {
      writeFile([
        {
          terminalId: "term-1",
          pid: 1001,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
        {
          terminalId: "term-2",
          pid: 1002,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      mockExecFileAsync.mockImplementation((async (_cmd: string, args: string[]) => {
        const pidArg =
          process.platform === "win32"
            ? args[args.indexOf("-Command") + 1]?.match(/ProcessId=(\d+)/)?.[1]
            : args[1];
        if (pidArg === "1001") {
          throw new Error("ps -p race");
        }
        return { stdout: MOCK_START_TIME, stderr: "" };
      }) as never);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      await tracker.cleanupOrphans();

      if (process.platform === "win32") {
        expect(mockedTreeKill).toHaveBeenCalledTimes(1);
        expect(mockedTreeKill).toHaveBeenCalledWith(
          { pid: 1002, startTime: MOCK_START_TIME_PARSED },
          { timeoutMs: 3000 }
        );
      } else {
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(-1002, "SIGKILL");
      }
    });

    it("preserves persistTrashed entries that arrive during cleanup (startup race)", async () => {
      writeFile([
        {
          terminalId: "old-orphan",
          pid: 9999,
          startTime: MOCK_START_TIME_PARSED,
          trashedAt: Date.now(),
        },
      ]);

      const probeResolvers: Array<(value: { stdout: string; stderr: string }) => void> = [];
      mockExecFileAsync.mockImplementation((() => {
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          probeResolvers.push(resolve);
        });
      }) as never);

      vi.spyOn(process, "kill").mockImplementation(() => true);

      const cleanupPromise = tracker.cleanupOrphans();
      // Yield so cleanupOrphans reads the initial entry and enters its
      // verifyProcessStartTime await.
      await Promise.resolve();
      await Promise.resolve();
      expect(probeResolvers).toHaveLength(1);

      // A user trashes a new terminal during the cleanup window.
      const persistPromise = tracker.persistTrashed("new-trashed", 5555);

      // Resolve cleanup's probe; cleanupOrphans proceeds to delete the file.
      probeResolvers[0]!({ stdout: MOCK_START_TIME, stderr: "" });
      // Resolve the new persist's probe so it writes its entry.
      await Promise.resolve();
      await Promise.resolve();
      expect(probeResolvers).toHaveLength(2);
      probeResolvers[1]!({ stdout: MOCK_START_TIME, stderr: "" });

      await Promise.all([cleanupPromise, persistPromise]);

      const entries = readFile() as Array<{ terminalId: string }>;
      expect(entries.map((e) => e.terminalId).sort()).toEqual(["new-trashed"]);
    });
  });
});
