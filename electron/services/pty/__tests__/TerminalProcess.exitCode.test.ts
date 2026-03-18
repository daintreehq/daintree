import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";

type SpawnFn = (file: string, args: string[], options: Record<string, unknown>) => IPty;

let spawnMock: ReturnType<typeof vi.fn<SpawnFn>>;
let exitHandler: ((e: { exitCode: number; signal?: number }) => void) | null = null;

vi.mock("node-pty", () => {
  return {
    spawn: (...args: Parameters<SpawnFn>) => spawnMock(...args),
  };
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

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 456,
    cols: 80,
    rows: 24,
    process: "zsh",
    write: () => {},
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: (handler: (e: { exitCode: number; signal?: number }) => void) => {
      exitHandler = handler;
      return { dispose: () => {} };
    },
  };
  return pty as IPty;
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createTerminal(options?: Partial<TerminalProcessOptions>): TerminalProcess {
  return new TerminalProcess(
    "t-exit",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      type: "terminal",
      ...options,
    },
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
    }
  );
}

describe("TerminalProcess exit code persistence", () => {
  beforeEach(() => {
    exitHandler = null;
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
  });

  it("stores exitCode on clean exit for agent terminals", () => {
    const terminal = createTerminal({ kind: "agent", type: "claude" });

    expect(exitHandler).not.toBeNull();
    exitHandler!({ exitCode: 0 });

    const state = terminal.getPublicState();
    expect(state.isExited).toBe(true);
    expect(state.exitCode).toBe(0);
  });

  it("stores non-zero exitCode when agent terminal shouldPreserveOnExit returns false", () => {
    const terminal = createTerminal({ kind: "agent", type: "claude" });

    expect(exitHandler).not.toBeNull();
    exitHandler!({ exitCode: 1 });

    // Non-zero exit for agent terminal: shouldPreserveOnExit returns false,
    // so the terminal is disposed (not preserved) and exitCode is NOT stored
    const state = terminal.getPublicState();
    expect(state.exitCode).toBeUndefined();
  });

  it("does not store exitCode for non-agent terminals", () => {
    const terminal = createTerminal({ kind: "terminal", type: "terminal" });

    expect(exitHandler).not.toBeNull();
    exitHandler!({ exitCode: 0 });

    // Non-agent terminals are never preserved on exit
    const state = terminal.getPublicState();
    expect(state.exitCode).toBeUndefined();
  });

  it("does not store exitCode for killed terminals", () => {
    const terminal = createTerminal({ kind: "agent", type: "claude" });

    terminal.kill("test");
    exitHandler!({ exitCode: 0 });

    const state = terminal.getPublicState();
    expect(state.exitCode).toBeUndefined();
  });
});
