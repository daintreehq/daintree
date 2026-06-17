import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

interface MockPtyHandles {
  pty: IPty;
  writeMock: ReturnType<typeof vi.fn<(data: string) => void>>;
}

function createMockPty(writeOverride?: (data: string) => void): MockPtyHandles {
  const writeMock = vi.fn<(data: string) => void>();

  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      writeMock(data);
      if (writeOverride) writeOverride(data);
    },
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };

  return { pty: pty as IPty, writeMock };
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

function createTerminal(handles: MockPtyHandles): TerminalProcess {
  const opts: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
  };
  return new TerminalProcess(
    "t1",
    opts,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as never,
      ptyPool: null,
      processTreeCache: null,
    },
    defaultSpawnContext(),
    handles.pty
  );
}

// A throwing pty surfaces a write error on every keystroke, exercising
// logWriteError's 5s throttle + suppression-summary path. On Windows the
// triggering errno differs (NTSTATUS vs EPIPE/EIO), but the throttle is
// error-code-agnostic, so the platform is irrelevant to this behavior.
const THROTTLE_MS = 5000;

describe("TerminalProcess write-error throttle", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let base: number;

  function errorLogs(): string[] {
    return errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    base = Date.now();
    vi.setSystemTime(base);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it("logs the first write error immediately", () => {
    const handles = createMockPty(() => {
      throw new Error("EBADF");
    });
    const terminal = createTerminal(handles);

    terminal.write("a");

    const logs = errorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("PTY write(fast-path) failed for t1");
    // The error object is forwarded as the second arg.
    expect(errSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("suppresses subsequent errors within the 5000ms window", () => {
    const handles = createMockPty(() => {
      throw new Error("EBADF");
    });
    const terminal = createTerminal(handles);

    terminal.write("a"); // logs
    vi.setSystemTime(base + 1000);
    terminal.write("b"); // suppressed
    vi.setSystemTime(base + 2000);
    terminal.write("c"); // suppressed

    expect(errorLogs()).toHaveLength(1);
  });

  it("logs a suppression summary once the window elapses", () => {
    const handles = createMockPty(() => {
      throw new Error("EBADF");
    });
    const terminal = createTerminal(handles);

    terminal.write("a"); // logs
    vi.setSystemTime(base + 1000);
    terminal.write("b"); // suppressed (1)
    vi.setSystemTime(base + 2000);
    terminal.write("c"); // suppressed (2)
    vi.setSystemTime(base + 3000);
    terminal.write("d"); // suppressed (3)

    vi.setSystemTime(base + THROTTLE_MS + 1);
    terminal.write("e"); // logs again + emits suppression summary

    const summary = errorLogs().find((m) => m.includes("Suppressed"));
    expect(summary).toBeDefined();
    expect(summary).toContain("Suppressed 3 additional PTY write errors for t1");
    expect(summary).toContain(`${THROTTLE_MS}ms`);
  });

  it("resets the suppression counter after reporting it", () => {
    const handles = createMockPty(() => {
      throw new Error("EBADF");
    });
    const terminal = createTerminal(handles);

    terminal.write("a"); // logs
    vi.setSystemTime(base + 1000);
    terminal.write("b"); // suppressed (1)

    vi.setSystemTime(base + THROTTLE_MS + 1);
    terminal.write("c"); // logs + "Suppressed 1" summary

    // Advance another full window with NO intervening suppressed errors, then
    // trigger one more error: the counter was reset to 0, so no stale summary.
    vi.setSystemTime(base + 2 * THROTTLE_MS + 2);
    errSpy.mockClear();
    terminal.write("d"); // logs, but must NOT emit a "Suppressed" line

    const logs = errorLogs();
    expect(logs).toHaveLength(1);
    expect(logs.some((m) => m.includes("Suppressed"))).toBe(false);
  });

  it("includes traceId in the error log when provided", () => {
    const handles = createMockPty(() => {
      throw new Error("EBADF");
    });
    const terminal = createTerminal(handles);

    terminal.write("a", "trace-42");

    expect(errorLogs()[0]).toContain("traceId=trace-42");
  });
});
