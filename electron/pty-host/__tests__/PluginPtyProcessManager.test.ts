import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPtyHostEvent } from "../../../shared/types/pty-host.js";

const spawnMock = vi.fn();

vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args) as unknown,
}));

const { PluginPtyProcessManager } = await import("../services/PluginPtyProcessManager.js");

interface FakePty {
  pid: number;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  destroy?: () => void;
}

/**
 * Fake node-pty handle. Records every native operation so a test can assert the
 * teardown order (`destroy()` before `kill()` — the fd-leak invariant) and that
 * listeners are disposed exactly once.
 */
function makeFakePty(opts?: { pid?: number; destroyThrows?: boolean }) {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  const calls: string[] = [];
  const kills: Array<string | undefined> = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const writes: string[] = [];
  let disposedListeners = 0;

  const pty: FakePty = {
    pid: opts?.pid ?? 777,
    onData: (listener) => {
      dataListeners.add(listener);
      return {
        dispose: () => {
          disposedListeners++;
          dataListeners.delete(listener);
        },
      };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return {
        dispose: () => {
          disposedListeners++;
          exitListeners.delete(listener);
        },
      };
    },
    write: (data) => {
      calls.push("write");
      writes.push(data);
    },
    resize: (cols, rows) => {
      calls.push("resize");
      resizes.push({ cols, rows });
    },
    kill: (signal) => {
      calls.push("kill");
      kills.push(signal);
    },
    destroy: () => {
      calls.push("destroy");
      if (opts?.destroyThrows) throw new Error("already destroyed");
    },
  };

  return {
    pty,
    calls,
    kills,
    resizes,
    writes,
    get disposedListeners() {
      return disposedListeners;
    },
    emitData: (data: string) => {
      for (const l of [...dataListeners]) l(data);
    },
    emitExit: (exitCode: number, signal?: number) => {
      for (const l of [...exitListeners]) l({ exitCode, signal });
    },
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    command: "flutter",
    args: ["daemon", "--machine"],
    cwd: "/repo",
    env: { MY_FLAG: "1" },
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

function makeManager() {
  const events: PluginPtyHostEvent[] = [];
  const manager = new PluginPtyProcessManager((event) => events.push(event));
  return { manager, events };
}

describe("PluginPtyProcessManager", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("spawns with the requested geometry and an allowlisted env", () => {
    const SECRET = "DAINTREE_PTY_TEST_SECRET";
    const prev = process.env[SECRET];
    process.env[SECRET] = "leak-me";
    try {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, events } = makeManager();
      manager.spawn("p1", 0, options());

      const [command, args, spawnOptions] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { cwd?: string; env: Record<string, string>; cols: number; rows: number; name: string },
      ];
      expect(command).toBe("flutter");
      expect(args).toEqual(["daemon", "--machine"]);
      expect(spawnOptions.cols).toBe(80);
      expect(spawnOptions.rows).toBe(24);
      expect(spawnOptions.name).toBe("xterm-256color");
      // Plugin-provided env survives; the host's ambient secret does not.
      expect(spawnOptions.env.MY_FLAG).toBe("1");
      expect(spawnOptions.env[SECRET]).toBeUndefined();
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);

      expect(events).toContainEqual({
        type: "plugin-pty-spawn-result",
        id: "p1",
        generation: 0,
        result: { success: true, pid: 777 },
      });
    } finally {
      if (prev === undefined) delete process.env[SECRET];
      else process.env[SECRET] = prev;
    }
  });

  it("reports a spawn throw as a failed result instead of propagating", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT: flutter");
    });
    const { manager, events } = makeManager();
    expect(() => manager.spawn("p1", 0, options())).not.toThrow();
    expect(events).toEqual([
      {
        type: "plugin-pty-spawn-result",
        id: "p1",
        generation: 0,
        result: { success: false, error: "ENOENT: flutter" },
      },
    ]);
  });

  it("wires output before announcing the spawn, so an eager greeting is not lost", () => {
    const fake = makeFakePty();
    let dataAtAnnounce: string[] = [];
    spawnMock.mockReturnValue(fake.pty);
    const events: PluginPtyHostEvent[] = [];
    const manager = new PluginPtyProcessManager((event) => {
      events.push(event);
      if (event.type === "plugin-pty-spawn-result") {
        // A command that greets the instant it starts: emitting here proves the
        // data listener was attached before the result went out.
        fake.emitData("hello");
        dataAtAnnounce = events
          .filter((e) => e.type === "plugin-pty-data")
          .map((e) => (e.type === "plugin-pty-data" ? e.data : ""));
      }
    });
    manager.spawn("p1", 0, options());
    expect(dataAtAnnounce).toEqual(["hello"]);
  });

  it("forwards data and exit with the spawning generation", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager, events } = makeManager();
    manager.spawn("p1", 7, options());
    fake.emitData("out");
    fake.emitExit(3, 15);

    expect(events).toContainEqual({
      type: "plugin-pty-data",
      id: "p1",
      generation: 7,
      data: "out",
    });
    expect(events).toContainEqual({
      type: "plugin-pty-exit",
      id: "p1",
      generation: 7,
      exitCode: 3,
      signal: 15,
    });
  });

  it("ignores write and resize addressed to a stale generation", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 5, options());
    manager.write("p1", 4, "stale");
    manager.resize("p1", 4, 100, 30);
    expect(fake.writes).toHaveLength(0);
    expect(fake.resizes).toHaveLength(0);
  });

  it("ignores write and resize for an unknown id", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    manager.write("nope", 0, "x");
    manager.resize("nope", 0, 100, 30);
    expect(fake.writes).toHaveLength(0);
    expect(fake.resizes).toHaveLength(0);
  });

  it("never resizes a PTY whose child has already exited", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    fake.emitExit(0);
    manager.resize("p1", 0, 100, 30);
    expect(fake.resizes).toHaveLength(0);
  });

  it("rejects a resize with non-positive or fractional dimensions", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    manager.resize("p1", 0, 0, 24);
    manager.resize("p1", 0, 80, -3);
    manager.resize("p1", 0, 80.5, 24);
    expect(fake.resizes).toHaveLength(0);
    manager.resize("p1", 0, 100, 30);
    expect(fake.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("SIGTERM only signals — it does not release the native handle", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    manager.kill("p1", 0, "SIGTERM");
    // The child gets its chance to exit cleanly; destroy() waits for the exit.
    expect(fake.calls).toEqual(["kill"]);
    expect(fake.kills).toEqual(["SIGTERM"]);
  });

  it("releases the master fd via destroy() before kill() on every teardown route", () => {
    // Unix semantics: Windows has no master fd and takes destroyPty's
    // single-kill branch, asserted separately above.
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      for (const teardown of ["exit", "sigkill", "dispose"] as const) {
        const fake = makeFakePty();
        spawnMock.mockReturnValue(fake.pty);
        const { manager } = makeManager();
        manager.spawn("p1", 0, options());
        if (teardown === "exit") fake.emitExit(0);
        else if (teardown === "sigkill") manager.kill("p1", 0, "SIGKILL");
        else manager.disposeAll();
        // A bare kill() leaks the master fd — destroy() must come first. The
        // SIGKILL route additionally names the signal up front (node-pty's bare
        // kill() is SIGHUP), so its sequence carries a leading kill.
        const expected = teardown === "sigkill" ? ["kill", "destroy", "kill"] : ["destroy", "kill"];
        expect(fake.calls).toEqual(expected);
        expect(fake.disposedListeners).toBe(2);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("SIGKILL sends a real SIGKILL on Unix, not node-pty's SIGHUP default", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager } = makeManager();
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGKILL");
      // destroyPty's bare kill() defaults to SIGHUP in node-pty, which a child
      // that ignores HUP survives — the escalation has to name the signal.
      expect(fake.kills[0]).toBe("SIGKILL");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("issues only one native kill on Windows, where a second double-frees ConPTY", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const fake = makeFakePty();
      // A real WindowsTerminal exposes `_agent`; destroyPty keys its
      // single-kill guard on it, and mocks without it take the Unix path.
      (fake.pty as unknown as { _agent: object })._agent = {};
      spawnMock.mockReturnValue(fake.pty);
      const { manager } = makeManager();
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGKILL");
      // Two native kills on one pseudoconsole is STATUS_HEAP_CORRUPTION (#9551).
      expect(fake.calls.filter((c) => c === "kill")).toHaveLength(1);
      expect(fake.calls).not.toContain("destroy");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("acknowledges a forced teardown so Main is not left waiting for an exit", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager, events } = makeManager();
    manager.spawn("p1", 4, options());
    manager.kill("p1", 4, "SIGKILL");
    // A forced teardown disposes node-pty's onExit before it fires, so without
    // this ack the managed record never leaves `running` and its concurrency
    // slot is never released.
    expect(events.filter((e) => e.type === "plugin-pty-exit")).toEqual([
      { type: "plugin-pty-exit", id: "p1", generation: 4, exitCode: null, signal: 9 },
    ]);
  });

  it("emits exactly one exit when a forced kill races the child's own exit", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager, events } = makeManager();
    manager.spawn("p1", 0, options());
    fake.emitExit(0);
    manager.kill("p1", 0, "SIGKILL");
    manager.disposeAll();
    expect(events.filter((e) => e.type === "plugin-pty-exit")).toHaveLength(1);
  });

  it("acknowledges every live PTY on host disposal", () => {
    const a = makeFakePty();
    const b = makeFakePty();
    spawnMock.mockReturnValueOnce(a.pty).mockReturnValueOnce(b.pty);
    const { manager, events } = makeManager();
    manager.spawn("p1", 0, options());
    manager.spawn("p2", 0, options());
    manager.disposeAll();
    expect(events.filter((e) => e.type === "plugin-pty-exit").map((e) => e.id)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("teardown is idempotent when a kill races the child's own exit", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    fake.emitExit(0);
    manager.kill("p1", 0, "SIGKILL");
    manager.disposeAll();
    // Exactly one destroy/kill pair — a double free would crash the host. The
    // kill after the child already exited is a no-op lookup, not a second free.
    expect(fake.calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect(fake.calls).toEqual(["destroy", "kill"]);
  });

  it("survives a destroy() that throws and still kills", () => {
    const fake = makeFakePty({ destroyThrows: true });
    spawnMock.mockReturnValue(fake.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    expect(() => manager.disposeAll()).not.toThrow();
    expect(fake.calls).toEqual(["destroy", "kill"]);
  });

  it("refuses a duplicate spawn for a live incarnation rather than orphaning it", () => {
    const first = makeFakePty();
    spawnMock.mockReturnValue(first.pty);
    const { manager, events } = makeManager();
    manager.spawn("p1", 0, options());
    manager.spawn("p1", 0, options());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "plugin-pty-spawn-result",
      id: "p1",
      generation: 0,
      result: { success: false, error: 'plugin pty "p1" already running' },
    });
    // The live PTY was left alone, not torn down by the rejected duplicate.
    expect(first.calls).toEqual([]);
  });

  it("supersedes a live predecessor when a newer generation spawns", () => {
    const first = makeFakePty();
    const second = makeFakePty();
    spawnMock.mockReturnValueOnce(first.pty).mockReturnValueOnce(second.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    manager.spawn("p1", 1, options());

    // The predecessor went through the teardown chokepoint.
    expect(first.calls).toEqual(["destroy", "kill"]);
    // The successor is live and addressable at its own generation.
    manager.write("p1", 1, "hi");
    expect(second.writes).toEqual(["hi"]);
  });

  it("disposeAll tears down every live PTY", () => {
    const a = makeFakePty();
    const b = makeFakePty();
    spawnMock.mockReturnValueOnce(a.pty).mockReturnValueOnce(b.pty);
    const { manager } = makeManager();
    manager.spawn("p1", 0, options());
    manager.spawn("p2", 0, options());
    manager.disposeAll();
    expect(a.calls).toEqual(["destroy", "kill"]);
    expect(b.calls).toEqual(["destroy", "kill"]);
  });
});

describe("PluginPtyProcessManager process-tree teardown (#13173)", () => {
  type Target = { readonly pid: number; kill(signal?: string): void };

  function makeTreeManager() {
    const events: PluginPtyHostEvent[] = [];
    const targets: Target[] = [];
    const killer = {
      execute: vi.fn<(immediate: boolean, delayMs?: number) => void>(),
      reapAfterRootExit: vi.fn<(immediate?: boolean, delayMs?: number) => void>(),
      registerRoot: vi.fn<(pid: number | undefined) => void>(),
    };
    const manager = new PluginPtyProcessManager(
      (event) => events.push(event),
      (target) => {
        targets.push(target);
        return killer;
      }
    );
    return { manager, events, killer, targets };
  }

  function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  }

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("builds one killer per incarnation, rooted at the PTY's pid", () => {
    const fake = makeFakePty({ pid: 4321 });
    spawnMock.mockReturnValue(fake.pty);
    const { manager, targets } = makeTreeManager();
    manager.spawn("p1", 0, options());
    expect(targets).toHaveLength(1);
    expect(targets[0].pid).toBe(4321);
  });

  it("SIGTERMs the whole tree with the plugin grace window instead of the root alone", () => {
    withPlatform("linux", () => {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer, targets } = makeTreeManager();
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGTERM");
      expect(killer.execute).toHaveBeenCalledWith(false, 3_000);
      // The killer signals the root through the adapter, which must stay a
      // polite SIGTERM and leave the handle live for the child's own exit.
      expect(fake.calls).toEqual([]);
      targets[0].kill();
      expect(fake.kills).toEqual(["SIGTERM"]);
    });
  });

  it("finishes the tree kill immediately on SIGKILL, before releasing the handle", () => {
    withPlatform("linux", () => {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer } = makeTreeManager();
      manager.spawn("p1", 0, options());
      const order: string[] = [];
      killer.execute.mockImplementation((immediate) => order.push(`execute:${immediate}`));
      fake.pty.destroy = () => {
        order.push("destroy");
      };
      manager.kill("p1", 0, "SIGTERM");
      manager.kill("p1", 0, "SIGKILL");
      expect(order).toEqual(["execute:false", "execute:true", "destroy"]);
      expect(fake.kills[0]).toBe("SIGKILL");
    });
  });

  it("tree-kills a PTY torn down by host disposal or a superseding generation", () => {
    const a = makeFakePty({ pid: 10 });
    const b = makeFakePty({ pid: 11 });
    spawnMock.mockReturnValueOnce(a.pty).mockReturnValueOnce(b.pty);
    const { manager, killer } = makeTreeManager();
    manager.spawn("p1", 0, options());
    manager.spawn("p1", 1, options());
    expect(killer.execute).toHaveBeenCalledTimes(1);
    expect(killer.execute).toHaveBeenLastCalledWith(true);
    manager.disposeAll();
    expect(killer.execute).toHaveBeenCalledTimes(2);
    expect(killer.execute).toHaveBeenLastCalledWith(true);
  });

  it("reaps what a root that exited on its own left behind", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager, killer } = makeTreeManager();
    manager.spawn("p1", 0, options());
    fake.emitExit(0);
    expect(killer.reapAfterRootExit).toHaveBeenCalledTimes(1);
    expect(killer.execute).not.toHaveBeenCalled();
  });

  it("leaves a graceful kill's escalation armed when the root exits inside the grace window", () => {
    withPlatform("linux", () => {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer } = makeTreeManager();
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGTERM");
      fake.emitExit(0, 15);
      // reapAfterRootExit() would abort the pending SIGKILL of grandchildren
      // that ignored SIGTERM — the most likely survivors of all.
      expect(killer.reapAfterRootExit).not.toHaveBeenCalled();
      expect(killer.execute).toHaveBeenCalledTimes(1);
    });
  });

  it("issues one native kill and one tree kill on Windows across SIGTERM then SIGKILL", () => {
    withPlatform("win32", () => {
      const fake = makeFakePty();
      (fake.pty as unknown as { _agent: object })._agent = {};
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer, targets } = makeTreeManager();
      // Model the real killer: taskkill, then the root's native fallback.
      killer.execute.mockImplementation(() => targets[0].kill());
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGTERM");
      manager.kill("p1", 0, "SIGKILL");
      // A second taskkill could land on a recycled PID; a second native kill
      // double-frees the pseudoconsole (#9551).
      expect(killer.execute).toHaveBeenCalledTimes(1);
      expect(fake.calls.filter((c) => c === "kill")).toHaveLength(1);
      expect(fake.calls).not.toContain("destroy");
    });
  });

  it("still tears the PTY down when building its killer throws", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manager = new PluginPtyProcessManager(
        () => {},
        () => {
          throw new Error("no ledger");
        }
      );
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGTERM");
      expect(fake.kills).toEqual(["SIGTERM"]);
      expect(manager.getLiveCount()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("finishes a graceful kill's escalation at host disposal after the root already exited", () => {
    withPlatform("linux", () => {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer } = makeTreeManager();
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGTERM");
      fake.emitExit(0, 15);
      expect(manager.getLiveCount()).toBe(0);
      // The escalation rides an unref'd timer the exiting host never waits for.
      manager.disposeAll();
      expect(killer.execute.mock.calls).toEqual([[false, 3_000], [true]]);
    });
  });

  it("finishes a natural exit's orphan reap at host disposal", () => {
    const fake = makeFakePty();
    spawnMock.mockReturnValue(fake.pty);
    const { manager, killer } = makeTreeManager();
    manager.spawn("p1", 0, options());
    fake.emitExit(0);
    manager.disposeAll();
    expect(killer.reapAfterRootExit.mock.calls).toEqual([[], [true]]);
  });

  it("owes nothing at disposal once the killer's own timer has run", () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer } = makeTreeManager();
      manager.spawn("p1", 0, options());
      fake.emitExit(0);
      vi.advanceTimersByTime(3_001);
      manager.disposeAll();
      expect(killer.reapAfterRootExit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers the real root PID once ConPTY reports it", () => {
    const fake = makeFakePty({ pid: 0 });
    spawnMock.mockReturnValue(fake.pty);
    const { manager, killer } = makeTreeManager();
    manager.spawn("p1", 0, options());
    expect(killer.registerRoot).not.toHaveBeenCalled();
    fake.pty.pid = 9001;
    fake.emitData("ready");
    fake.emitData("more");
    expect(killer.registerRoot.mock.calls).toEqual([[9001]]);
  });

  it("never signals the root through the adapter once it has exited", () => {
    withPlatform("linux", () => {
      const fake = makeFakePty();
      spawnMock.mockReturnValue(fake.pty);
      const { manager, targets } = makeTreeManager();
      manager.spawn("p1", 0, options());
      fake.emitExit(0);
      const before = fake.kills.length;
      targets[0].kill();
      expect(fake.kills).toHaveLength(before);
    });
  });

  it("never repeats a completed Windows tree kill at host disposal", () => {
    withPlatform("win32", () => {
      const fake = makeFakePty();
      (fake.pty as unknown as { _agent: object })._agent = {};
      spawnMock.mockReturnValue(fake.pty);
      const { manager, killer } = makeTreeManager();
      manager.spawn("p1", 0, options());
      manager.kill("p1", 0, "SIGTERM");
      fake.emitExit(0);
      manager.disposeAll();
      // taskkill /T /F already was the whole kill; the PID may be recycled.
      expect(killer.execute).toHaveBeenCalledTimes(1);
    });
  });
});
