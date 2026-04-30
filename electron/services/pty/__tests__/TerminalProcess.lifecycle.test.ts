import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { events } from "../../events.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TERMINAL_SESSION_PERSISTENCE_ENABLED: false,
    persistSessionSnapshotSync: vi.fn(),
    persistSessionSnapshotAsync: vi.fn(),
  };
});

type DataCb = (data: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;

function createControllablePty(): IPty & {
  emitData: (d: string) => void;
  emitExit: (code: number, signal?: number) => void;
} {
  let dataCb: DataCb | null = null;
  let exitCb: ExitCb | null = null;

  const pty: Partial<IPty> & {
    emitData: (d: string) => void;
    emitExit: (code: number, signal?: number) => void;
  } = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
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
  return pty as IPty & { emitData: (d: string) => void; emitExit: (c: number, s?: number) => void };
}

function defaultSpawnContext(): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  pty: IPty,
  options?: Partial<TerminalProcessOptions>,
  deps?: Partial<TerminalProcessDeps>,
  id = "t-lifecycle"
): TerminalProcess {
  const merged = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal" as const,
    ...options,
  };
  return new TerminalProcess(
    id,
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
    defaultSpawnContext(),
    pty
  );
}

type TerminalExitedPayload = Parameters<Parameters<typeof events.on<"terminal:exited">>[1]>[0];

describe("TerminalProcess — terminal:exited event", () => {
  let exitedListener: ReturnType<typeof vi.fn<(p: TerminalExitedPayload) => void>>;
  let unsubscribe: () => void;

  beforeEach(() => {
    exitedListener = vi.fn<(p: TerminalExitedPayload) => void>();
    unsubscribe = events.on("terminal:exited", exitedListener);
  });

  afterEach(() => {
    unsubscribe();
  });

  it("emits exactly once on natural exit with reason 'natural'", () => {
    const pty = createControllablePty();
    createTerminal(pty);

    pty.emitExit(0);

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      terminalId: "t-lifecycle",
      code: 0,
      reason: "natural",
    });
  });

  it("captures recentOutput before headless dispose", () => {
    const pty = createControllablePty();
    createTerminal(pty);

    pty.emitData("connection refused\n");
    pty.emitExit(1);

    const call = exitedListener.mock.calls.find(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(call).toBeDefined();
    const payload = call![0] as { recentOutput: string };
    expect(payload.recentOutput).toContain("connection refused");
  });

  it("uses reason='kill' when kill() runs before the natural PTY exit", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty, {
      kind: "terminal",
      launchAgentId: "claude",
    });

    terminal.kill("user requested");
    pty.emitExit(0);

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      terminalId: "t-lifecycle",
      reason: "kill",
    });
  });

  it("emits with reason='dispose' and code=null when dispose() fires before any exit", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.dispose();

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      terminalId: "t-lifecycle",
      code: null,
      reason: "dispose",
    });
  });

  it("does not double-emit when natural exit fires after dispose()", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.dispose();
    pty.emitExit(0);

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
  });
});

describe("TerminalProcess — observer-driven exit handlers", () => {
  it("fires fallback classifier on natural agent exit with connection error tail", () => {
    const pty = createControllablePty();
    const fallbackListener = vi.fn();
    const off = events.on("agent:fallback-triggered", fallbackListener);

    try {
      createTerminal(
        pty,
        {
          kind: "terminal",
          launchAgentId: "claude",
          agentPresetId: "claude-default",
          originalAgentPresetId: "claude-default",
        },
        undefined,
        "t-fallback"
      );

      pty.emitData("API Error: 503 Service Unavailable\n");
      pty.emitExit(1);

      const calls = fallbackListener.mock.calls.filter(
        (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-fallback"
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toMatchObject({
        terminalId: "t-fallback",
        agentId: "claude",
        fromPresetId: "claude-default",
        reason: "connection",
      });
    } finally {
      off();
    }
  });

  it("does NOT fire fallback when terminal was killed before exit", () => {
    const pty = createControllablePty();
    const fallbackListener = vi.fn();
    const off = events.on("agent:fallback-triggered", fallbackListener);

    try {
      const terminal = createTerminal(
        pty,
        {
          kind: "terminal",
          launchAgentId: "claude",
          agentPresetId: "claude-default",
        },
        undefined,
        "t-killed"
      );

      pty.emitData("API Error: 503 Service Unavailable\n");
      terminal.kill("user");
      pty.emitExit(1);

      const calls = fallbackListener.mock.calls.filter(
        (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-killed"
      );
      expect(calls).toHaveLength(0);
    } finally {
      off();
    }
  });

  it("emits agent:completed only on natural exit, not on kill→onExit", () => {
    const pty = createControllablePty();
    const emitAgentCompletedSpy = vi.fn();

    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: emitAgentCompletedSpy,
        } as never,
      },
      "t-completed"
    );

    terminal.kill("user");
    pty.emitExit(0);

    expect(emitAgentCompletedSpy).not.toHaveBeenCalled();
  });

  // PtyManager.spawn(id) kills the existing terminal and respawns under
  // the same id. The new instance's `terminal:exited` listener must NOT
  // be consumed by the old PTY's eventual exit — that would silence its
  // own real exit later.
  it("filters terminal:exited by spawnedAt to survive id reuse during respawn", () => {
    const pty1 = createControllablePty();
    const emitAgentCompletedSpy1 = vi.fn();
    const t1 = createTerminal(
      pty1,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: emitAgentCompletedSpy1,
        } as never,
      },
      "t-shared-id"
    );
    t1.kill("respawn");

    // Wait one millisecond so the second terminal's spawnedAt token
    // differs from the first.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin briefly */
    }

    const pty2 = createControllablePty();
    const emitAgentCompletedSpy2 = vi.fn();
    createTerminal(
      pty2,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: emitAgentCompletedSpy2,
        } as never,
      },
      "t-shared-id"
    );

    // Old PTY fires its long-delayed exit. Subscriber for t1 may run; the
    // subscriber for t2 must NOT (it was killed, so reason !== natural,
    // but the critical case is that t2's listener is also still wired
    // and would otherwise match terminalId).
    pty1.emitExit(0);

    // Now t2 exits naturally — its own subscriber must still be wired.
    pty2.emitExit(0);

    // t1 was killed, no agent:completed expected for it.
    expect(emitAgentCompletedSpy1).not.toHaveBeenCalled();
    // t2 exited naturally; its subscriber must have fired.
    expect(emitAgentCompletedSpy2).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire callbacks.onExit when natural exit follows dispose()", () => {
    const pty = createControllablePty();
    const onExitSpy = vi.fn();

    const terminal = new TerminalProcess(
      "t-late-exit",
      { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal" },
      { emitData: () => {}, onExit: onExitSpy },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
        ptyPool: null,
        processTreeCache: null,
      },
      defaultSpawnContext(),
      pty
    );

    terminal.dispose();
    pty.emitExit(0);

    expect(onExitSpy).not.toHaveBeenCalled();
  });
});

describe("TerminalProcess — getPublicState lifecycle derivation", () => {
  it("reflects hasPty=false after dispose() even without prior kill", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    expect(terminal.getPublicState().hasPty).toBe(true);

    terminal.dispose();

    const state = terminal.getPublicState();
    expect(state.hasPty).toBe(false);
    expect(state.wasKilled).toBe(true);
  });

  it("reflects hasPty=false after natural exit (preserved agent terminal)", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty, { kind: "terminal", launchAgentId: "claude" });

    pty.emitExit(0);

    const state = terminal.getPublicState();
    expect(state.hasPty).toBe(false);
    expect(state.isExited).toBe(true);
    expect(state.exitCode).toBe(0);
  });
});
