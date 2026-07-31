import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

const persistAsyncMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const persistSyncMock = vi.hoisted(() => vi.fn());

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

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

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
    (a as unknown as { callbacks: { onPreserved?: (id: string) => void } }).callbacks.onPreserved =
      onPreserved;
    ptyA.emitData("ok\r\n");
    await exitAndAwaitDispose(a, ptyA);
    expect(preservedIds).toEqual(["t1"]);

    const ptyB = createControllablePty();
    const b = createTerminal(undefined, ptyB);
    (b as unknown as { callbacks: { onPreserved?: (id: string) => void } }).callbacks.onPreserved =
      onPreserved;
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
