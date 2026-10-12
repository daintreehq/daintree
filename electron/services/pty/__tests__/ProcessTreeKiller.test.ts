import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { IPty } from "node-pty";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import {
  beginWindowsExitBatch,
  flushWindowsExitBatch,
  flushWindowsExitBatchAsync,
  ProcessTreeKiller,
  type LineageKillSource,
} from "../ProcessTreeKiller.js";
import type { KillCensus } from "../../TerminalLineageLedger.js";
import {
  isWindowsTreeKillHelperRunning,
  killWindowsProcessTrees,
  killWindowsProcessTreesSync,
  type WindowsTreeKillResult,
  type WindowsTreeKillTarget,
} from "../../../utils/windowsTreeKill.js";
import { identityMicros } from "../../../utils/windowsProcessTree.js";

// Every Windows kill goes through the verified helper; nothing here may start
// a real PowerShell, and nothing may reach taskkill at all.
vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(),
  killWindowsProcessTreesSync: vi.fn(),
  isWindowsTreeKillHelperRunning: vi.fn(() => false),
}));
vi.mock("child_process", () => ({ spawnSync: vi.fn(), spawn: vi.fn(), execFile: vi.fn() }));

const treeKillMock = vi.mocked(killWindowsProcessTrees);
const treeKillSyncMock = vi.mocked(killWindowsProcessTreesSync);
const helperRunningMock = vi.mocked(isWindowsTreeKillHelperRunning);

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

function makePty(pid: number): IPty {
  return {
    pid,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
}

function makeTreeCache(
  descendants: number[],
  subtrees: Record<number, number[]> = {}
): ProcessTreeCache {
  return {
    getDescendantPids: (rootPid: number) => (rootPid in subtrees ? subtrees[rootPid] : descendants),
    getProcess: () => undefined,
  } as unknown as ProcessTreeCache;
}

function makeLineage(
  orphansByRoot: Record<number, number[]>
): LineageKillSource & { closed: number[] } {
  const closed: number[] = [];
  return {
    closed,
    registerRoot: () => {},
    markRootClosing: (rootPid: number) => {
      closed.push(rootPid);
    },
    getVerifiedOrphanPids: (rootPid, alreadyCovered) => {
      const covered = new Set(alreadyCovered);
      return (orphansByRoot[rootPid] ?? []).filter((pid) => !covered.has(pid));
    },
  };
}

function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(message ?? code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// The POSIX SIGTERM/SIGCONT/SIGKILL escalation is Unix-only (Windows uses the
// verified tree-kill helper). Skip the whole suite on Windows so it reports as skipped rather
// than passing vacuously via per-test early-returns.
describe.skipIf(process.platform === "win32")(
  "ProcessTreeKiller — kill() error discrimination",
  () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
    });

    afterEach(() => {
      killSpy?.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it("silently ignores ESRCH from descendant SIGTERM", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _sig) => {
        throw makeErrnoError("ESRCH", "kill ESRCH");
      });

      const killer = new ProcessTreeKiller(makePty(1000), makeTreeCache([1001, 1002]));
      killer.execute(true);

      expect(warnSpy).not.toHaveBeenCalled();
      // Guard against the loop being silently skipped: both descendants must
      // have received SIGTERM and the follow-up SIGCONT (ESRCH on SIGTERM is
      // treated as "process already gone" — SIGCONT still runs and ESRCHs too).
      expect(killSpy).toHaveBeenCalledWith(1001, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(1001, "SIGCONT");
      expect(killSpy).toHaveBeenCalledWith(1002, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(1002, "SIGCONT");
    });

    it("warns once per pid when SIGTERM fails with EPERM", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
        if (sig === "SIGTERM") {
          throw makeErrnoError("EPERM", "kill EPERM");
        }
        // Let SIGKILL succeed silently.
        return true;
      });

      const killer = new ProcessTreeKiller(makePty(1000), makeTreeCache([1001, 1002]));
      killer.execute(true);

      const sigtermWarnings = warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes("SIGTERM"));
      expect(sigtermWarnings).toHaveLength(2);
      expect(sigtermWarnings[0]).toContain("[ProcessTreeKiller]");
      expect(sigtermWarnings[0]).toContain("pid=1001");
      expect(sigtermWarnings[1]).toContain("pid=1002");
    });

    it("warns once per pid when SIGKILL sweep fails with EPERM", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
        if (sig === "SIGKILL") {
          throw makeErrnoError("EPERM", "kill EPERM");
        }
        // Let SIGTERM succeed silently.
        return true;
      });

      const killer = new ProcessTreeKiller(makePty(2000), makeTreeCache([2001]));
      killer.execute(true);

      const sigkillWarnings = warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes("SIGKILL"));
      // sweep iterates [...descendants, shellPid] = [2001, 2000]
      expect(sigkillWarnings).toHaveLength(2);
      expect(sigkillWarnings.some((m: string) => m.includes("pid=2001"))).toBe(true);
      expect(sigkillWarnings.some((m: string) => m.includes("pid=2000"))).toBe(true);
    });

    it("does not warn on ESRCH during SIGKILL sweep", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
        if (sig === "SIGKILL") {
          throw makeErrnoError("ESRCH");
        }
        return true;
      });

      const killer = new ProcessTreeKiller(makePty(3000), makeTreeCache([3001]));
      killer.execute(true);

      const sigkillWarnings = warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes("SIGKILL"));
      expect(sigkillWarnings).toHaveLength(0);
      // Guard against the sweep being a no-op: SIGKILL must have been attempted
      // for both descendant and shell pids.
      expect(killSpy).toHaveBeenCalledWith(3001, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(3000, "SIGKILL");
    });

    it("sends SIGCONT after SIGTERM for each descendant, then SIGCONT for shell", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const pty = makePty(4000);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([4001, 4002]));
      // Use a deferred escalation so SIGKILL doesn't fire and obscure the
      // SIGTERM/SIGCONT call sequence we're asserting.
      killer.execute(false);

      const signals = killSpy.mock.calls.map((c: unknown[]) => [c[0], c[1]]);
      expect(signals).toEqual([
        [4001, "SIGTERM"],
        [4001, "SIGCONT"],
        [4002, "SIGTERM"],
        [4002, "SIGCONT"],
        [4000, "SIGCONT"],
      ]);
      expect(pty.kill).toHaveBeenCalledTimes(1);

      killer.abort();
    });

    it("silently ignores ESRCH from SIGCONT calls", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
        if (sig === "SIGCONT") {
          throw makeErrnoError("ESRCH");
        }
        return true;
      });

      const killer = new ProcessTreeKiller(makePty(5000), makeTreeCache([5001, 5002]));
      killer.execute(true);

      const sigcontWarnings = warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes("SIGCONT"));
      expect(sigcontWarnings).toHaveLength(0);
      // Guard against SIGCONT being silently skipped: each descendant and the
      // shell must have received a SIGCONT call.
      expect(killSpy).toHaveBeenCalledWith(5001, "SIGCONT");
      expect(killSpy).toHaveBeenCalledWith(5002, "SIGCONT");
      expect(killSpy).toHaveBeenCalledWith(5000, "SIGCONT");
    });

    it("warns once per pid when SIGCONT fails with EPERM", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
        if (sig === "SIGCONT") {
          throw makeErrnoError("EPERM", "kill EPERM");
        }
        return true;
      });

      const killer = new ProcessTreeKiller(makePty(6000), makeTreeCache([6001, 6002]));
      killer.execute(true);

      const sigcontWarnings = warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes("SIGCONT"));
      // Two descendants + one shell SIGCONT.
      expect(sigcontWarnings).toHaveLength(3);
      expect(sigcontWarnings.some((m: string) => m.includes("pid=6001"))).toBe(true);
      expect(sigcontWarnings.some((m: string) => m.includes("pid=6002"))).toBe(true);
      expect(sigcontWarnings.some((m: string) => m.includes("pid=6000"))).toBe(true);
      sigcontWarnings.forEach((m: string) => {
        expect(m).toContain("[ProcessTreeKiller]");
      });
    });

    it("skips SIGCONT when SIGTERM fails with EPERM", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
        if (sig === "SIGTERM") {
          throw makeErrnoError("EPERM", "kill EPERM");
        }
        return true;
      });

      const killer = new ProcessTreeKiller(makePty(8000), makeTreeCache([8001, 8002]));
      killer.execute(true);

      // Descendant SIGCONT must NOT be called when its SIGTERM was rejected.
      // Waking a process we couldn't signal would let it run freely without
      // the queued SIGTERM the wake was meant to deliver.
      expect(killSpy).not.toHaveBeenCalledWith(8001, "SIGCONT");
      expect(killSpy).not.toHaveBeenCalledWith(8002, "SIGCONT");
      // Shell SIGCONT is independent of the descendant gate — it's tied to
      // ptyProcess.kill() (SIGHUP), not the descendant SIGTERM loop.
      expect(killSpy).toHaveBeenCalledWith(8000, "SIGCONT");
    });

    it("sends shell SIGCONT even when ptyProcess.kill() throws", () => {
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const pty = makePty(7000);
      (pty.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("pty already exited");
      });
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));
      killer.execute(true);

      const shellSigcont = killSpy.mock.calls.find(
        (c: unknown[]) => c[0] === 7000 && c[1] === "SIGCONT"
      );
      expect(shellSigcont).toBeDefined();
    });
  }
);

// The lineage ledger widens the kill set to descendants that already reparented
// to PID 1, which no tree walk can find (#12203). The ledger owns start-time
// verification, so everything it hands back here is already proven to be ours.
describe.skipIf(process.platform === "win32")("ProcessTreeKiller — lineage orphans", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy?.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("SIGTERMs a reparented descendant the live walk cannot see", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.execute(false);

    expect(killSpy).toHaveBeenCalledWith(5001, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(5001, "SIGCONT");
  });

  it("escalates a reparented descendant to SIGKILL after the grace window", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(killSpy).toHaveBeenCalledWith(5001, "SIGKILL");
  });

  it("signals an overlapping pid once, not twice", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([2001], { 2001: [] }),
      makeLineage({ 1000: [2001] })
    );

    killer.execute(true);

    const sigterms = killSpy.mock.calls.filter(
      (c: unknown[]) => c[0] === 2001 && c[1] === "SIGTERM"
    );
    expect(sigterms).toHaveLength(1);
  });

  it("signals a detached member's tracked child before the member itself", () => {
    // Both are verified ledger members; the census only supplies the ordering.
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [6001], 6001: [] }),
      makeLineage({ 1000: [5001, 6001] })
    );

    killer.execute(true);

    const order = killSpy.mock.calls
      .filter((c: unknown[]) => c[1] === "SIGTERM")
      .map((c: unknown[]) => c[0]);
    expect(order).toContain(6001);
    expect(order).toContain(5001);
    // Leaves first: the detached wrapper's child is signalled before the wrapper.
    expect(order.indexOf(6001)).toBeLessThan(order.indexOf(5001));
  });

  it("never signals a cached-subtree PID the ledger did not verify", () => {
    // 6001 sits under verified 5001 in the seconds-stale census but is NOT in
    // the verified set — it may have exited and had its PID recycled. Expanding
    // a verified parent's cached subtree would kill whatever holds it now.
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [6001] }),
      makeLineage({ 1000: [5001] })
    );

    killer.execute(true);
    vi.advanceTimersByTime(500);

    const touched = killSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(touched).toContain(5001);
    expect(touched).not.toContain(6001);
  });

  it("late-registers a root whose PID was not available at construction", () => {
    const registered: number[] = [];
    const lineage: LineageKillSource = {
      registerRoot: (pid) => registered.push(pid),
      markRootClosing: () => {},
      getVerifiedOrphanPids: () => [],
    };

    // Windows ConPTY reports PID 0 at spawn; the real PID lands later.
    const killer = new ProcessTreeKiller(makePty(0), makeTreeCache([]), lineage);
    expect(registered).toEqual([]);

    killer.registerRoot(4242);
    killer.registerRoot(4242);

    // Registered once — a repeat would reset the lineage and discard what we
    // have already observed.
    expect(registered).toEqual([4242]);
  });

  it("marks the root closing so a recycled PID cannot inherit the lineage", () => {
    const lineage = makeLineage({ 1000: [] });
    const killer = new ProcessTreeKiller(makePty(1000), makeTreeCache([]), lineage);

    killer.execute(true);

    expect(lineage.closed).toEqual([1000]);
  });

  it("registers the shell PID as a lineage root on construction", () => {
    const registered: number[] = [];
    const lineage: LineageKillSource = {
      registerRoot: (pid) => registered.push(pid),
      markRootClosing: () => {},
      getVerifiedOrphanPids: () => [],
    };

    new ProcessTreeKiller(makePty(1000), makeTreeCache([]), lineage);

    expect(registered).toEqual([1000]);
  });

  it("does not register an invalid shell PID", () => {
    const registered: number[] = [];
    const lineage: LineageKillSource = {
      registerRoot: (pid) => registered.push(pid),
      markRootClosing: () => {},
      getVerifiedOrphanPids: () => [],
    };

    new ProcessTreeKiller(makePty(0), makeTreeCache([]), lineage);

    expect(registered).toEqual([]);
  });

  it("behaves exactly as before when no ledger is attached", () => {
    const pty = makePty(1000);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([1001]));

    killer.execute(true);

    const signalled = new Set(killSpy.mock.calls.map((c: unknown[]) => c[0]));
    expect(signalled).toEqual(new Set([1001, 1000]));
  });
});

// A shell that exits on its own previously only cancelled the escalation timer,
// leaving anything it had already detached running forever (#12203).
describe.skipIf(process.platform === "win32")("ProcessTreeKiller — reapAfterRootExit", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy?.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("reaps children the stale census still lists under the exited shell", () => {
    // The census is up to one sweep old, so it still shows 5001 beneath the
    // shell. The shell is gone, so 5001 is already reparented — subtracting a
    // live walk here would signal nothing at all.
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [5001], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();

    expect(killSpy).toHaveBeenCalledWith(5001, "SIGTERM");
  });

  it("does not SIGKILL a stale-census PID the ledger cannot verify", () => {
    // 7777 is only in the stale live walk — the ledger never identified it, so
    // it must not be signalled on a path where the walk is untrustworthy.
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [7777], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();
    vi.advanceTimersByTime(500);

    const touched = killSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(touched).not.toContain(7777);
    expect(touched).toContain(5001);
  });

  it("reaps a descendant left behind by a naturally exited shell", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();

    expect(killSpy).toHaveBeenCalledWith(5001, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(5001, "SIGCONT");
  });

  it("never signals the shell PID — the OS may have recycled it", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();
    vi.advanceTimersByTime(500);

    const touched = killSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(touched).not.toContain(1000);
    expect(touched).toContain(5001);
  });

  it("does not touch the PTY handle — the shell is already gone", () => {
    const pty = makePty(1000);
    const killer = new ProcessTreeKiller(
      pty,
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();

    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("escalates surviving orphans to SIGKILL", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(killSpy).toHaveBeenCalledWith(5001, "SIGKILL");
  });

  it("schedules nothing when there is no detached work to reap", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([]),
      makeLineage({ 1000: [] })
    );

    killer.reapAfterRootExit();
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("is a no-op without a ledger", () => {
    const pty = makePty(1000);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([1001]));

    killer.reapAfterRootExit();
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("abort() cancels the pending escalation", () => {
    const killer = new ProcessTreeKiller(
      makePty(1000),
      makeTreeCache([], { 1000: [], 5001: [] }),
      makeLineage({ 1000: [5001] })
    );

    killer.reapAfterRootExit();
    killSpy.mockClear();
    killer.abort();
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
  });
});

/**
 * Fixture PIDs, shifted clear of this worker and its parent: the killer refuses
 * to signal either, so a collision would silently change what a test sees.
 */
const PID_OFFSET = (() => {
  let offset = 0;
  const own = [process.pid, process.ppid];
  while (own.some((pid) => pid >= 1000 + offset && pid < 6000 + offset)) offset += 100_000;
  return offset;
})();
const P = (pid: number): number => pid + PID_OFFSET;

type CensusRow = [pid: number, ppid: number, startTime: string];

function makeCensus(rows: CensusRow[]): KillCensus {
  const start = new Map(rows.map(([pid, , st]) => [pid, st]));
  return {
    startTimeOf: (pid) => start.get(pid),
    childrenOf: (pid) => rows.filter(([, ppid]) => ppid === pid).map(([p]) => p),
  };
}

/**
 * Ledger stand-in that hands out censuses in order, one per kill-time read.
 * `verifyCalls` records the census each verification received.
 */
function makeCensusLineage(
  censuses: Array<KillCensus | null>,
  tracked: Record<number, Array<[pid: number, startTime: string]>> = {}
): LineageKillSource & {
  takeKillCensus: ReturnType<typeof vi.fn>;
  verifyCalls: Array<KillCensus | null | undefined>;
} {
  const verifyCalls: Array<KillCensus | null | undefined> = [];
  let next = 0;
  return {
    verifyCalls,
    registerRoot: () => {},
    markRootClosing: () => {},
    getVerifiedOrphanPids: (rootPid, alreadyCovered, census) => {
      verifyCalls.push(census);
      const covered = new Set(alreadyCovered);
      return (tracked[rootPid] ?? [])
        .filter(([pid, st]) => !covered.has(pid) && census?.startTimeOf(pid) === st)
        .map(([pid]) => pid);
    },
    takeKillCensus: vi.fn(() => (next < censuses.length ? censuses[next++] : null)),
  };
}

function signalsOf(killSpy: ReturnType<typeof vi.spyOn>, sig: NodeJS.Signals): number[] {
  return killSpy.mock.calls.filter((c: unknown[]) => c[1] === sig).map((c: unknown[]) => c[0]);
}

// #13165: the periodic census is seconds stale, so a kill that trusted it alone
// missed anything spawned since its last sweep — including detached agent work
// that leaves the terminal's session.
describe.skipIf(process.platform === "win32")("ProcessTreeKiller — kill-time census", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy?.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  // Shell P(1000) → agent P(2001) → detached `zsh -c "npm run dev"` P(2002) → npm P(2003).
  const tree: CensusRow[] = [
    [P(1000), 1, "shell"],
    [P(2001), P(1000), "agent"],
    [P(2002), P(2001), "zsh"],
    [P(2003), P(2002), "npm"],
  ];

  it("SIGTERMs a tree the cached census has never seen, leaves first", () => {
    const killer = new ProcessTreeKiller(
      makePty(P(1000)),
      makeTreeCache([]),
      makeCensusLineage([makeCensus(tree)])
    );

    killer.execute(false);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(2003), P(2002), P(2001)]);
    expect(signalsOf(killSpy, "SIGCONT")).toEqual([P(2003), P(2002), P(2001), P(1000)]);
  });

  it("SIGKILLs targets that reparented to PID 1, and what they forked in the grace window", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      // The agent and shell died on SIGTERM/SIGHUP; their detached children
      // were reparented, and npm forked a dev server meanwhile.
      makeCensus([
        [P(2002), 1, "zsh"],
        [P(2003), P(2002), "npm"],
        [P(2004), P(2003), "vite"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    const killed = signalsOf(killSpy, "SIGKILL");
    expect(new Set(killed)).toEqual(new Set([P(2002), P(2003), P(2004)]));
    expect(killed.indexOf(P(2004))).toBeLessThan(killed.indexOf(P(2003)));
    // The shell is gone from the census, so its PID may already be reused.
    expect(killed).not.toContain(P(1000));
  });

  it("never SIGKILLs a target whose PID was recycled during the grace window", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([
        [P(2002), 1, "someone-else"],
        [P(2005), P(2002), "their-child"],
        [P(1000), 1, "also-someone-else"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(signalsOf(killSpy, "SIGKILL")).toEqual([]);
  });

  it("SIGKILLs a surviving shell and its fresh children only while it is the same process", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([...tree, [P(2006), P(1000), "late-child"]]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    const killed = signalsOf(killSpy, "SIGKILL");
    expect(new Set(killed)).toEqual(new Set([P(2001), P(2002), P(2003), P(2006), P(1000)]));
    expect(killed[killed.length - 1]).toBe(P(1000));
  });

  it("uses the tree captured before PTY release, not one read after the hangup", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      // What a read after destroyPty() could see: the agent died of SIGHUP and
      // the detached work is no longer under the shell.
      makeCensus([
        [P(1000), 1, "shell"],
        [P(2002), 1, "zsh"],
        [P(2003), P(2002), "npm"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.captureTree();
    killer.execute(false);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(2003), P(2002), P(2001)]);
    expect(lineage.takeKillCensus).toHaveBeenCalledTimes(1);
  });

  it("ignores a captured tree that has gone stale", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([
        [P(1000), 1, "shell"],
        [P(2010), P(1000), "newer"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.captureTree();
    vi.advanceTimersByTime(5_000);
    killer.execute(false);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(2010)]);
  });

  it("immediate mode re-reads the table before SIGKILL", () => {
    const lineage = makeCensusLineage([makeCensus(tree), makeCensus(tree)]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(true);

    expect(new Set(signalsOf(killSpy, "SIGKILL"))).toEqual(
      new Set([P(2001), P(2002), P(2003), P(1000)])
    );
    expect(lineage.takeKillCensus).toHaveBeenCalledTimes(2);
  });

  it("immediate mode does not SIGKILL a target replaced during the SIGTERM pass", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([
        [P(1000), 1, "shell"],
        [P(2001), P(1000), "agent"],
        [P(2002), 1, "replacement"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(true);

    expect(new Set(signalsOf(killSpy, "SIGKILL"))).toEqual(new Set([P(2001), P(1000)]));
  });

  it("never adopts a recycled shell PID's tree on a later kill", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([]),
      // Escalation is long over; the shell's PID now belongs to a stranger.
      makeCensus([
        [P(1000), 1, "stranger"],
        [P(2020), P(1000), "strangers-child"],
      ]),
      makeCensus([
        [P(1000), 1, "stranger"],
        [P(2020), P(1000), "strangers-child"],
      ]),
    ]);
    const pty = makePty(P(1000));
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]), lineage);

    killer.execute(false);
    vi.advanceTimersByTime(500);
    killSpy.mockClear();
    vi.mocked(pty.kill).mockClear();
    killer.execute(true);

    expect(killSpy).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("never adopts a PID reused after a census found the shell missing", () => {
    const lineage = makeCensusLineage([
      makeCensus([]),
      makeCensus([]),
      makeCensus([
        [P(1000), 1, "stranger"],
        [P(2020), P(1000), "strangers-child"],
      ]),
      makeCensus([
        [P(1000), 1, "stranger"],
        [P(2020), P(1000), "strangers-child"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    vi.advanceTimersByTime(500);
    killSpy.mockClear();
    killer.execute(true);

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("a repeated kill whose census fails keeps the earlier identities", () => {
    const lineage = makeCensusLineage([makeCensus(tree), null, makeCensus([[P(2002), 1, "zsh"]])]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(signalsOf(killSpy, "SIGKILL")).toEqual([P(2002)]);
  });

  it("does not retry a capture that just failed", () => {
    const lineage = makeCensusLineage([null, makeCensus(tree)]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([P(2001)]), lineage);

    killer.captureTree();
    killer.execute(false);

    expect(lineage.takeKillCensus).toHaveBeenCalledTimes(1);
    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(2001)]);
  });

  it("a repeated kill keeps the targets the first one recorded", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      // Second kill: the agent is gone and its detached child is under PID 1.
      makeCensus([
        [P(1000), 1, "shell"],
        [P(2002), 1, "zsh"],
      ]),
      makeCensus([[P(2002), 1, "zsh"]]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(signalsOf(killSpy, "SIGKILL")).toEqual([P(2002)]);
  });

  it("reapAfterRootExit discards an unused capture", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([
        [P(1000), 1, "shell"],
        [P(2010), P(1000), "newer"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.captureTree();
    killer.reapAfterRootExit();
    killer.execute(false);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(2010)]);
  });

  it("dispose after kill completes the pending escalation instead of restarting", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([
        [P(2002), 1, "zsh"],
        [P(2003), P(2002), "npm"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killSpy.mockClear();
    killer.execute(true);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([]);
    expect(new Set(signalsOf(killSpy, "SIGKILL"))).toEqual(new Set([P(2002), P(2003)]));

    killSpy.mockClear();
    vi.advanceTimersByTime(500);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("verifies ledger orphans against the census and reaps their fresh children", () => {
    const lineage = makeCensusLineage(
      [
        makeCensus([
          [P(1000), 1, "shell"],
          [P(5001), 1, "detached"],
          [P(5002), P(5001), "forked-after-detach"],
        ]),
      ],
      { [P(1000)]: [[P(5001), "detached"]] }
    );
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(5002), P(5001)]);
    expect(lineage.verifyCalls[0]).toBeTruthy();
  });

  it("never signals this process or its parent, even under the shell", () => {
    const lineage = makeCensusLineage([
      makeCensus([
        [P(1000), 1, "shell"],
        [process.pid, P(1000), "self"],
        [process.ppid, P(1000), "parent"],
        [P(2001), P(1000), "agent"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(true);

    const touched = killSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(touched).not.toContain(process.pid);
    expect(touched).not.toContain(process.ppid);
    expect(touched).toContain(P(2001));
  });

  it("terminates on a census with a ppid cycle", () => {
    const lineage = makeCensusLineage([
      makeCensus([
        [P(1000), P(2002), "shell"],
        [P(2001), P(1000), "a"],
        [P(2002), P(2001), "b"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(true);

    expect(signalsOf(killSpy, "SIGTERM")).toEqual([P(2002), P(2001)]);
  });

  it("falls back to the cached walk when no census can be taken", () => {
    const lineage = makeCensusLineage([null, null]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([1001]), lineage);

    killer.execute(false);
    expect(signalsOf(killSpy, "SIGTERM")).toEqual([1001]);

    killSpy.mockClear();
    vi.advanceTimersByTime(500);
    expect(new Set(signalsOf(killSpy, "SIGKILL"))).toEqual(new Set([1001, P(1000)]));
  });

  it("falls back to the cached sweep when the escalation census fails", () => {
    const lineage = makeCensusLineage([makeCensus(tree), null]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([P(2001)]), lineage);

    killer.execute(false);
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(new Set(signalsOf(killSpy, "SIGKILL"))).toEqual(new Set([P(2001), P(1000)]));
  });

  it("leaves the shell PID alone once the census says the shell is gone", () => {
    const lineage = makeCensusLineage(
      [
        makeCensus([
          [P(2001), 1, "stray"],
          [P(5001), 1, "detached"],
        ]),
        makeCensus([[P(5001), 1, "detached"]]),
      ],
      { [P(1000)]: [[P(5001), "detached"]] }
    );
    const pty = makePty(P(1000));
    // The stale cache still lists P(2001) under the shell; it must be ignored.
    const killer = new ProcessTreeKiller(pty, makeTreeCache([P(2001)]), lineage);

    killer.execute(true);

    const touched = new Set(killSpy.mock.calls.map((c: unknown[]) => c[0]));
    expect(touched).toEqual(new Set([P(5001)]));
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("abort() drops the recorded identities with the timer", () => {
    const lineage = makeCensusLineage([makeCensus(tree), makeCensus(tree)]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    killer.abort();
    killSpy.mockClear();
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
    expect(lineage.takeKillCensus).toHaveBeenCalledTimes(1);
  });
});

// Windows: every tree kill is the verified helper (fresh creation-time walk,
// handle-checked identities, wait for exit) — never `taskkill /T`, never a
// bare-PID kill from here. PIDs sit far above any real PID on the test host.
describe("ProcessTreeKiller — Windows", () => {
  const SHELL = 7_000_400;
  const OTHER_SHELL = 7_000_500;
  const ORPHAN = 7_000_401;
  const ORPHAN_START = "2026-10-12T10:00:10.0000000+02:00";
  const SHELL_MICROS = 1_760_256_000_123_456;
  let killSpy: MockInstance<typeof process.kill>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const SHELL_START = "2026-10-12T10:00:00.1234560+02:00";
  const SHELL_START_MICROS = identityMicros(SHELL_START)!;

  /** A ledger that has also seen `SHELL` itself in a census, under `SHELL_START`. */
  function identifiedLineage() {
    return {
      ...makeWindowsLineage(),
      getRootStartTime: vi.fn((rootPid: number) => (rootPid === SHELL ? SHELL_START : undefined)),
    };
  }

  /** A shell with no identity yet: named by PID, withdrawn once nothing pins that PID. */
  function unpinned(pid: number) {
    return { pid, withdrawOn: expect.any(AbortSignal) as AbortSignal };
  }

  function result(overrides: Partial<WindowsTreeKillResult> = {}): WindowsTreeKillResult {
    return {
      mode: "tree",
      targeted: [],
      killed: [],
      alreadyGone: [],
      timedOut: [],
      unconfirmed: [],
      failed: [],
      identityMismatch: [],
      stale: [],
      rootEnded: true,
      ...overrides,
    };
  }

  /**
   * Hold every async helper run open until the test settles it. Each run is
   * handed to a helper at once unless `queued`, as one stuck behind another.
   */
  function heldHelper(options: { queued?: boolean } = {}) {
    const runs: Array<{
      resolve: (results: WindowsTreeKillResult[]) => void;
      reject: (error: Error) => void;
    }> = [];
    treeKillMock.mockImplementation(
      (_targets, killOptions) =>
        new Promise((resolve, reject) => {
          if (!options.queued) killOptions?.onStart?.();
          runs.push({ resolve, reject });
        })
    );
    return runs;
  }

  async function settled(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  /** A ledger tracking `ORPHAN` under `SHELL`, whose sync probe must never run on Windows. */
  function makeWindowsLineage() {
    return {
      registerRoot: vi.fn(),
      markRootClosing: vi.fn(),
      getVerifiedOrphanPids: vi.fn(() => {
        throw new Error("Windows must not probe start times on the host thread");
      }),
      getTrackedPids: vi.fn((rootPid: number) =>
        rootPid === SHELL ? [{ pid: ORPHAN, startTime: ORPHAN_START }] : []
      ),
    };
  }

  beforeEach(() => {
    setPlatform("win32");
    treeKillMock.mockReset();
    treeKillSyncMock.mockReset();
    treeKillSyncMock.mockImplementation((targets) => targets.map(() => result()));
    helperRunningMock.mockReset().mockReturnValue(false);
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    flushWindowsExitBatch();
    killSpy.mockRestore();
    warnSpy.mockRestore();
    restorePlatform();
    vi.useRealTimers();
  });

  it("kills the shell and every ledger orphan in one helper run, orphans by identity", () => {
    heldHelper();
    const lineage = makeWindowsLineage();

    const targets = new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), lineage).execute(
      false
    );

    expect(treeKillMock).toHaveBeenCalledTimes(1);
    expect(treeKillMock).toHaveBeenCalledWith(
      [unpinned(SHELL), { pid: ORPHAN, startTime: ORPHAN_START }],
      { timeoutMs: expect.any(Number), onStart: expect.any(Function) }
    );
    expect(lineage.getVerifiedOrphanPids).not.toHaveBeenCalled();
    expect(lineage.markRootClosing).toHaveBeenCalledWith(SHELL);
    expect(treeKillSyncMock).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(targets).toEqual([ORPHAN, SHELL]);
  });

  it.each([false, true])(
    "releases the pseudoconsole only once the helper has finished (immediate=%s)",
    async (immediate) => {
      const runs = heldHelper();
      const pty = makePty(SHELL);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

      killer.execute(immediate);
      await settled();

      // Closing ConPTY ends the shell, and the helper's walk starts from it.
      expect(pty.kill).not.toHaveBeenCalled();
      expect(killer.hasPendingTreeKill()).toBe(true);
      runs[0].resolve([result()]);
      await settled();
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(killer.hasPendingTreeKill()).toBe(false);
      expect(treeKillSyncMock).not.toHaveBeenCalled();
    }
  );

  it("releases the pseudoconsole at the backstop if the helper never reports", () => {
    vi.useFakeTimers();
    heldHelper();
    const pty = makePty(SHELL);

    new ProcessTreeKiller(pty, makeTreeCache([])).execute(false);
    vi.advanceTimersByTime(1000);
    expect(pty.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9000);
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("still releases the pseudoconsole when the helper rejects", async () => {
    const runs = heldHelper();
    const pty = makePty(SHELL);
    (pty.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("pty already exited");
    });

    new ProcessTreeKiller(pty, makeTreeCache([])).execute(false);
    runs[0].reject(new Error("boom"));
    await settled();

    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("joins a pending kill instead of walking the same tree twice", async () => {
    const runs = heldHelper();
    const pty = makePty(SHELL);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    killer.execute(false);
    killer.execute(true);
    killer.reapAfterRootExit();
    expect(treeKillMock).toHaveBeenCalledTimes(1);

    runs[0].resolve([result()]);
    await settled();
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("passes the shell identity its first kill recorded to every later one", async () => {
    const runs = heldHelper();
    const pty = makePty(SHELL);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    killer.execute(false);
    runs[0].resolve([result({ rootStartTime: SHELL_MICROS })]);
    await settled();
    killer.execute(true);

    expect(treeKillMock.mock.calls[1][0]).toEqual([{ pid: SHELL, startTime: SHELL_MICROS }]);
  });

  it.each(["gone", "identity-mismatch"] as const)(
    "never passes the shell PID again once a census found it %s",
    async (mode) => {
      const runs = heldHelper();
      const lineage = makeWindowsLineage();
      const killer = new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), lineage);

      killer.execute(false);
      runs[0].resolve([result({ mode, rootEnded: true }), result()]);
      await settled();
      killer.execute(false);

      expect(treeKillMock.mock.calls[1][0]).toEqual([{ pid: ORPHAN, startTime: ORPHAN_START }]);
    }
  );

  it("reaps a natural exit's orphans without the shell and without touching the pty", async () => {
    const runs = heldHelper();
    const pty = makePty(SHELL);
    const lineage = makeWindowsLineage();
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]), lineage);

    expect(killer.reapAfterRootExit(true)).toEqual([ORPHAN]);
    expect(treeKillMock).toHaveBeenCalledWith([{ pid: ORPHAN, startTime: ORPHAN_START }], {
      timeoutMs: expect.any(Number),
      onStart: expect.any(Function),
    });
    // An orphan reap does not own the pty's release, so a teardown may release it.
    expect(killer.hasPendingTreeKill()).toBe(false);
    runs[0].resolve([result()]);
    await settled();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(lineage.getVerifiedOrphanPids).not.toHaveBeenCalled();
  });

  it("starts nothing for a natural exit with no tracked orphans", () => {
    new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), makeLineage({})).reapAfterRootExit();

    expect(treeKillMock).not.toHaveBeenCalled();
  });

  it("lets kills of different terminals overlap", () => {
    heldHelper();

    new ProcessTreeKiller(makePty(SHELL), makeTreeCache([])).execute(false);
    new ProcessTreeKiller(makePty(OTHER_SHELL), makeTreeCache([])).execute(false);

    expect(treeKillMock.mock.calls.map(([targets]) => targets)).toEqual([
      [unpinned(SHELL)],
      [unpinned(OTHER_SHELL)],
    ]);
  });

  it.each([0, -1, undefined])(
    "releases the pty directly, with no helper, when the shell PID is %s",
    (pid) => {
      const pty = makePty(pid as number);

      new ProcessTreeKiller(pty, makeTreeCache([])).execute(false);

      expect(treeKillMock).not.toHaveBeenCalled();
      expect(pty.kill).toHaveBeenCalledTimes(1);
    }
  );

  it("never reads a kill-time census", () => {
    heldHelper();
    const lineage = { ...makeWindowsLineage(), takeKillCensus: vi.fn(() => null) };
    const killer = new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), lineage);

    killer.captureTree();
    killer.execute(false);

    expect(lineage.takeKillCensus).not.toHaveBeenCalled();
  });

  it("passes the shell identity the ledger recorded, so the kill refuses a reused PID", async () => {
    const runs = heldHelper({ queued: true });
    const killer = new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), identifiedLineage());

    killer.execute(false);
    expect(treeKillMock.mock.calls[0][0]).toEqual([
      { pid: SHELL, startTime: SHELL_START_MICROS },
      { pid: ORPHAN, startTime: ORPHAN_START },
    ]);

    // The kill waited long enough for the PID to change hands, and the helper
    // left the new holder alone.
    runs[0].resolve([result({ mode: "identity-mismatch", rootEnded: true }), result()]);
    await settled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no longer belongs to the shell"));
    killer.execute(false);
    expect(treeKillMock.mock.calls[1][0]).toEqual([{ pid: ORPHAN, startTime: ORPHAN_START }]);
  });

  it("withdraws an unidentified shell still queued when the backstop releases its pseudoconsole", () => {
    vi.useFakeTimers();
    heldHelper({ queued: true });
    const pty = makePty(SHELL);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    killer.execute(false);
    const [shell] = treeKillMock.mock.calls[0][0] as WindowsTreeKillTarget[];
    const killsAtWithdrawal: number[] = [];
    shell.withdrawOn?.addEventListener("abort", () =>
      killsAtWithdrawal.push(vi.mocked(pty.kill).mock.calls.length)
    );
    vi.advanceTimersByTime(5000);
    expect(shell.withdrawOn?.aborted).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(shell.withdrawOn?.aborted).toBe(true);
    // Withdrawn first, then the pseudoconsole closes and the shell with it.
    expect(killsAtWithdrawal).toEqual([0]);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    // Nothing pins that PID any more: no later kill names it.
    killer.execute(true);
    expect(treeKillMock).toHaveBeenCalledTimes(1);
  });

  it("withdraws it, and never names the shell again, once node-pty reports the exit", () => {
    heldHelper({ queued: true });
    let reportExit: (() => void) | undefined;
    const pty = Object.assign(makePty(SHELL), {
      onExit: (listener: () => void) => {
        reportExit = listener;
        return { dispose: () => {} };
      },
    });
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]), makeWindowsLineage());

    killer.execute(false);
    const [shell] = treeKillMock.mock.calls[0][0] as WindowsTreeKillTarget[];
    reportExit?.();

    expect(shell.withdrawOn?.aborted).toBe(true);
    beginWindowsExitBatch();
    killer.execute(true);
    flushWindowsExitBatch();
    expect(treeKillSyncMock.mock.calls[0][0]).toEqual([{ pid: ORPHAN, startTime: ORPHAN_START }]);
  });

  describe("exit batch", () => {
    it("kills every terminal's tree in one blocking run, then releases each pty", () => {
      const ptys = [makePty(SHELL), makePty(OTHER_SHELL)];
      const lineage = makeWindowsLineage();

      beginWindowsExitBatch();
      new ProcessTreeKiller(ptys[0], makeTreeCache([]), lineage).execute(true);
      new ProcessTreeKiller(ptys[1], makeTreeCache([])).execute(true);
      expect(treeKillSyncMock).not.toHaveBeenCalled();
      expect(ptys[0].kill).not.toHaveBeenCalled();
      flushWindowsExitBatch();

      expect(treeKillMock).not.toHaveBeenCalled();
      expect(treeKillSyncMock).toHaveBeenCalledTimes(1);
      expect(treeKillSyncMock.mock.calls[0][0]).toEqual([
        unpinned(SHELL),
        { pid: ORPHAN, startTime: ORPHAN_START },
        unpinned(OTHER_SHELL),
      ]);
      // Fits inside Main's 3 s force-kill deadline for the host.
      expect(treeKillSyncMock.mock.calls[0][1]?.timeoutMs).toBeLessThan(3000);
      const helperOrder = treeKillSyncMock.mock.invocationCallOrder[0];
      for (const pty of ptys) {
        const kill = pty.kill as ReturnType<typeof vi.fn>;
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill.mock.invocationCallOrder[0]).toBeGreaterThan(helperOrder);
      }
    });

    it("owns the pty's release while queued, so a teardown leaves it to the flush", () => {
      const pty = makePty(SHELL);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

      beginWindowsExitBatch();
      killer.execute(true);
      expect(killer.hasPendingTreeKill()).toBe(true);
      flushWindowsExitBatch();

      expect(killer.hasPendingTreeKill()).toBe(false);
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("never walks a shell's bare PID again while its first kill is pending", async () => {
      // That kill may already have ended the shell and freed its PID; it alone
      // knows which process the PID named. Its ledger orphans carry their own
      // identities and are repeated.
      const runs = heldHelper();
      const pty = makePty(SHELL);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]), makeWindowsLineage());

      killer.execute(false);
      beginWindowsExitBatch();
      killer.execute(true);
      flushWindowsExitBatch();

      expect(treeKillSyncMock.mock.calls[0][0]).toEqual([{ pid: ORPHAN, startTime: ORPHAN_START }]);
      expect(pty.kill).toHaveBeenCalledTimes(1);
      runs[0].resolve([result()]);
      await settled();
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("kills a shell itself when its first kill never left this process's queue", () => {
      // Nothing has touched that shell, and the queued kill would never run
      // once the host exits.
      heldHelper({ queued: true });
      const pty = makePty(SHELL);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

      killer.execute(false);
      beginWindowsExitBatch();
      killer.execute(true);
      flushWindowsExitBatch();

      expect(treeKillSyncMock.mock.calls[0][0]).toEqual([unpinned(SHELL)]);
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("never names a shell again once a kill of it ended without an identity", async () => {
      const runs = heldHelper();
      const lineage = makeWindowsLineage();
      const killer = new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), lineage);

      killer.execute(false);
      runs[0].resolve([result({ mode: "untouched", rootEnded: false }), result()]);
      await settled();
      killer.execute(true);

      // Its pseudoconsole has been released since, ending the shell: the PID
      // may name anything now.
      expect(treeKillMock.mock.calls[1][0]).toEqual([{ pid: ORPHAN, startTime: ORPHAN_START }]);
    });

    it("waits for a shell's pending first kill, and releases its pty after it", async () => {
      helperRunningMock.mockReturnValue(true);
      const runs = heldHelper();
      const pty = makePty(SHELL);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

      killer.execute(false);
      beginWindowsExitBatch();
      killer.execute(true);
      let flushed = false;
      const flushing = flushWindowsExitBatchAsync().then(() => (flushed = true));
      await settled();

      expect(treeKillMock).toHaveBeenCalledTimes(1);
      expect(treeKillSyncMock).not.toHaveBeenCalled();
      expect(pty.kill).not.toHaveBeenCalled();
      expect(flushed).toBe(false);

      runs[0].resolve([result()]);
      await flushing;
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("repeats a pending shell's kill once its identity is known", async () => {
      const runs = heldHelper();
      const pty = makePty(SHELL);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

      killer.execute(false);
      runs[0].resolve([result({ rootStartTime: SHELL_MICROS })]);
      await settled();
      killer.execute(false);
      beginWindowsExitBatch();
      killer.execute(true);
      flushWindowsExitBatch();

      expect(treeKillSyncMock.mock.calls[0][0]).toEqual([{ pid: SHELL, startTime: SHELL_MICROS }]);
    });

    it("queues a natural exit's orphan reap without releasing the pty", () => {
      const pty = makePty(SHELL);

      beginWindowsExitBatch();
      new ProcessTreeKiller(pty, makeTreeCache([]), makeWindowsLineage()).reapAfterRootExit(true);
      flushWindowsExitBatch();

      expect(treeKillSyncMock.mock.calls[0][0]).toEqual([{ pid: ORPHAN, startTime: ORPHAN_START }]);
      expect(pty.kill).not.toHaveBeenCalled();
    });

    it("starts nothing when nothing was queued, and nothing at all off Windows", () => {
      beginWindowsExitBatch();
      flushWindowsExitBatch();
      expect(treeKillSyncMock).not.toHaveBeenCalled();

      setPlatform("linux");
      beginWindowsExitBatch();
      setPlatform("win32");
      heldHelper();
      new ProcessTreeKiller(makePty(SHELL), makeTreeCache([])).execute(true);
      // No batch was opened off Windows, so the kill ran on its own.
      expect(treeKillMock).toHaveBeenCalledTimes(1);
      flushWindowsExitBatch();
      expect(treeKillSyncMock).not.toHaveBeenCalled();
    });

    it("sends the batch to the warm helper as one request and awaits it", async () => {
      helperRunningMock.mockReturnValue(true);
      const runs = heldHelper();
      const ptys = [makePty(SHELL), makePty(OTHER_SHELL)];

      beginWindowsExitBatch();
      new ProcessTreeKiller(ptys[0], makeTreeCache([]), makeWindowsLineage()).execute(true);
      new ProcessTreeKiller(ptys[1], makeTreeCache([])).execute(true);
      let flushed = false;
      const flushing = flushWindowsExitBatchAsync().then(() => (flushed = true));
      await settled();

      // A cold blocking PowerShell is what missed the deadline at quit.
      expect(treeKillSyncMock).not.toHaveBeenCalled();
      expect(treeKillMock).toHaveBeenCalledTimes(1);
      expect(treeKillMock.mock.calls[0][0]).toEqual([
        unpinned(SHELL),
        { pid: ORPHAN, startTime: ORPHAN_START },
        unpinned(OTHER_SHELL),
      ]);
      expect(treeKillMock.mock.calls[0][1]?.timeoutMs).toBeLessThan(3000);
      expect(ptys[0].kill).not.toHaveBeenCalled();
      expect(flushed).toBe(false);

      runs[0].resolve([result(), result(), result()]);
      await flushing;
      for (const pty of ptys) expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("runs the blocking one-shot when no helper is running", async () => {
      const pty = makePty(SHELL);

      beginWindowsExitBatch();
      new ProcessTreeKiller(pty, makeTreeCache([])).execute(true);
      await flushWindowsExitBatchAsync();

      expect(treeKillMock).not.toHaveBeenCalled();
      expect(treeKillSyncMock).toHaveBeenCalledTimes(1);
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("releases every pty once the exit budget runs out on a helper that never answers", async () => {
      vi.useFakeTimers();
      helperRunningMock.mockReturnValue(true);
      heldHelper();
      const pty = makePty(SHELL);

      beginWindowsExitBatch();
      new ProcessTreeKiller(pty, makeTreeCache([])).execute(true);
      const flushing = flushWindowsExitBatchAsync();
      await vi.advanceTimersByTimeAsync(2000);
      expect(pty.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      await flushing;

      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(treeKillSyncMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("did not finish within"));
    });

    it("releases every pty even when the blocking run throws", () => {
      treeKillSyncMock.mockImplementation(() => {
        throw new Error("EMFILE");
      });
      const pty = makePty(SHELL);

      beginWindowsExitBatch();
      new ProcessTreeKiller(pty, makeTreeCache([])).execute(true);
      expect(() => flushWindowsExitBatch()).not.toThrow();

      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("reports nothing left once every root is confirmed ended", async () => {
      helperRunningMock.mockReturnValue(true);
      const runs = heldHelper();

      beginWindowsExitBatch();
      new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]), identifiedLineage()).execute(true);
      const flushing = flushWindowsExitBatchAsync();
      await settled();
      runs[0].resolve([result(), result()]);

      expect(await flushing).toEqual({ unfinished: [], abandoned: 0 });
    });

    it("hands back what a batch stuck behind a slow run never confirmed", async () => {
      // The helper dies with this host, so a queued batch would never run: its
      // identified roots must go to Main, and the rest are reported abandoned.
      vi.useFakeTimers();
      helperRunningMock.mockReturnValue(true);
      heldHelper({ queued: true });
      const ptys = [makePty(SHELL), makePty(OTHER_SHELL)];

      beginWindowsExitBatch();
      new ProcessTreeKiller(ptys[0], makeTreeCache([]), identifiedLineage()).execute(true);
      new ProcessTreeKiller(ptys[1], makeTreeCache([])).execute(true);
      const flushing = flushWindowsExitBatchAsync();
      const batch = treeKillMock.mock.calls[0][0] as WindowsTreeKillTarget[];
      const withdrawnBeforeRelease: boolean[] = [];
      batch[2].withdrawOn?.addEventListener("abort", () =>
        withdrawnBeforeRelease.push(vi.mocked(ptys[1].kill).mock.calls.length === 0)
      );
      await vi.advanceTimersByTimeAsync(2500);
      const outcome = await flushing;

      expect(outcome.unfinished).toEqual([
        { pid: SHELL, startTime: SHELL_START_MICROS },
        { pid: ORPHAN, startTime: identityMicros(ORPHAN_START) },
      ]);
      expect(outcome.abandoned).toBe(1);
      // The bare-PID shell is taken out of the queue before its pseudoconsole
      // closes: nothing pins its PID after that.
      expect(withdrawnBeforeRelease).toEqual([true]);
      for (const pty of ptys) expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("counts a joined first kill that never settled as abandoned", async () => {
      vi.useFakeTimers();
      helperRunningMock.mockReturnValue(true);
      heldHelper();
      const killer = new ProcessTreeKiller(makePty(SHELL), makeTreeCache([]));

      killer.execute(false);
      beginWindowsExitBatch();
      killer.execute(true);
      const flushing = flushWindowsExitBatchAsync();
      await vi.advanceTimersByTimeAsync(2500);

      expect(await flushing).toEqual({ unfinished: [], abandoned: 1 });
    });
  });
});

// #13168: the survivor check needs every process a kill signalled, by identity.
describe.skipIf(process.platform === "win32")("ProcessTreeKiller — kill identities", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy?.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  const tree: CensusRow[] = [
    [P(1000), 1, "shell"],
    [P(2001), P(1000), "agent"],
    [P(2002), P(2001), "npm"],
  ];

  it("returns the targets and records the shell and descendants by start time", () => {
    const killer = new ProcessTreeKiller(
      makePty(P(1000)),
      makeTreeCache([]),
      makeCensusLineage([makeCensus(tree)])
    );

    const targets = killer.execute(false);

    expect(targets).toEqual([P(2002), P(2001), P(1000)]);
    expect([...killer.getKillIdentities()]).toEqual(
      expect.arrayContaining([
        [P(1000), "shell"],
        [P(2001), "agent"],
        [P(2002), "npm"],
      ])
    );
  });

  it("adds what escalation found forked in the grace window", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([
        [P(2002), 1, "npm"],
        [P(2003), P(2002), "vite"],
      ]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    vi.advanceTimersByTime(500);

    expect(killer.getKillIdentities().get(P(2003))).toBe("vite");
    expect(killer.getKillIdentities().size).toBe(4);
  });

  it("leaves the shell out of the targets once the census shows it gone", () => {
    const killer = new ProcessTreeKiller(
      makePty(P(1000)),
      makeTreeCache([]),
      makeCensusLineage([makeCensus([[P(2002), 1, "npm"]])], { [P(1000)]: [[P(2002), "npm"]] })
    );

    const targets = killer.execute(false);

    expect(targets).toEqual([P(2002)]);
    expect(killer.getKillIdentities().has(P(1000))).toBe(false);
  });

  it("never records a recycled shell PID on a repeated kill", () => {
    const lineage = makeCensusLineage([
      makeCensus(tree),
      makeCensus([]),
      makeCensus([[P(1000), 1, "someone-else"]]),
    ]);
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    killer.execute(false);
    vi.advanceTimersByTime(500);
    const targets = killer.execute(true);

    expect(targets).not.toContain(P(1000));
    expect(killer.getKillIdentities().get(P(1000))).toBe("shell");
  });

  it("records nothing without a census", () => {
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([P(2001)]));

    expect(killer.execute(false)).toEqual([P(2001), P(1000)]);
    expect(killer.getKillIdentities().size).toBe(0);
  });

  it("identifies the orphans a root-exit reap targets", () => {
    const lineage = {
      ...makeLineage({ [P(1000)]: [P(2002)] }),
      takeKillCensus: () => makeCensus([[P(2002), 1, "npm"]]),
    };
    const killer = new ProcessTreeKiller(makePty(P(1000)), makeTreeCache([]), lineage);

    expect(killer.reapAfterRootExit()).toEqual([P(2002)]);
    expect(killer.getKillIdentities().get(P(2002))).toBe("npm");
  });
});
