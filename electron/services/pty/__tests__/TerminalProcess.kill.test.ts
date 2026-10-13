import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import { IdentityWatcher } from "../IdentityWatcher.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { WindowsTreeKillResult } from "../../../utils/windowsTreeKill.js";

const persistAsyncMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const persistSyncMock = vi.hoisted(() => vi.fn());
// Resolves by default: run on Windows, every kill below takes the async tree-kill path.
const treeKillMock = vi.hoisted(() => vi.fn(async (): Promise<WindowsTreeKillResult[]> => []));

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: treeKillMock,
}));

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TERMINAL_SESSION_PERSISTENCE_ENABLED: true,
    persistSessionSnapshotSync: persistSyncMock,
    persistSessionSnapshotAsync: persistAsyncMock,
  };
});

function createMockPty(overrides?: Partial<IPty>): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    ...overrides,
  };
  // destroy() exists on the concrete UnixTerminal/WindowsTerminal but is absent
  // from the exported IPty type; destroyPty() accesses it structurally (#9539).
  const withDestroy = pty as Partial<IPty> & { destroy: () => void };
  if (!withDestroy.destroy) {
    withDestroy.destroy = vi.fn();
  }
  return pty as IPty;
}

function createMockProcessTreeCache(descendantPids: number[] = []): ProcessTreeCache {
  return {
    getDescendantPids: vi.fn().mockReturnValue(descendantPids),
    getChildPids: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getProcess: vi.fn(),
    hasChildren: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn(),
    onRefresh: vi.fn().mockReturnValue(() => {}),
    refresh: vi.fn(),
    getLastRefreshTime: vi.fn().mockReturnValue(0),
    getLastError: vi.fn().mockReturnValue(null),
    getCacheSize: vi.fn().mockReturnValue(0),
  } as unknown as ProcessTreeCache;
}

function defaultSpawnContext(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
    ...overrides,
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  deps?: Partial<TerminalProcessDeps>,
  ptyOverrides?: Partial<IPty>
): TerminalProcess {
  const merged = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal" as const,
    ...options,
  };
  const ctx = defaultSpawnContext();
  return new TerminalProcess(
    "t1",
    merged,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
      ...deps,
    },
    ctx,
    createMockPty(ptyOverrides)
  );
}

describe("TerminalProcess.kill — agent state event", () => {
  it("emits kill event (not error) for agent terminals", () => {
    const updateAgentStateSpy = vi.fn();
    const emitAgentKilledSpy = vi.fn();

    const terminal = createTerminal(
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: updateAgentStateSpy,
          emitAgentKilled: emitAgentKilledSpy,
        } as never,
      }
    );

    terminal.kill("user requested");

    expect(updateAgentStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ launchAgentId: "claude" }),
      { type: "kill" }
    );
    expect(emitAgentKilledSpy).toHaveBeenCalled();
  });

  // The state machine collapses kill / dispose / onExit into a single
  // idempotent teardown. Calling kill() twice must not double-fire
  // agent:killed or attempt to flush persistence twice.
  it("is idempotent — second kill() is a no-op", () => {
    const updateAgentStateSpy = vi.fn();
    const emitAgentKilledSpy = vi.fn();

    const terminal = createTerminal(
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: updateAgentStateSpy,
          emitAgentKilled: emitAgentKilledSpy,
        } as never,
      }
    );

    terminal.kill("first");
    terminal.kill("second");

    // Each agent-state hook fires exactly once even though kill() was called twice.
    expect(updateAgentStateSpy).toHaveBeenCalledTimes(1);
    expect(emitAgentKilledSpy).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalProcess.kill — master fd release (#9539)", () => {
  it("calls destroy() on the pty to release the master fd when killed", () => {
    const destroy = vi.fn();
    const terminal = createTerminal(undefined, undefined, { destroy } as Partial<IPty>);

    terminal.kill("user requested");

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("calls destroy() exactly once even when kill() is called twice", () => {
    const destroy = vi.fn();
    const terminal = createTerminal(undefined, undefined, { destroy } as Partial<IPty>);

    terminal.kill("first");
    terminal.kill("second");

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalProcess.kill — session persistence", () => {
  beforeEach(() => {
    persistSyncMock.mockReset();
  });

  it("persists session snapshot synchronously for non-agent terminal on kill", () => {
    const terminal = createTerminal();

    // Spy on serializeForPersistence (banner-aware) — the kill path uses this
    // so a hibernate→restore→hibernate cycle doesn't bake the restore banner
    // into the snapshot.
    vi.spyOn(terminal, "serializeForPersistence").mockReturnValue({
      data: "scrollback-data",
      cols: 80,
      rows: 24,
    });

    terminal.kill("test");

    expect(persistSyncMock).toHaveBeenCalledWith("t1", {
      data: "scrollback-data",
      cols: 80,
      rows: 24,
    });
  });

  it("does not persist session for agent terminals on kill", () => {
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "claude" });

    vi.spyOn(terminal, "serializeForPersistence").mockReturnValue({
      data: "scrollback-data",
      cols: 80,
      rows: 24,
    });

    terminal.kill("test");

    expect(persistSyncMock).not.toHaveBeenCalled();
  });

  it("handles null serialized state gracefully on kill", () => {
    const terminal = createTerminal();

    vi.spyOn(terminal, "serializeForPersistence").mockReturnValue(null);

    terminal.kill("test");

    expect(persistSyncMock).not.toHaveBeenCalled();
  });

  it("completes kill even if serialization throws", () => {
    const terminal = createTerminal();

    vi.spyOn(terminal, "serializeForPersistence").mockImplementation(() => {
      throw new Error("serialize failed");
    });

    // Should not throw
    expect(() => terminal.kill("test")).not.toThrow();
  });
});

describe.skipIf(process.platform === "win32")("TerminalProcess.kill — process tree cleanup", () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    persistSyncMock.mockReset();
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    processKillSpy.mockRestore();
  });

  it("sends SIGTERM to descendants bottom-up before killing shell", () => {
    const mockCache = createMockProcessTreeCache([456, 789]);

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.kill("test");

    // Cache should be queried with the shell PID
    expect(mockCache.getDescendantPids).toHaveBeenCalledWith(123);

    // SIGTERM calls should be in bottom-up order: 456 first, then 789
    const sigTermCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGTERM");
    expect(sigTermCalls).toHaveLength(2);
    expect(sigTermCalls[0]).toEqual([456, "SIGTERM"]);
    expect(sigTermCalls[1]).toEqual([789, "SIGTERM"]);
  });

  it("escalates to SIGKILL after 500ms on kill()", () => {
    const mockCache = createMockProcessTreeCache([456]);

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.kill("test");

    // No SIGKILL yet
    const sigkillBefore = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillBefore).toHaveLength(0);

    // Advance timer
    vi.advanceTimersByTime(500);

    // Now SIGKILL should have been sent to descendant + shell
    const sigkillAfter = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillAfter.map((c: unknown[]) => c[0])).toEqual([456, 123]);
  });

  it("sends SIGKILL immediately on dispose()", () => {
    const mockCache = createMockProcessTreeCache([456]);

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.dispose();

    // SIGKILL should be sent synchronously without waiting for timer
    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillCalls).toHaveLength(2); // pid 456 + pid 123
  });

  it("handles undefined pty pid gracefully", () => {
    const terminal = createTerminal(undefined, undefined, { pid: undefined as unknown as number });
    expect(() => terminal.kill("test")).not.toThrow();

    // Should not call process.kill (no PID to target)
    expect(processKillSpy).not.toHaveBeenCalled();
  });

  it("handles null processTreeCache gracefully", () => {
    const terminal = createTerminal(undefined, { processTreeCache: null });
    terminal.kill("test");

    // No SIGTERM calls to descendants (no cache to query)
    const sigTermCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGTERM");
    expect(sigTermCalls).toHaveLength(0);

    // SIGKILL sweep should still fire for shell pid after 500ms
    vi.advanceTimersByTime(500);
    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillCalls).toHaveLength(1); // Just the shell pid 123
  });

  it("clears pending kill timer when dispose() follows kill()", () => {
    const mockCache = createMockProcessTreeCache([456]);

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });

    // kill() schedules a 500ms timer
    terminal.kill("test");
    processKillSpy.mockClear();

    // dispose() should clear that timer and do immediate SIGKILL
    terminal.dispose();

    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillCalls.length).toBeGreaterThan(0);

    // Advancing timer should NOT cause a second SIGKILL sweep
    processKillSpy.mockClear();
    vi.advanceTimersByTime(500);
    const lateSigkills = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(lateSigkills).toHaveLength(0);
  });

  it("handles process.kill throwing ESRCH gracefully", () => {
    const mockCache = createMockProcessTreeCache([456]);
    processKillSpy.mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    expect(() => terminal.kill("test")).not.toThrow();
  });

  it("re-reads descendants at SIGKILL time so children spawned in the grace window are reaped", () => {
    // SIGTERM pass sees [456]; before the 500ms SIGKILL escalation a new
    // child (789) forks and registers in the cache. The escalation must
    // observe the fresh list rather than the snapshot from kill() time.
    const getDescendantPids = vi
      .fn<(pid: number) => number[]>()
      .mockReturnValueOnce([456])
      .mockReturnValue([456, 789]);
    const mockCache = {
      ...createMockProcessTreeCache(),
      getDescendantPids,
    } as unknown as ProcessTreeCache;

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.kill("test");

    // SIGTERM pass used the initial snapshot [456]
    const sigTermCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGTERM");
    expect(sigTermCalls).toEqual([[456, "SIGTERM"]]);

    // Advance to fire the SIGKILL sweep
    vi.advanceTimersByTime(500);

    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    const sigkillPids = sigkillCalls.map((c: unknown[]) => c[0]);
    // The late-forked 789 must be SIGKILL'd alongside 456 and the shell pid 123.
    expect(sigkillPids).toEqual([456, 789, 123]);
    // Cache was queried at SIGTERM time and again at SIGKILL time.
    expect(getDescendantPids).toHaveBeenCalledTimes(2);
    expect(getDescendantPids).toHaveBeenNthCalledWith(1, 123);
    expect(getDescendantPids).toHaveBeenNthCalledWith(2, 123);
  });
});

describe("TerminalProcess.kill — Windows, while the tree kill is pending", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    treeKillMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
  });

  it("lets go of the mirror, its watchers and the output listener at once, and the pseudoconsole only after the kill", async () => {
    let finishKill: (results: WindowsTreeKillResult[]) => void = () => {};
    treeKillMock.mockImplementation(
      () => new Promise<WindowsTreeKillResult[]>((resolve) => (finishKill = resolve))
    );
    const outputListener = { dispose: vi.fn() };
    const watcherDispose = vi.spyOn(IdentityWatcher.prototype, "dispose");
    // `_agent` marks a real ConPTY: its release belongs to the tree kill.
    const terminal = createTerminal(undefined, undefined, {
      onData: () => outputListener,
      _agent: {},
    } as Partial<IPty>);
    const pty = terminal.getPtyProcess();
    expect(terminal.getInfo().headlessTerminal).toBeDefined();

    terminal.kill("test");

    expect(treeKillMock).toHaveBeenCalledTimes(1);
    expect(terminal.getInfo().headlessTerminal).toBeUndefined();
    expect(terminal.getInfo().serializeAddon).toBeUndefined();
    expect(outputListener.dispose).toHaveBeenCalled();
    expect(watcherDispose).toHaveBeenCalled();
    expect(terminal.getPublicState().hasPty).toBe(false);
    expect(pty.kill).not.toHaveBeenCalled();

    finishKill([
      {
        mode: "tree",
        targeted: [123],
        killed: [123],
        alreadyGone: [],
        timedOut: [],
        unconfirmed: [],
        failed: [],
        identityMismatch: [],
        stale: [],
        rootEnded: true,
      },
    ]);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(pty.kill).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalProcess snapshots", () => {
  function createMockPty(): IPty {
    const pty: Partial<IPty> = {
      pid: 123,
      cols: 80,
      rows: 24,
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {},
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
    };
    return pty as IPty;
  }

  type ControllablePty = IPty & {
    emitData: (d: string) => void;
    emitExit: (code: number, signal?: number) => void;
  };

  function createControllablePty(): ControllablePty {
    let dataCb: ((data: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

    const pty: Partial<IPty> & Pick<ControllablePty, "emitData" | "emitExit"> = {
      pid: 123,
      cols: 80,
      rows: 24,
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {},
      onData: (cb: (data: string) => void) => {
        dataCb = cb;
        return { dispose: () => {} };
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitCb = cb;
        return { dispose: () => {} };
      },
      emitData: (d: string) => {
        dataCb?.(d);
      },
      emitExit: (code: number, signal?: number) => {
        exitCb?.({ exitCode: code, signal });
      },
    };
    return pty as ControllablePty;
  }

  function defaultSpawnContext(overrides?: Partial<SpawnContext>): SpawnContext {
    return {
      shell: "/bin/zsh",
      args: ["-l"],
      env: {},
      ...overrides,
    };
  }

  function createTerminal(
    options?: Partial<TerminalProcessOptions>,
    pty: IPty = createMockPty()
  ): TerminalProcess {
    const merged = {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal" as const,
      launchAgentId: "claude" as const,
      ...options,
    };
    const ctx = defaultSpawnContext();
    return new TerminalProcess(
      "t1",
      merged,
      { emitData: () => {}, onExit: () => {} },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as ConstructorParameters<typeof TerminalProcess>[3]["agentStateService"],
        ptyPool: null,
        processTreeCache: null,
      },
      ctx,
      pty
    );
  }

  describe("TerminalProcess.flushEventDrivenSnapshot", () => {
    beforeEach(() => {
      persistAsyncMock.mockReset();
      persistAsyncMock.mockReturnValue(Promise.resolve());
      persistSyncMock.mockReset();
    });

    // Event-driven flush is fire-and-forget and now serializes off the event loop
    // via getSerializedStateAsync — drain its microtask chain before asserting.
    async function flushMicrotasks(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it("persists for agent terminals via async serialization (non-banner path)", async () => {
      const terminal = createTerminal();
      vi.spyOn(terminal, "getSerializedStateAsync").mockResolvedValue({
        data: "agent-scrollback",
        cols: 80,
        rows: 24,
      });

      terminal.flushEventDrivenSnapshot();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledWith("t1", {
        data: "agent-scrollback",
        cols: 80,
        rows: 24,
      });
    });

    it("suppresses an immediate repeat with unchanged content", async () => {
      const terminal = createTerminal();
      vi.spyOn(terminal, "getSerializedStateAsync").mockResolvedValue({
        data: "data",
        cols: 80,
        rows: 24,
      });

      terminal.flushEventDrivenSnapshot();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // Second call within 2s / unchanged buffer should be suppressed
      terminal.flushEventDrivenSnapshot();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("does not flush when serialized state is null", async () => {
      const terminal = createTerminal();
      vi.spyOn(terminal, "getSerializedStateAsync").mockResolvedValue(null);

      terminal.flushEventDrivenSnapshot();
      await flushMicrotasks();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("does not flush when terminal is killed", async () => {
      const terminal = createTerminal();
      vi.spyOn(terminal, "getSerializedStateAsync").mockResolvedValue({
        data: "data",
        cols: 80,
        rows: 24,
      });

      terminal.kill("test");

      persistAsyncMock.mockReset();
      terminal.flushEventDrivenSnapshot();
      await flushMicrotasks();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });
  });

  describe("TerminalProcess — snapshot and dispose preserved exited terminals", () => {
    beforeEach(() => {
      persistAsyncMock.mockReset();
      persistAsyncMock.mockReturnValue(Promise.resolve());
      persistSyncMock.mockReset();
    });

    async function exitAndAwaitDispose(
      terminal: TerminalProcess,
      pty: ControllablePty,
      code = 0
    ): Promise<void> {
      pty.emitExit(code);
      await vi.waitFor(() => {
        expect(terminal.getInfo().headlessTerminal).toBeUndefined();
      });
    }

    it("serializes the full buffer, then disposes the headless terminal on preserved exit", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("hello from agent\r\n");
      await exitAndAwaitDispose(terminal, pty);

      const info = terminal.getInfo();
      expect(info.isExited).toBe(true);
      expect(info.serializeAddon).toBeUndefined();
      expect(info.preservedSnapshot?.data).toContain("hello from agent");
      // The mirror is disposed above, so the grid must have been captured with it.
      expect(info.preservedSnapshot?.cols).toBeGreaterThan(0);

      expect(terminal.getSerializedState()?.data).toContain("hello from agent");
      await expect(terminal.getSerializedStateAsync()).resolves.toMatchObject({
        data: expect.stringContaining("hello from agent"),
      });
    });

    it("drains pending headless writes before snapshotting (tail of output is captured)", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("early output\r\n");
      // Exit immediately after the final chunk — the write is still queued in
      // xterm's async parser when onExit fires.
      pty.emitData("final tail line\r\n");
      await exitAndAwaitDispose(terminal, pty);

      const snapshot = terminal.getSerializedState();
      expect(snapshot?.data).toContain("early output");
      expect(snapshot?.data).toContain("final tail line");
    });

    it("keeps serving the snapshot after a post-exit resize (exit→resize→reattach)", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("resize survivor\r\n");
      await exitAndAwaitDispose(terminal, pty);
      const before = terminal.getSerializedState();

      expect(() => terminal.resize(120, 30)).not.toThrow();

      expect(terminal.getSerializedState()).toBe(before);
      await expect(terminal.getSerializedStateAsync()).resolves.toBe(before);
    });

    it("flushes a final on-disk snapshot for crash recovery on non-agent preserved exit", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal({ launchAgentId: undefined }, pty);
      // Runtime-promoted terminal: preserved on exit, but not gated out of
      // persistence by launchAgentId.
      terminal.getInfo().everDetectedAgent = true;

      pty.emitData("promoted terminal output\r\n");
      await exitAndAwaitDispose(terminal, pty);

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      const [persistedId, persistedState] = persistSyncMock.mock.calls[0]!;
      expect(persistedId).toBe("t1");
      expect(persistedState.data).toContain("promoted terminal output");
    });

    it("does not write a crash-recovery snapshot for agent terminals", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("agent output\r\n");
      await exitAndAwaitDispose(terminal, pty);

      expect(persistSyncMock).not.toHaveBeenCalled();
      expect(terminal.getSerializedState()?.data).toContain("agent output");
    });

    it("disposes headless without caching a snapshot on non-preserved (non-zero) exit", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("crash output\r\n");
      pty.emitExit(1);

      await vi.waitFor(() => {
        expect(terminal.getInfo().headlessTerminal).toBeUndefined();
      });
      expect(terminal.getInfo().preservedSnapshot).toBeUndefined();

      // Serializing a disposed non-preserved terminal must return null silently —
      // not throw, get caught, and log a spurious "Failed to serialize" error.
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(terminal.getSerializedState()).toBeNull();
        await expect(terminal.getSerializedStateAsync()).resolves.toBeNull();
        expect(errSpy).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });

    it("keeps the live headless terminal when serialization fails", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);
      const addon = terminal.getInfo().serializeAddon!;
      const spy = vi.spyOn(addon, "serialize").mockImplementationOnce(() => {
        throw new Error("serialize boom");
      });

      pty.emitData("still readable\r\n");
      pty.emitExit(0);
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });

      const info = terminal.getInfo();
      expect(info.preservedSnapshot).toBeUndefined();
      expect(info.headlessTerminal).toBeDefined();
      expect(info.serializeAddon).toBeDefined();
      // Subsequent reads serve the live buffer.
      expect(terminal.getSerializedState()?.data).toContain("still readable");
    });

    it("serves the cached snapshot without re-serializing", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);
      const spy = vi.spyOn(terminal.getInfo().serializeAddon!, "serialize");

      pty.emitData("cache me\r\n");
      await exitAndAwaitDispose(terminal, pty);

      const callsAfterExit = spy.mock.calls.length;
      terminal.getSerializedState();
      terminal.getSerializedState();
      await terminal.getSerializedStateAsync();
      expect(spy.mock.calls.length).toBe(callsAfterExit);
    });

    it("caches and serves an empty-buffer snapshot", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      await exitAndAwaitDispose(terminal, pty);

      const info = terminal.getInfo();
      expect(info.preservedSnapshot).toBeDefined();
      expect(terminal.getSerializedState()).toBe(info.preservedSnapshot);
      await expect(terminal.getSerializedStateAsync()).resolves.toBe(info.preservedSnapshot);
    });

    it("stamps preservedAt but not lastAccessedAt on preserved exit (fresh ≠ viewed)", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      expect(terminal.getInfo().preservedAt).toBeUndefined();
      expect(terminal.getInfo().preservedSnapshotLastAccessedAt).toBeUndefined();

      const before = Date.now();
      pty.emitData("stamp me\r\n");
      await exitAndAwaitDispose(terminal, pty);
      const after = Date.now();

      const info = terminal.getInfo();
      expect(info.preservedAt).toBeGreaterThanOrEqual(before);
      expect(info.preservedAt).toBeLessThanOrEqual(after);
      // A freshly-captured snapshot has not been viewed — leaving lastAccessedAt
      // unset keeps it evictable so a burst of exits can't slip past the cap.
      expect(info.preservedSnapshotLastAccessedAt).toBeUndefined();
    });

    it("fires onPreserved once the snapshot is captured, but not on non-preserved exit", async () => {
      const preservedIds: string[] = [];
      const onPreserved = (id: string) => preservedIds.push(id);

      const ptyA = createControllablePty();
      const a = createTerminal(undefined, ptyA);
      // Inject the optional callback the production wiring provides.
      (
        a as unknown as { callbacks: { onPreserved?: (id: string) => void } }
      ).callbacks.onPreserved = onPreserved;
      ptyA.emitData("ok\r\n");
      await exitAndAwaitDispose(a, ptyA);
      expect(preservedIds).toEqual(["t1"]);

      const ptyB = createControllablePty();
      const b = createTerminal(undefined, ptyB);
      (
        b as unknown as { callbacks: { onPreserved?: (id: string) => void } }
      ).callbacks.onPreserved = onPreserved;
      ptyB.emitData("crash\r\n");
      ptyB.emitExit(1);
      await vi.waitFor(() => {
        expect(b.getInfo().headlessTerminal).toBeUndefined();
      });
      // Non-preserved exit must not fire onPreserved.
      expect(preservedIds).toEqual(["t1"]);
    });

    it("does not stamp preserved timestamps on non-preserved (non-zero) exit", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("crash output\r\n");
      pty.emitExit(1);
      await vi.waitFor(() => {
        expect(terminal.getInfo().headlessTerminal).toBeUndefined();
      });

      const info = terminal.getInfo();
      expect(info.preservedAt).toBeUndefined();
      expect(info.preservedSnapshotLastAccessedAt).toBeUndefined();
    });

    it("stamps preservedSnapshotLastAccessedAt on both sync and async serves", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("touch me\r\n");
      await exitAndAwaitDispose(terminal, pty);

      const info = terminal.getInfo();

      info.preservedSnapshotLastAccessedAt = 0;
      terminal.getSerializedState();
      expect(info.preservedSnapshotLastAccessedAt).toBeGreaterThan(0);

      info.preservedSnapshotLastAccessedAt = 0;
      await terminal.getSerializedStateAsync();
      expect(info.preservedSnapshotLastAccessedAt).toBeGreaterThan(0);
    });

    it("bails safely when dispose() lands before the drain callback fires", async () => {
      const pty = createControllablePty();
      const terminal = createTerminal(undefined, pty);

      pty.emitData("racing output\r\n");
      pty.emitExit(0);
      // dispose() tears down headless synchronously, before xterm's async
      // parser queue delivers the sentinel drain callback.
      terminal.dispose();

      expect(terminal.getInfo().headlessTerminal).toBeUndefined();
      // Let any queued drain callback fire and hit the bail guard.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const info = terminal.getInfo();
      expect(info.preservedSnapshot).toBeUndefined();
      // The bail guard runs before any stamping, so a snapshot-less terminal must
      // never carry preserve timestamps (which would wrongly shield it / sort it).
      expect(info.preservedAt).toBeUndefined();
      expect(info.preservedSnapshotLastAccessedAt).toBeUndefined();
    });
  });

  describe("TerminalProcess — live snapshot continuation (#12791)", () => {
    it("stamps the renderer-bound offset and the pending escape sequence together", async () => {
      const pty = createControllablePty();
      const streamEnds: number[] = [];
      const terminal = new TerminalProcess(
        "t1",
        { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal", launchAgentId: "claude" },
        {
          emitData: (_id, _data, streamEnd) => streamEnds.push(streamEnd),
          // A respawn at the same id continues the previous process's offsets.
          streamOffsetBase: 1000,
          onExit: () => {},
        },
        {
          agentStateService: {
            handleActivityState: () => {},
            updateAgentState: () => {},
            emitAgentKilled: () => {},
            emitAgentCompleted: () => {},
          } as unknown as ConstructorParameters<typeof TerminalProcess>[3]["agentStateService"],
          ptyPool: null,
          processTreeCache: null,
        },
        defaultSpawnContext(),
        pty
      );

      pty.emitData("héllo ");
      pty.emitData("\x1b[3");
      const snapshot = await terminal.getSerializedStateAsync();

      // The offset is the one the renderer saw on the last chunk it was sent.
      expect(snapshot?.continuation).toEqual({
        pendingEscapeTail: "\x1b[3",
        streamOffset: streamEnds.at(-1),
      });
      expect(streamEnds).toEqual([
        1000 + Buffer.byteLength("héllo ", "utf8"),
        1000 + Buffer.byteLength("héllo \x1b[3", "utf8"),
      ]);
      expect(snapshot?.data).toContain("héllo");
    });
  });
});
