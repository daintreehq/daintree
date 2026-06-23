import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

let ptyOnDataCallback: ((data: string) => void) | null = null;

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      ptyOnDataCallback = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  const withDestroy = pty as Partial<IPty> & { destroy: () => void };
  withDestroy.destroy = vi.fn();
  return pty as IPty;
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
  emitData: (id: string, data: string | Uint8Array) => void,
  options?: Partial<TerminalProcessOptions>
): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal" as const,
      ...options,
    },
    { emitData, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
    },
    defaultSpawnContext(),
    createMockPty()
  );
}

// The OSC 9;4 tap must keep running per-chunk even when the rest of the pipeline
// is deferred, so the agent-state heartbeat never lags (#8753). The parser is a
// private collaborator; spy on its `feed` to assert it stays per-chunk.
function osc94FeedSpy(terminal: TerminalProcess) {
  const internal = terminal as unknown as { osc94Parser: { feed: (d: string, n: number) => void } };
  return vi.spyOn(internal.osc94Parser, "feed");
}

describe("TerminalProcess background output coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("runs the parse pipeline per chunk for foreground terminals", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    ptyOnDataCallback!("alpha");
    ptyOnDataCallback!("beta");

    expect(emitData).toHaveBeenCalledTimes(2);
    expect(emitData).toHaveBeenNthCalledWith(1, "t1", "alpha");
    expect(emitData).toHaveBeenNthCalledWith(2, "t1", "beta");

    terminal.dispose();
  });

  it("defers the parse pipeline for backgrounded terminals and coalesces on drain", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);
    const feed = osc94FeedSpy(terminal);

    terminal.setActivityMonitorTier("background", 500);

    ptyOnDataCallback!("chunk-a");
    ptyOnDataCallback!("chunk-b");

    // OSC 9;4 heartbeat stays per-chunk; the heavy pipeline (emitData fan-out) does not.
    expect(feed).toHaveBeenCalledTimes(2);
    expect(emitData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "chunk-achunk-b");

    terminal.dispose();
  });

  it("flushes the deferred queue synchronously when reactivated", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("pending-1");
    ptyOnDataCallback!("pending-2");
    expect(emitData).not.toHaveBeenCalled();

    // No timer advance — activation must drain inline so the headless terminal is
    // current before the renderer wakes and reads getSerializedState() (#10744).
    terminal.setActivityMonitorTier("active", 50);

    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "pending-1pending-2");
    expect(terminal.getActivityTier()).toBe("active");

    terminal.dispose();
  });

  it("drains immediately when the queue exceeds the byte cap", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    const big = "x".repeat(256 * 1024);

    ptyOnDataCallback!(big);

    // Cap reached → drain inline without waiting for the timer.
    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", big);

    terminal.dispose();
  });

  it("rearms the drain timer while background output continues", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);

    ptyOnDataCallback!("first");
    vi.advanceTimersByTime(300);
    // A later chunk pushes the deadline out; the burst should batch, not drain mid-flight.
    ptyOnDataCallback!("second");
    vi.advanceTimersByTime(200);
    expect(emitData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "firstsecond");

    terminal.dispose();
  });

  it("drops queued output on dispose without draining it", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("orphaned");
    expect(emitData).not.toHaveBeenCalled();

    terminal.dispose();
    vi.advanceTimersByTime(1000);

    expect(emitData).not.toHaveBeenCalled();
  });
});
