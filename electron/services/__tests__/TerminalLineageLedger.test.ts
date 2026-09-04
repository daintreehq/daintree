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
  beginTeardownProbeWindow,
  claimShardLineageFile,
  currentBootEpochSec,
  endTeardownProbeWindow,
  lineageFilePath,
  probeStartTimes,
  probeStartTimesSync,
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
    endTeardownProbeWindow();
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

      // 200 detaches, then forks 300 while orphaned. Adoption waits for 200 to
      // be re-verified as still itself, so this takes an extra sweep.
      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
        { pid: 300, ppid: 200 },
      ]);
      for (let i = 0; i < 3; i++) {
        ledger.reconcile(census);
        await flush();
      }

      expect(
        ledger
          .getTrackedPids(100)
          .map((t) => t.pid)
          .sort()
      ).toEqual([200, 300]);
    });

    it("never reports a PID whose start time could not be established", async () => {
      mockExecFileAsync.mockRejectedValue(
        Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" })
      );
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
      // The Windows census carries CreationDate, so a recycled PID is caught
      // during the sweep rather than waiting for a probe. The fixture uses the
      // same value the probe reports, as production does — both sides render
      // CreationDate.ToString("o").
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100, startTime: startTimeFor(200) },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);
      expect(ledger.getTrackedPids(100).map((t) => t.pid)).toEqual([200]);

      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 999, startTime: `${startTimeFor(200)}-recycled` },
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

  describe("bounded tracking", () => {
    it("keeps trackedCount accurate across admit, prune and root drop", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
        { pid: 201, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      expect(ledger.getTrackedCount()).toBe(2);

      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.reconcile(census);
      expect(ledger.getTrackedCount()).toBe(1);

      ledger.unregisterRoot(100);
      expect(ledger.getTrackedCount()).toBe(0);
      expect(ledger.hasRoots()).toBe(false);
    });

    it("returns capacity when a closing root drains automatically", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      expect(ledger.getTrackedCount()).toBe(1);

      ledger.markRootClosing(100);
      census.set([]);
      ledger.reconcile(census);

      expect(ledger.getTrackedCount()).toBe(0);
      expect(ledger.hasRoots()).toBe(false);
    });

    it("re-registering a recycled root PID releases the old lineage's capacity", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      expect(ledger.getTrackedCount()).toBe(1);

      ledger.registerRoot(100);

      expect(ledger.getTrackedCount()).toBe(0);
    });

    it("stops admitting at the cap instead of evicting known descendants", async () => {
      const ledger = new TerminalLineageLedger(null);
      const procs: FakeProc[] = [{ pid: 100, ppid: 10 }];
      // One more child than the 4096 cap allows.
      for (let i = 0; i < 4097; i++) procs.push({ pid: 1000 + i, ppid: 100 });
      const census = new FakeCensus(procs);
      ledger.registerRoot(100);

      ledger.reconcile(census);

      expect(ledger.getTrackedCount()).toBe(4096);
    });

    it("dispose clears every root and the count", async () => {
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      ledger.dispose();

      expect(ledger.getTrackedCount()).toBe(0);
      expect(ledger.hasRoots()).toBe(false);
    });
  });

  describe("root lifecycle", () => {
    it("closes an active root whose PID was handed to another process", async () => {
      // A root is only keyed by PID. If that number is recycled, an unrelated
      // process tree would be adopted wholesale unless the root notices.
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      // The root is gone, but an unrelated process now holds its PID and has
      // children of its own.
      census.set([
        { pid: 200, ppid: 1 },
        { pid: 100, ppid: 55 },
        { pid: 900, ppid: 100 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      const pids = ledger.getTrackedPids(100).map((t) => t.pid);
      expect(pids).toContain(200);
      expect(pids).not.toContain(900);
    });

    it("closes an active root that vanished without a teardown", async () => {
      // A terminal whose construction failed after the killer registered
      // reaches no teardown path, so nothing would ever close its root.
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      census.set([{ pid: 200, ppid: 1 }]);
      ledger.reconcile(census);
      await flush();
      // The PID is free again and a stranger takes it, with children.
      census.set([
        { pid: 200, ppid: 1 },
        { pid: 100, ppid: 77 },
        { pid: 900, ppid: 100 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100).map((t) => t.pid)).not.toContain(900);
    });

    it("does not let an unidentified orphan adopt a subtree", async () => {
      // 200 never resolves, so it has no proof it is still ours. 300 resolves
      // fine — if the guard were removed, 200 would launder 300 into the ledger
      // and getTrackedPids would report it.
      mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
        const pids = readRequestedPids(args).filter((pid) => pid !== 200);
        return { stdout: psOutput(pids), stderr: "" };
      });
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
        { pid: 300, ppid: 200 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100).map((t) => t.pid)).not.toContain(300);
    });

    it("drops a tracked orphan whose PID was recycled, so it cannot adopt", async () => {
      // POSIX prune cannot see this: the census has no start time, so PID 200
      // still "exists". Only re-verification catches that it is someone else
      // now — and an orphan that is not ours must not pull in its children.
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
      ]);
      ledger.reconcile(census);
      await flush();
      expect(ledger.getTrackedPids(100).map((t) => t.pid)).toEqual([200]);

      // PID 200 now belongs to an unrelated process with a child of its own.
      mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
        const pids = readRequestedPids(args);
        const lines = pids.map((pid) =>
          pid === 200 ? `  200 ${startTimeFor(7)}` : `  ${pid} ${startTimeFor(pid)}`
        );
        return { stdout: lines.join("\n") + "\n", stderr: "" };
      });
      census.set([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
        { pid: 300, ppid: 200 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);
      await flush();

      const pids = ledger.getTrackedPids(100).map((t) => t.pid);
      expect(pids).not.toContain(200);
      expect(pids).not.toContain(300);
    });

    it("requeues identification after a transient probe failure", async () => {
      mockExecFileAsync.mockRejectedValueOnce(
        Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" })
      );
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      // First probe failed — nothing signallable yet.
      expect(ledger.getTrackedPids(100)).toEqual([]);

      // The next sweep must retry rather than abandon the PID forever.
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getTrackedPids(100).map((t) => t.pid)).toEqual([200]);
    });
  });

  describe("getVerifiedOrphanPids", () => {
    it("never returns init, this process, or its parent", async () => {
      // The persisted reaper refuses these; the in-memory kill path is the
      // other surface that signals, so it has to refuse them too.
      mockSpawnSync.mockImplementation((_file: string, args: string[]) => ({
        status: 0,
        stdout: psOutput(readRequestedPids(args)),
      }));
      const ledger = new TerminalLineageLedger(null);
      const census = new FakeCensus([
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
        { pid: process.pid, ppid: 100 },
        { pid: process.ppid, ppid: 100 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(ledger.getVerifiedOrphanPids(100, [])).toEqual([200]);
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

    it("persists a detached member's own children too", async () => {
      // 300's parent 200 is alive, so a "parent is missing" test would leave
      // 300 unpersisted — and the restart that reaps 200 would let 300
      // reparent to init and survive, recreating the bug one level down.
      const ledger = new TerminalLineageLedger(filePath);
      const census = new FakeCensus([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
        { pid: 300, ppid: 200 },
      ]);
      ledger.registerRoot(100);
      ledger.reconcile(census);
      await flush();

      census.set([
        { pid: 10, ppid: 1 },
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 1 },
        { pid: 300, ppid: 200 },
      ]);
      ledger.reconcile(census);
      await flush();
      ledger.reconcile(census);

      expect(readPersisted()?.entries.map((e) => e.pid)).toEqual([200, 300]);
    });

    it("retries the write after a transient failure on an unchanged orphan set", async () => {
      // The parent directory does not exist yet, so the atomic write throws.
      const nestedDir = path.join(tmpDir, "nested");
      const nestedPath = path.join(nestedDir, "pty-lineage.json");
      const readNested = (): { entries: Array<{ pid: number }> } | null =>
        fs.existsSync(nestedPath) ? JSON.parse(fs.readFileSync(nestedPath, "utf8")) : null;

      const ledger = new TerminalLineageLedger(nestedPath);
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
      expect(readNested()).toBeNull();

      // The orphan set is identical on the retry, so a signature recorded
      // before the failed write would suppress it forever, leaving no
      // crash-recovery record at all.
      fs.mkdirSync(nestedDir);
      ledger.reconcile(census);

      expect(readNested()?.entries.map((e) => e.pid)).toEqual([300]);
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
      expect(claimed).toMatch(/pty-lineage\.json\.reaping-/);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(claimed as string)).toBe(true);
    });

    it("never destroys an earlier interrupted claim", () => {
      // An existing claim is another host's unreaped survivor list. Overwriting
      // it would discard the only record of those processes.
      // Exactly the destination the old fixed-name implementation deleted.
      fs.writeFileSync(`${filePath}.reaping`, '{"earlier":true}');
      fs.writeFileSync(filePath, "{}");

      const claimed = claimShardLineageFile(tmpDir);

      expect(fs.existsSync(`${filePath}.reaping`)).toBe(true);
      expect(claimed).not.toBe(`${filePath}.reaping`);
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

    /** The single lineage file the sweep left behind, whatever its name. */
    function readRetained(): {
      path: string;
      attempts?: number;
      entries: Array<{ pid: number }>;
    } | null {
      const names = fs.readdirSync(tmpDir).filter((n) => n.startsWith("pty-lineage"));
      if (names.length !== 1) return null;
      const retainedPath = path.join(tmpDir, names[0]);
      return { path: retainedPath, ...JSON.parse(fs.readFileSync(retainedPath, "utf8")) };
    }

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

    it("keeps the ledger when the probe could not run at all", async () => {
      // A blocked `ps` makes "already gone" and "cannot tell" look identical.
      // Deleting here would discard the only record of a live survivor.
      mockExecFileAsync.mockRejectedValue(
        Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" })
      );
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }]);

      await reapPersistedLineages(tmpDir);

      expect(killSpy).not.toHaveBeenCalled();
      const retained = readRetained();
      expect(retained?.attempts).toBe(1);
      expect(retained?.entries.map((e) => e.pid)).toEqual([4242]);
    });

    it("keeps a retained survivor list off the path a new host will write", async () => {
      // The retry file used to be rewritten in place. The pty-host forked
      // moments later builds its own ledger at that same path, and its first
      // reconcile with no orphans unlinks it — so the bounded-attempt path
      // never survived a single terminal spawn.
      mockExecFileAsync.mockRejectedValue(
        Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" })
      );
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }]);

      await reapPersistedLineages(tmpDir);
      expect(fs.existsSync(filePath)).toBe(false);

      const ledger = new TerminalLineageLedger(filePath);
      ledger.registerRoot(100);
      ledger.reconcile(new FakeCensus([{ pid: 10, ppid: 1 }]));
      await flush();

      expect(readRetained()?.entries.map((e) => e.pid)).toEqual([4242]);
    });

    it("gives up on an unresolvable ledger after a bounded number of launches", async () => {
      mockExecFileAsync.mockRejectedValue(
        Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" })
      );
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }], { attempts: 2 });

      await reapPersistedLineages(tmpDir);

      // Retrying forever would leak the file just as surely as deleting early.
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.readdirSync(tmpDir).filter((n) => n.startsWith("pty-lineage"))).toEqual([]);
    });

    it("deletes the ledger when the probe genuinely reports the PID gone", async () => {
      // Real `ps -p` rejects with exit status 1 and empty stdout when none of
      // the requested PIDs exist. The probe ran and gave an answer, so this is
      // evidence of absence, not ambiguity.
      mockExecFileAsync.mockImplementation(async () => {
        throw Object.assign(new Error("Command failed: ps"), { code: 1, stdout: "" });
      });
      writeLedger([{ pid: 4242, startTime: startTimeFor(4242), rootPid: 100 }]);

      await reapPersistedLineages(tmpDir);

      expect(killSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("is a no-op when the directory holds no ledgers", async () => {
      await expect(reapPersistedLineages(tmpDir)).resolves.toBeUndefined();
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe("teardown probe window", () => {
    it("shares one budget across every sync probe until it is released", () => {
      // Host teardown disposes N terminals on one thread inside an ~1s window,
      // and each disposal can run two verification passes. A per-invocation
      // budget would let the first few claim the whole window.
      beginTeardownProbeWindow(0);
      expect(probeStartTimesSync([111]).size).toBe(0);
      expect(probeStartTimesSync([222]).size).toBe(0);
      expect(mockSpawnSync).not.toHaveBeenCalled();

      endTeardownProbeWindow();
      mockSpawnSync.mockImplementation((_file: string, args: string[]) => ({
        status: 0,
        stdout: psOutput(readRequestedPids(args)),
      }));

      expect(probeStartTimesSync([111]).get(111)).toBe(startTimeFor(111));
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
