import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpSessionJobService } from "../HelpSessionJobService.js";

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

describe("HelpSessionJobService (#7526, #8769)", () => {
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
      const svc = new HelpSessionJobService(addon, { reaper: null, spawn });

      svc.attachHelpSessionPid(1234);

      expect(calls).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe("Windows (#7526)", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("forwards a valid PID to the native addon and remembers the attach", () => {
      const { addon, calls } = makeNative({ result: true });
      const svc = new HelpSessionJobService(addon);

      svc.attachHelpSessionPid(4242);

      expect(calls).toEqual([4242]);
      expect(svc.getAttachedPidsForTest().has(4242)).toBe(true);
    });

    it("skips duplicate PIDs without re-invoking the native addon", () => {
      const { addon, calls } = makeNative({ result: true });
      const svc = new HelpSessionJobService(addon);

      svc.attachHelpSessionPid(4242);
      svc.attachHelpSessionPid(4242);
      svc.attachHelpSessionPid(4242);

      expect(calls).toEqual([4242]);
    });

    it("rejects non-integer / non-finite / negative / zero PIDs without calling the addon", () => {
      const { addon } = makeNative({ result: true });
      const svc = new HelpSessionJobService(addon);

      svc.attachHelpSessionPid(0);
      svc.attachHelpSessionPid(-1);
      svc.attachHelpSessionPid(1.5);
      svc.attachHelpSessionPid(Number.NaN);
      svc.attachHelpSessionPid(Number.POSITIVE_INFINITY);

      expect(addon.assignProcessToHelpJob).not.toHaveBeenCalled();
    });

    it("memos a failed attach so it isn't retried (race: process exited)", () => {
      const { addon, calls } = makeNative({ result: false });
      const svc = new HelpSessionJobService(addon);

      svc.attachHelpSessionPid(4242);
      svc.attachHelpSessionPid(4242);

      expect(calls).toEqual([4242]);
    });

    it("logs a single warning on the first attach failure and stays quiet on subsequent ones", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { addon } = makeNative({ result: false });
      const svc = new HelpSessionJobService(addon);

      svc.attachHelpSessionPid(1);
      svc.attachHelpSessionPid(2);
      svc.attachHelpSessionPid(3);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("survives a thrown native error and logs the failure", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { addon } = makeNative({ throwErr: new Error("native boom") });
      const svc = new HelpSessionJobService(addon);

      expect(() => svc.attachHelpSessionPid(7777)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("warns once when the native addon is unavailable", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const svc = new HelpSessionJobService(null);

      svc.attachHelpSessionPid(1);
      svc.attachHelpSessionPid(2);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does not spawn a POSIX supervisor on Windows", () => {
      const { addon } = makeNative({ result: true });
      const { spawn, reaper } = makePosix();
      const svc = new HelpSessionJobService(addon, { reaper, spawn });

      svc.attachHelpSessionPid(4242);

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
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          expect(spawn).not.toHaveBeenCalled();

          svc.attachHelpSessionPid(4242);

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

        it("spawns the supervisor only once across multiple attaches", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(10);
          svc.attachHelpSessionPid(20);
          svc.attachHelpSessionPid(30);

          expect(spawn).toHaveBeenCalledTimes(1);
          expect(writes).toEqual(["ADD 10\n", "ADD 20\n", "ADD 30\n"]);
        });

        it("skips duplicate PIDs without re-writing", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(777);
          svc.attachHelpSessionPid(777);

          expect(writes).toEqual(["ADD 777\n"]);
        });

        it("rejects invalid PIDs without spawning", () => {
          const { spawn, reaper } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(0);
          svc.attachHelpSessionPid(-1);
          svc.attachHelpSessionPid(1.5);
          svc.attachHelpSessionPid(Number.NaN);

          expect(spawn).not.toHaveBeenCalled();
        });

        it("warns once and stays a no-op when the supervisor is unavailable", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn, reaper } = makePosix({ available: false });
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(1);
          svc.attachHelpSessionPid(2);

          expect(spawn).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("warns once when no reaper module is loaded", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper: null, spawn });

          svc.attachHelpSessionPid(1);
          svc.attachHelpSessionPid(2);

          expect(spawn).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("survives a supervisor spawn failure without crashing or retrying", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn, reaper } = makePosix({ spawnThrows: true });
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          expect(() => svc.attachHelpSessionPid(1)).not.toThrow();
          svc.attachHelpSessionPid(2);

          expect(spawn).toHaveBeenCalledTimes(1); // not retried
          expect(warnSpy).toHaveBeenCalled();
        });

        it("survives a stdin write failure and warns once", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const { spawn, reaper } = makePosix({ stdinWriteThrows: true });
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          expect(() => svc.attachHelpSessionPid(1)).not.toThrow();
          svc.attachHelpSessionPid(2);

          expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("dispose() disarms the supervisor and closes the pipe", () => {
          const { spawn, reaper, writes, stdin } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(4242);
          svc.dispose();

          expect(writes).toEqual(["ADD 4242\n", "DISARM\n"]);
          expect(stdin.end).toHaveBeenCalledTimes(1);
        });

        it("dispose() is idempotent", () => {
          const { spawn, reaper, stdin } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(4242);
          svc.dispose();
          svc.dispose();

          expect(stdin.end).toHaveBeenCalledTimes(1);
        });

        it("dispose() before any attach does not throw", () => {
          const { spawn, reaper } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          expect(() => svc.dispose()).not.toThrow();
          expect(spawn).not.toHaveBeenCalled();
        });

        it("attaching after dispose is a no-op", () => {
          const { spawn, reaper, writes } = makePosix();
          const svc = new HelpSessionJobService(null, { reaper, spawn });

          svc.attachHelpSessionPid(4242);
          svc.dispose();
          svc.attachHelpSessionPid(9999);

          expect(writes).toEqual(["ADD 4242\n", "DISARM\n"]);
        });
      });
    }
  });
});
