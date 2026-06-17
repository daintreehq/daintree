import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import type { IPty } from "node-pty";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import { ProcessTreeKiller } from "../ProcessTreeKiller.js";

vi.mock("child_process", () => ({ spawnSync: vi.fn() }));

const spawnSyncMock = vi.mocked(spawnSync);

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

function makeTreeCache(descendants: number[]): ProcessTreeCache {
  return {
    getDescendantPids: () => descendants,
  } as unknown as ProcessTreeCache;
}

function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(message ?? code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// The POSIX SIGTERM/SIGCONT/SIGKILL escalation is Unix-only (Windows uses
// taskkill). Skip the whole suite on Windows so it reports as skipped rather
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

// Windows uses `taskkill /T /F /PID` to tear down the whole tree atomically
// rather than the POSIX signal cascade. This branch had ZERO coverage: the
// suite above early-returned on win32, so on a Windows dev machine the kill
// path was never asserted. These tests drive the win32 branch under a mocked
// platform + mocked spawnSync — no real process is killed.
describe("ProcessTreeKiller — Windows taskkill", () => {
  let killSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 } as never);
    setPlatform("win32");
  });

  afterEach(() => {
    killSpy?.mockRestore();
    killSpy = undefined;
    restorePlatform();
  });

  it("kills the tree with taskkill /T /F /PID and the documented options", () => {
    const pty = makePty(4321);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([4322, 4323]));

    killer.execute(true);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith("taskkill", ["/T", "/F", "/PID", "4321"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 3000,
    });
  });

  it("calls ptyProcess.kill() after taskkill", () => {
    const pty = makePty(4321);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    killer.execute(true);

    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("never sends POSIX signals on Windows", () => {
    killSpy = vi.spyOn(process, "kill");
    const pty = makePty(4321);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([4322, 4323]));

    killer.execute(true);

    // The Unix SIGTERM/SIGCONT/SIGKILL cascade must not run on Windows.
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("swallows a thrown taskkill and still calls ptyProcess.kill()", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("taskkill: process already exited");
    });
    const pty = makePty(4321);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    expect(() => killer.execute(true)).not.toThrow();
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("swallows a thrown ptyProcess.kill() after taskkill", () => {
    const pty = makePty(4321);
    (pty.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("pty already exited");
    });
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    expect(() => killer.execute(true)).not.toThrow();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1])(
    "short-circuits to ptyProcess.kill() without taskkill when shellPid is %i",
    (pid) => {
      const pty = makePty(pid);
      const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

      killer.execute(true);

      // shellPid <= 0 returns before the platform branch — no taskkill.
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(pty.kill).toHaveBeenCalledTimes(1);
    }
  );

  it("short-circuits to ptyProcess.kill() without taskkill when shellPid is undefined", () => {
    const pty = makePty(undefined as unknown as number);
    const killer = new ProcessTreeKiller(pty, makeTreeCache([]));

    killer.execute(true);

    // The `shellPid === undefined` guard returns before the platform branch.
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });
});
