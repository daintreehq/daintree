import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalCrashReapService } from "../TerminalCrashReapService.js";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function makeNative(overrides: Partial<{ result: boolean; throwErr: unknown }> = {}) {
  const calls: number[] = [];
  return {
    calls,
    addon: {
      assignProcessToHelpJob: vi.fn((pid: number) => {
        calls.push(pid);
        if (overrides.throwErr !== undefined) throw overrides.throwErr;
        return overrides.result ?? true;
      }),
      isAvailable: () => true,
      getLoadError: () => null,
    },
  };
}

function makePosix(
  opts: {
    available?: boolean;
    spawnThrows?: boolean;
    stdinWriteThrows?: boolean;
    path?: string | null;
  } = {}
) {
  const writes: string[] = [];
  const stdin = {
    write: vi.fn((s: string) => {
      if (opts.stdinWriteThrows) throw new Error("EPIPE");
      writes.push(s);
      return true;
    }),
    end: vi.fn(),
    on: vi.fn(),
    unref: vi.fn(),
  };
  const child = {
    stdin,
    unref: vi.fn(),
    on: vi.fn(),
  };
  const spawn = vi.fn(() => {
    if (opts.spawnThrows) throw new Error("spawn failed");
    return child;
  });
  const reaper = {
    getSupervisorPath: vi.fn(() =>
      opts.path === undefined ? "/path/to/daintree_pty_supervisor" : opts.path
    ),
    isAvailable: vi.fn(() => opts.available ?? true),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { writes, stdin, child, spawn: spawn as any, reaper };
}

describe("TerminalCrashReapService (#7526, #8769, #13176)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  describe("unsupported platforms", () => {
    it("is a no-op on an unrecognized platform", () => {
      setPlatform("freebsd" as NodeJS.Platform);
      const { addon, calls } = makeNative();
      const { spawn } = makePosix();
      const svc = new TerminalCrashReapService(addon, { reaper: null, spawn });

      svc.attachTerminal("t1", 1234);

      expect(calls).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(svc.getTrackedPidsForTest().size).toBe(0);
    });
  });

  describe("Windows (#7526)", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("assigns every terminal's PID to the Job Object and tracks it by id", () => {
      const { addon, calls } = makeNative({ result: true });
      const svc = new TerminalCrashReapService(addon);

      svc.attachTerminal("t1", 4242);
      svc.attachTerminal("t2", 5353);

      expect(calls).toEqual([4242, 5353]);
      expect(svc.getTrackedPidsForTest()).toEqual(
        new Map([
          ["t1", 4242],
          ["t2", 5353],
        ])
      );
    });

    it("does not re-assign a repeated terminal-pid for the same terminal", () => {
      const { addon, calls } = makeNative({ result: true });
      const svc = new TerminalCrashReapService(addon);

      svc.attachTerminal("t1", 4242);
      svc.attachTerminal("t1", 4242);
      svc.attachTerminal("t1", 4242);

      expect(calls).toEqual([4242]);
    });

    it("rejects non-integer / non-finite / negative / zero PIDs without calling the addon", () => {
      const { addon } = makeNative({ result: true });
      const svc = new TerminalCrashReapService(addon);

      svc.attachTerminal("t", 0);
      svc.attachTerminal("t", -1);
      svc.attachTerminal("t", 1.5);
      svc.attachTerminal("t", Number.NaN);
      svc.attachTerminal("t", Number.POSITIVE_INFINITY);

      expect(addon.assignProcessToHelpJob).not.toHaveBeenCalled();
      expect(svc.getTrackedPidsForTest().size).toBe(0);
    });

    it("memos a failed attach so it isn't retried (race: process exited)", () => {
      const { addon, calls } = makeNative({ result: false });
      const svc = new TerminalCrashReapService(addon);

      svc.attachTerminal("t1", 4242);
      svc.attachTerminal("t1", 4242);

      expect(calls).toEqual([4242]);
    });

    it("assigns a recycled PID again once the terminal that held it has exited", () => {
      const { addon, calls } = makeNative({ result: true });
      const svc = new TerminalCrashReapService(addon);

      svc.attachTerminal("t1", 4242);
      svc.detachTerminal("t1");
      svc.attachTerminal("t2", 4242);

      expect(calls).toEqual([4242, 4242]);
      expect(svc.getTrackedPidsForTest()).toEqual(new Map([["t2", 4242]]));
    });

    it("logs a single warning on the first attach failure and stays quiet on subsequent ones", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { addon } = makeNative({ result: false });
      const svc = new TerminalCrashReapService(addon);

      svc.attachTerminal("a", 1);
      svc.attachTerminal("b", 2);
      svc.attachTerminal("c", 3);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("survives a thrown native error and logs the failure", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { addon } = makeNative({ throwErr: new Error("native boom") });
      const svc = new TerminalCrashReapService(addon);

      expect(() => svc.attachTerminal("t1", 7777)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("warns once when the native addon is unavailable", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const svc = new TerminalCrashReapService(null);

      svc.attachTerminal("a", 1);
      svc.attachTerminal("b", 2);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does not spawn a POSIX supervisor on Windows", () => {
      const { addon } = makeNative({ result: true });
      const { spawn, reaper } = makePosix();
      const svc = new TerminalCrashReapService(addon, { reaper, spawn });

      svc.attachTerminal("t1", 4242);
      svc.detachTerminal("t1");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe("POSIX (#8769)", () => {
    for (const platform of ["darwin", "linux"] as const) {
      describe(platform, () => {
        beforeEach(() => {
          setPlatform(platform);
        });

        it("lazily spawns the supervisor on the first attach and streams the PID", () => {
          const { spawn, reaper, writes, child } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          expect(spawn).not.toHaveBeenCalled();

          svc.attachTerminal("t1", 4242);

          expect(spawn).toHaveBeenCalledTimes(1);
          expect(spawn).toHaveBeenCalledWith(
            "/path/to/daintree_pty_supervisor",
            [],
            expect.objectContaining({ detached: true, stdio: ["pipe", "ignore", "ignore"] })
          );
          expect(writes).toEqual(["ADD 4242\n"]);
          expect(child.unref).toHaveBeenCalled();
          expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
          expect(child.stdin.on).toHaveBeenCalledWith("error", expect.any(Function));
        });

        it("spawns the supervisor only once across many terminals", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("a", 10);
          svc.attachTerminal("b", 20);
          svc.attachTerminal("c", 30);

          expect(spawn).toHaveBeenCalledTimes(1);
          expect(writes).toEqual(["ADD 10\n", "ADD 20\n", "ADD 30\n"]);
        });

        it("skips a repeated terminal-pid without re-writing", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 777);
          svc.attachTerminal("t1", 777);

          expect(writes).toEqual(["ADD 777\n"]);
        });

        it("unregisters the PID when the terminal exits", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 4242, 1);
          svc.detachTerminal("t1", 1);
          svc.detachTerminal("t1", 1);

          expect(writes).toEqual(["ADD 4242\n", "REMOVE 4242\n"]);
          expect(svc.getTrackedPidsForTest().size).toBe(0);
        });

        it("replaces the predecessor's PID on a same-id respawn", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 100, 1);
          svc.attachTerminal("t1", 200, 2);

          expect(writes).toEqual(["ADD 100\n", "REMOVE 100\n", "ADD 200\n"]);
          expect(svc.getTrackedPidsForTest()).toEqual(new Map([["t1", 200]]));
        });

        it("ignores a stale exit from the predecessor after a same-id respawn", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 100, 1);
          svc.attachTerminal("t1", 200, 2);
          svc.detachTerminal("t1", 1);

          expect(writes).toEqual(["ADD 100\n", "REMOVE 100\n", "ADD 200\n"]);
          expect(svc.getTrackedPidsForTest()).toEqual(new Map([["t1", 200]]));
        });

        it("ignores a predecessor's PID that arrives after its successor registered", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 200, 2);
          svc.attachTerminal("t1", 100, 1);

          expect(writes).toEqual(["ADD 200\n"]);
          expect(svc.getTrackedPidsForTest()).toEqual(new Map([["t1", 200]]));
        });

        it("a stale same-PID event cannot rewind the generation and detach the live one", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 100, 2);
          svc.attachTerminal("t1", 100, 1);
          svc.detachTerminal("t1", 1);

          expect(writes).toEqual(["ADD 100\n"]);
          expect(svc.getTrackedPidsForTest()).toEqual(new Map([["t1", 100]]));
        });

        it("re-registers a successor that landed on its predecessor's recycled PID", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 100, 1);
          svc.attachTerminal("t1", 100, 2);
          svc.detachTerminal("t1", 1);

          expect(writes).toEqual(["ADD 100\n", "REMOVE 100\n", "ADD 100\n"]);
          expect(svc.getTrackedPidsForTest()).toEqual(new Map([["t1", 100]]));
        });

        it("detaches regardless of generation when either side has none", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("a", 10);
          svc.attachTerminal("b", 20, 3);
          svc.detachTerminal("a", 9);
          svc.detachTerminal("b");

          expect(writes).toEqual(["ADD 10\n", "ADD 20\n", "REMOVE 10\n", "REMOVE 20\n"]);
        });

        it("detaching an unknown terminal is a no-op", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.detachTerminal("nope");
          svc.attachTerminal("t1", 4242);
          svc.detachTerminal("nope");

          expect(writes).toEqual(["ADD 4242\n"]);
        });

        it("rejects invalid PIDs without spawning", () => {
          const { spawn, reaper } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t", 0);
          svc.attachTerminal("t", -1);
          svc.attachTerminal("t", 1.5);
          svc.attachTerminal("t", Number.NaN);

          expect(spawn).not.toHaveBeenCalled();
        });

        it("warns once and stays a no-op when the supervisor is unavailable", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn, reaper } = makePosix({ available: false });
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("a", 1);
          svc.attachTerminal("b", 2);
          svc.detachTerminal("a");

          expect(spawn).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("warns once when no reaper module is loaded", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper: null, spawn });

          svc.attachTerminal("a", 1);
          svc.attachTerminal("b", 2);

          expect(spawn).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("survives a supervisor spawn failure without crashing or retrying", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn, reaper } = makePosix({ spawnThrows: true });
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          expect(() => svc.attachTerminal("a", 1)).not.toThrow();
          svc.attachTerminal("b", 2);

          expect(spawn).toHaveBeenCalledTimes(1); // not retried
          expect(warnSpy).toHaveBeenCalled();
        });

        it("survives stdin write failures and warns once", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn, reaper } = makePosix({ stdinWriteThrows: true });
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          expect(() => svc.attachTerminal("a", 1)).not.toThrow();
          svc.attachTerminal("b", 2);
          expect(() => svc.detachTerminal("a")).not.toThrow();

          expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("dispose() disarms the supervisor and closes the pipe", () => {
          const { spawn, reaper, writes, stdin } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 4242);
          svc.dispose();

          expect(writes).toEqual(["ADD 4242\n", "DISARM\n"]);
          expect(stdin.end).toHaveBeenCalledTimes(1);
        });

        it("dispose() is idempotent", () => {
          const { spawn, reaper, stdin } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 4242);
          svc.dispose();
          svc.dispose();

          expect(stdin.end).toHaveBeenCalledTimes(1);
        });

        it("dispose() swallows a stdin write failure", () => {
          const { spawn, reaper } = makePosix({ stdinWriteThrows: true });
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 4242); // ADD write throws, caught
          expect(() => svc.dispose()).not.toThrow(); // DISARM write throws, caught
        });

        it("dispose() before any attach does not throw", () => {
          const { spawn, reaper } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          expect(() => svc.dispose()).not.toThrow();
          expect(spawn).not.toHaveBeenCalled();
        });

        it("attaching or detaching after dispose writes nothing", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new TerminalCrashReapService(null, { reaper, spawn });

          svc.attachTerminal("t1", 4242);
          svc.dispose();
          svc.attachTerminal("t2", 9999);
          svc.detachTerminal("t1");

          expect(writes).toEqual(["ADD 4242\n", "DISARM\n"]);
        });
      });
    }
  });
});
