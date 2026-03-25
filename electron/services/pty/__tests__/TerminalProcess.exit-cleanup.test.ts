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
} {
  let dataCb: DataCb | null = null;
  let exitCb: ExitCb | null = null;

  const pty: Partial<IPty> & { emitData: (d: string) => void; emitExit: (code: number) => void } = {
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
    emitExit: (code: number) => {
      exitCb?.({ exitCode: code, signal: 0 });
    },
  };
  return pty as IPty & { emitData: (d: string) => void; emitExit: (code: number) => void };
}

function defaultSpawnContext(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    isAgentTerminal: false,
    agentId: undefined,
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
    type: "terminal" as const,
    ...options,
  };
  const ctx = defaultSpawnContext({ isAgentTerminal: false });
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
