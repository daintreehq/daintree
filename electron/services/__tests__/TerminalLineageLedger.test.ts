import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Hoisted: vi.mock factories run before module-scope code. `promisify(execFile)`
// resolves as `{stdout, stderr}` only because Node's real execFile carries a
// hidden `customPromisifyArgs` symbol, so the mock has to install a
// `promisify.custom` implementation rather than a plain callback stub.
const { mockExecFileAsync, mockSpawnSync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const wrapperExecFile = (() => {
    throw new Error("callback-style execFile is not exercised in these tests");
  }) as unknown as ((...a: unknown[]) => void) & Record<symbol, unknown>;
  wrapperExecFile[util.promisify.custom] = (...args: unknown[]) =>
    (mockExecFileAsync as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  return {
    execFile: wrapperExecFile,
    spawnSync: mockSpawnSync,
  };
});

import {
  TerminalLineageLedger,
  claimShardLineageFile,
  currentBootEpochSec,
  lineageFilePath,
  probeStartTimes,
  reapPersistedLineages,
  type LineageCensus,
} from "../TerminalLineageLedger.js";

const isWindows = process.platform === "win32";

function startTimeFor(pid: number): string {
  return isWindows
    ? `2026-01-01T00:00:0${pid % 10}.0000000+00:00`
    : `Thu Jan  1 00:00:0${pid % 10} 2026`;
}

/** Build a `ps -o pid=,lstart=` style payload for the given PIDs. */
function psOutput(pids: number[]): string {
  return pids.map((pid) => `  ${pid} ${startTimeFor(pid)}`).join("\n") + "\n";
}

interface FakeProc {
  pid: number;
  ppid: number;
  startTime?: string;
}

/**
 * Minimal stand-in for ProcessTreeCache. `getDescendantPids` reproduces the
 * real post-order (leaves first) walk so ordering assertions are meaningful.
 */
class FakeCensus implements LineageCensus {
  private procs = new Map<number, FakeProc>();

  constructor(procs: FakeProc[] = []) {
    this.set(procs);
  }

  set(procs: FakeProc[]): void {
    this.procs = new Map(procs.map((p) => [p.pid, p]));
  }

  getProcess(pid: number): FakeProc | undefined {
    return this.procs.get(pid);
  }

  getDescendantPids(rootPid: number): number[] {
    const result: number[] = [];
    const visited = new Set<number>();
    const visit = (pid: number): void => {
      if (visited.has(pid)) return;
      visited.add(pid);
      for (const proc of this.procs.values()) {
        if (proc.ppid === pid) visit(proc.pid);
      }
      if (pid !== rootPid) result.push(pid);
    };
    visit(rootPid);
    return result;
  }
}

/** Let the ledger's fire-and-forget identity probe settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("TerminalLineageLedger", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const pids = readRequestedPids(args);
      return { stdout: psOutput(pids), stderr: "" };
    });
    mockSpawnSync.mockImplementation(() => ({ status: 0, stdout: "" }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-ledger-test-"));
    filePath = path.join(tmpDir, "pty-lineage.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function readPersisted(): { entries: Array<{ pid: number; startTime: string }> } | null {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  function readRequestedPids(args: string[]): number[] {
    if (isWindows) {
      const script = args[args.length - 1];
      return [...script.matchAll(/ProcessId=(\d+)/g)].map((m) => parseInt(m[1], 10));
    }
    const idx = args.indexOf("-p");
    if (idx === -1) return [];
    return args[idx + 1]
      .split(",")
      .map((p) => parseInt(p, 10))
      .filter((p) => Number.isInteger(p));
  }

  describe("tracking", () => {
    it("records a descendant observed under a root", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);

      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100)).toEqual([{ pid: 200, startTime: startTimeFor(200) }]);
    });

    it("keeps a descendant after it reparents to PID 1", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      // The wrapper exits and the OS reparents its backgrounded child to init.
      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
      ]);
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100).map((t) => t.pid)).toEqual([200]);
    });

    it("prunes a descendant the census no longer reports", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      census.set([{ pid: 100, ppid: 10 }]);
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100)).toEqual([]);
    });

    it("discovers children a detached member spawned after leaving the tree", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      // 200 detaches, then forks 300 while orphaned.
      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
        { pid: 300, ppid: 200 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100).map((t) => t.pid).sort()).toEqual([200, 300]);
    });

    it("never reports a PID whose start time could not be established", async () => {
      mockExecFileAsync.mockRejectedValue(new Error("ps unavailable"));
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100)).toEqual([]);
    });

    it("drops an entry whose census start time changed (PID reuse)", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100, startTime: "original" },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);
      expect(ledger.getTrackedPids(100).map((t) => t.pid)).toEqual([200]);

      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 999, startTime: "recycled" },
      ]);
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100)).toEqual([]);
    });

    it("stops discovering once a root is closing but keeps known descendants", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      ledger.markRootClosing(100);
      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
        { pid: 400, ppid: 100 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      const pids = ledger.getTrackedPids(100).map((t) => t.pid);
      expect(pids).toContain(200);
      expect(pids).not.toContain(400);
    });

    it("drops a closing root once every tracked PID is gone", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      ledger.markRootClosing(100);
      census.set([]);
      ledger.reconcile(census);

      expect(ledger.hasRoots()).toBe(false);
    });

    it("does not let a recycled root PID inherit the previous lineage", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      expect(ledger.getTrackedPids(100).map((t) => t.pid)).toEqual([200]);

      ledger.registerRoot(100);

      expect(ledger.getTrackedPids(100)).toEqual([]);
    });

    it("ignores roots that are not real PIDs", () => {
      const ledger = new TerminalLineageLedger(null);
      ledger.registerRoot(0);
      ledger.registerRoot(1);
      ledger.registerRoot(-5);
      expect(ledger.hasRoots()).toBe(false);
    });
  });

  describe("persistence", () => {
    it("persists only orphaned descendants", async () => {
      const ledger = new TerminalLineageLedger(filePath);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 10, ppid: 1 },
        { pid: 200, ppid: 100 },
        { pid: 300, ppid: 1 },
      ]);
      ledger.registerRoot(100);
      // 300 becomes part of the lineage by being a descendant while attached...
      census.set([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
        { pid: 300, ppid: 200 },
      ]);
      ledger.reconcile(census);
      await flush();

      // ...then detaches. 200 stays attached to the live shell.
      census.set([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
        { pid: 300, ppid: 1 },
      ]);
      ledger.reconcile(census);

      const persisted = readPersisted();
      expect(persisted?.entries.map((e) => e.pid)).toEqual([300]);
    });

    it("removes the file when nothing is orphaned any more", async () => {
      const ledger = new TerminalLineageLedger(filePath);
      const census = new FakeCensus([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 300, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      census.set([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 300, ppid: 1 },
      ]);
      ledger.reconcile(census);
      expect(readPersisted()).not.toBeNull();

      census.set([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
      ]);
      ledger.reconcile(census);

      expect(readPersisted()).toBeNull();
    });

    it("stamps the current boot epoch", async () => {
      const ledger = new TerminalLineageLedger(filePath);
      const census = new FakeCensus([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 300, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      census.set([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 300, ppid: 1 },
      ]);
      ledger.reconcile(census);

      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(Math.abs(raw.bootEpochSec - currentBootEpochSec())).toBeLessThanOrEqual(5);
      expect(raw.version).toBe(1);
    });
  });

  describe("lineageFilePath", () => {
    it("keeps the default shard on the unsuffixed name", () => {
      expect(lineageFilePath("/data")).toBe(path.join("/data", "pty-lineage.json"));
      expect(lineageFilePath("/data", "daintree-pty-host")).toBe(
        path.join("/data", "pty-lineage.json")
      );
    });

    it("gives each named shard its own file", () => {
      expect(lineageFilePath("/data", "daintree-pty-host:proj-abc123")).toBe(
        path.join("/data", "pty-lineage-proj-abc123.json")
      );
    });
  });

  describe("claimShardLineageFile", () => {
    it("renames the live file out of the way", () => {
      fs.writeFileSync(filePath, "{}");
      const claimed = claimShardLineageFile(tmpDir);
      expect(claimed).toBe(`${filePath}.reaping`);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(`${filePath}.reaping`)).toBe(true);
    });

    it("returns null when there is nothing to claim", () => {
      expect(claimShardLineageFile(tmpDir)).toBeNull();
    });
  });

  describe("reapPersistedLineages", () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    function writeLedger(
      entries: Array<{ pid: number; startTime: string; rootPid: number }>,
      overrides: Record<string, unknown> = {}
    ): void {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          bootEpochSec: currentBootEpochSec(),
          owner: "daintree-pty-host",
          updatedAt: Date.now(),
          entries,
          ...overrides,
        })
      );
    }

    it("kills entries whose start time still matches", async () => {
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }]);

      await reapPersistedLineages(tmpDir);

      if (isWindows) {
        expect(mockSpawnSync).toHaveBeenCalledWith(
          "taskkill",
          ["/T", "/F", "/PID", "4242"],
          expect.anything()
        );
      } else {
        expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
        expect(killSpy).toHaveBeenCalledWith(4242, "SIGKILL");
      }
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("never signals a PID whose start time no longer matches", async () => {
      writeLedger([{ pid: 4242, startTime: "a-different-boot-of-this-pid", rootPid: 100 }]);

      await reapPersistedLineages(tmpDir);

      expect(killSpy).not.toHaveBeenCalled();
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("discards the whole ledger when the boot epoch does not match", async () => {
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }], {
        bootEpochSec: currentBootEpochSec() - 100_000,
      });

      await reapPersistedLineages(tmpDir);

      expect(killSpy).not.toHaveBeenCalled();
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("refuses to signal init, itself, or its parent", async () => {
      writeLedger([
        { pid: 1, startTime: startTimeFor(1), rootPid: 100 },
        { pid: process.pid, startTime: startTimeFor(process.pid), rootPid: 100 },
        { pid: process.ppid, startTime: startTimeFor(process.ppid), rootPid: 100 },
      ]);

      await reapPersistedLineages(tmpDir);

      expect(killSpy).not.toHaveBeenCalled();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("ignores a ledger written by a future schema version", async () => {
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }], { version: 99 });

      await reapPersistedLineages(tmpDir);

      expect(killSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("ignores a corrupt ledger without throwing", async () => {
      fs.writeFileSync(filePath, "{ not json");

      await expect(reapPersistedLineages(tmpDir)).resolves.toBeUndefined();

      expect(killSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("picks up an interrupted reap claim", async () => {
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }]);
      fs.renameSync(filePath, `${filePath}.reaping`);

      await reapPersistedLineages(tmpDir);

      if (!isWindows) {
        expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
      }
      expect(fs.existsSync(`${filePath}.reaping`)).toBe(false);
    });

    it("is a no-op when the directory holds no ledgers", async () => {
      await expect(reapPersistedLineages(tmpDir)).resolves.toBeUndefined();
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe("probeStartTimes", () => {
    it("parses one entry per requested PID", async () => {
      const result = await probeStartTimes([111, 222]);
      expect(result.get(111)).toBe(startTimeFor(111));
      expect(result.get(222)).toBe(startTimeFor(222));
    });

    it("returns an empty map for no PIDs without spawning anything", async () => {
      const result = await probeStartTimes([]);
      expect(result.size).toBe(0);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("still harvests stdout when ps exits non-zero (all PIDs gone)", async () => {
      const err = Object.assign(new Error("Command failed"), { stdout: psOutput([333]) });
      mockExecFileAsync.mockRejectedValue(err);

      const result = await probeStartTimes([333, 444]);

      expect(result.get(333)).toBe(startTimeFor(333));
      expect(result.has(444)).toBe(false);
    });
  });
});
