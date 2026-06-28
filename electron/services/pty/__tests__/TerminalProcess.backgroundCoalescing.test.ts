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
    onExit: () => {
      return { dispose: () => {} };
    },
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

// The OSC 9;4 tap runs per-chunk so the agent-state heartbeat never lags
// (#8753). The parser is a private collaborator; spy on its `feed`.
function osc94FeedSpy(terminal: TerminalProcess) {
  const internal = terminal as unknown as { osc94Parser: { feed: (d: string, n: number) => void } };
  return vi.spyOn(internal.osc94Parser, "feed");
}

// Hibernation removal: PTY output streams LIVE through the parse pipeline for
// every activity tier — the background-coalescing queue/drain machinery is gone.
// The activity tier now only adjusts the headless agent-state poll cadence.
describe("TerminalProcess background output streaming", () => {
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

  it("streams output live per chunk for backgrounded terminals (no coalescing)", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);
    const feed = osc94FeedSpy(terminal);

    terminal.setActivityMonitorTier("background", 500);

    ptyOnDataCallback!("chunk-a");
    ptyOnDataCallback!("chunk-b");

    // No deferral: each background chunk reaches the renderer fan-out immediately,
    // exactly like a foreground chunk. The OSC 9;4 heartbeat also stays per-chunk.
    expect(emitData).toHaveBeenCalledTimes(2);
    expect(emitData).toHaveBeenNthCalledWith(1, "t1", "chunk-a");
    expect(emitData).toHaveBeenNthCalledWith(2, "t1", "chunk-b");
    expect(feed).toHaveBeenCalledTimes(2);

    // Advancing timers must NOT fan out any additional (coalesced) batch — there
    // is no queue to drain.
    vi.advanceTimersByTime(2000);
    expect(emitData).toHaveBeenCalledTimes(2);

    terminal.dispose();
  });

  it("setActivityMonitorTier only updates the tier (output already streamed live)", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("live-1");
    ptyOnDataCallback!("live-2");
    expect(emitData).toHaveBeenCalledTimes(2);

    // Flipping back to active has no queue to drain — the tier just flips.
    terminal.setActivityMonitorTier("active", 50);
    expect(terminal.getActivityTier()).toBe("active");
    expect(emitData).toHaveBeenCalledTimes(2);

    terminal.dispose();
  });

  it("delivers the full background tail live before kill/exit (no pre-teardown drain needed)", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("pre-kill");
    // Already delivered — nothing is held waiting for teardown to flush.
    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "pre-kill");

    terminal.kill("user requested");
    vi.advanceTimersByTime(1000);
    expect(emitData).toHaveBeenCalledTimes(1);
  });
});
