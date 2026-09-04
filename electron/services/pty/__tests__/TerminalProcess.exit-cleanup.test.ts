import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type DataCb = (data: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;

function createControllablePty(): IPty & {
  emitData: (d: string) => void;
  emitExit: (code: number) => void;
  destroy: ReturnType<typeof vi.fn>;
} {
  let dataCb: DataCb | null = null;
  let exitCb: ExitCb | null = null;

  const pty: Partial<IPty> & {
    emitData: (d: string) => void;
    emitExit: (code: number) => void;
    destroy: ReturnType<typeof vi.fn>;
  } = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    // destroy() releases the master PTY fd; absent from the IPty type so it is
    // accessed structurally by destroyPty() (#9539).
    destroy: vi.fn(),
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
    emitExit: (code: number) => {
      exitCb?.({ exitCode: code, signal: 0 });
    },
  };
  return pty as IPty & {
    emitData: (d: string) => void;
    emitExit: (code: number) => void;
    destroy: ReturnType<typeof vi.fn>;
  };
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
  pty: IPty,
  options?: Partial<TerminalProcessOptions>,
  deps?: Partial<TerminalProcessDeps>
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
        emitAgentCompleted: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
      ...deps,
    },
    ctx,
    pty
  );
}

describe("TerminalProcess onExit — sessionPersistTimer cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistAsyncMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persist timer fires after debounce when PTY stays alive (positive control)", async () => {
    const pty = createControllablePty();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    createTerminal(pty);

    pty.emitData("hello world\r\n");

    // Advance past the debounce — timer should fire and attempt persistence
    await vi.advanceTimersByTimeAsync(10_000);

    // persistSessionSnapshot runs; serialization may fail without real terminal
    // data, but the attempt proves the timer mechanism works
    const persistAttempts = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Failed to persist session")
    );
    const persistCalled = persistAsyncMock.mock.calls.length > 0;
    expect(persistAttempts.length > 0 || persistCalled).toBe(true);

    warnSpy.mockRestore();
  });

  it("clears sessionPersistTimer on natural exit so no persist attempt fires", async () => {
    const pty = createControllablePty();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    createTerminal(pty);

    // Emit data to trigger scheduleSessionPersist (sets a debounce timer)
    pty.emitData("hello world\r\n");

    // PTY exits naturally before the timer fires
    pty.emitExit(0);

    // Advance past the debounce period — timer should have been cleared
    await vi.advanceTimersByTimeAsync(10_000);

    // Neither the async persist mock nor the warn-on-failure path should fire
    const persistAttempts = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Failed to persist session")
    );
    expect(persistAsyncMock).not.toHaveBeenCalled();
    expect(persistAttempts).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("does not throw when clearing timer that was never set", () => {
    const pty = createControllablePty();

    createTerminal(pty);

    // Exit without any data — no timer was ever scheduled
    expect(() => pty.emitExit(0)).not.toThrow();
  });
});

describe("TerminalProcess onExit — master fd release (#9539)", () => {
  it("calls destroy() to release the master fd on natural exit", () => {
    const pty = createControllablePty();

    createTerminal(pty);
    pty.emitExit(0);

    expect(pty.destroy).toHaveBeenCalledTimes(1);
  });

  it("calls destroy() exactly once when natural exit fires twice", () => {
    const pty = createControllablePty();

    createTerminal(pty);
    pty.emitExit(0);
    pty.emitExit(0);

    expect(pty.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases the master fd even when an agent terminal is preserved on exit", () => {
    const pty = createControllablePty();

    // launchAgentId + exitCode 0 → shouldPreserveOnExit() returns true, so the
    // onExit handler takes the preserve early-return. teardown() runs before
    // that return, so the fd is still released.
    createTerminal(pty, { kind: "terminal", launchAgentId: "claude" });
    pty.emitExit(0);

    expect(pty.destroy).toHaveBeenCalledTimes(1);
  });
});

// A shell that exits on its own used to only cancel the SIGKILL escalation
// timer, so anything it had already detached (a `setsid` background job whose
// wrapper exited) survived forever (#12203).
describe.skipIf(process.platform === "win32")(
  "TerminalProcess onExit — detached descendant cleanup",
  () => {
    let killSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      killSpy.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    function ledgerFor(orphans: number[]) {
      return {
        registerRoot: vi.fn<(rootPid: number) => void>(),
        markRootClosing: vi.fn<(rootPid: number) => void>(),
        getVerifiedOrphanPids: vi.fn<
          (rootPid: number, alreadyCovered: readonly number[]) => number[]
        >(() => orphans),
      };
    }

    it("reaps a reparented descendant when the shell exits naturally", () => {
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([9001]);
      createTerminal(pty, undefined, { lineageLedger });

      pty.emitExit(0);

      expect(killSpy).toHaveBeenCalledWith(9001, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(9001, "SIGCONT");
    });

    it("escalates the survivor to SIGKILL after the grace window", () => {
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([9001]);
      createTerminal(pty, undefined, { lineageLedger });

      pty.emitExit(0);
      killSpy.mockClear();
      vi.advanceTimersByTime(500);

      expect(killSpy).toHaveBeenCalledWith(9001, "SIGKILL");
    });

    it("registers the shell as a lineage root at construction", () => {
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([]);
      createTerminal(pty, undefined, { lineageLedger });

      expect(lineageLedger.registerRoot).toHaveBeenCalledWith(123);
    });

    it("marks the root closing so a recycled PID cannot inherit the lineage", () => {
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([]);
      createTerminal(pty, undefined, { lineageLedger });

      pty.emitExit(0);

      expect(lineageLedger.markRootClosing).toHaveBeenCalledWith(123);
    });

    it("signals nothing when the terminal left no detached work", () => {
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([]);
      createTerminal(pty, undefined, { lineageLedger });

      pty.emitExit(0);
      vi.advanceTimersByTime(500);

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("disposing an already-exited terminal never signals the stale shell PID", () => {
      // Preserved agent terminals sit in the registry after a natural exit and
      // are disposed at app shutdown, possibly hours later. By then the shell
      // PID belongs to whatever the OS handed it to next.
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([9001]);
      const terminal = createTerminal(pty, undefined, { lineageLedger });

      pty.emitExit(0);
      killSpy.mockClear();

      terminal.dispose();
      vi.advanceTimersByTime(500);

      const touched = killSpy.mock.calls.map((c: unknown[]) => c[0]);
      expect(touched).not.toContain(123);
    });

    it("disposing a still-live terminal does kill its whole tree", () => {
      // Positive control for the guard above — a dispose that actually wins the
      // lifecycle transition must still reap root and descendants.
      const pty = createControllablePty();
      const lineageLedger = ledgerFor([9001]);
      const terminal = createTerminal(pty, undefined, { lineageLedger });

      terminal.dispose();

      const touched = killSpy.mock.calls.map((c: unknown[]) => c[0]);
      expect(touched).toContain(123);
      expect(touched).toContain(9001);
    });

    it("natural exit without a ledger behaves exactly as before", () => {
      const pty = createControllablePty();
      createTerminal(pty);

      pty.emitExit(0);
      vi.advanceTimersByTime(500);

      expect(killSpy).not.toHaveBeenCalled();
    });
  }
);
