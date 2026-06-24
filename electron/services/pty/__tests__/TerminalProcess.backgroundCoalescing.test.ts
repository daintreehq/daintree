import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

let ptyOnDataCallback: ((data: string) => void) | null = null;
let ptyOnExitCallback: ((e: { exitCode: number; signal?: number }) => void) | null = null;

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
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      ptyOnExitCallback = cb;
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
    ptyOnExitCallback = null;
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

  it("forces a drain within the latency ceiling during sustained background output, every cycle (#10744)", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);

    // Cycle 1 — chunks every 200ms, faster than the 500ms soft drain interval, so
    // each chunk pushes the self-rearming deadline forward and the queue would
    // never drain while output flows. That starved activityMonitor.onData and the
    // headless VT write, freezing the ActivityMonitor's lastActivityTimestamp
    // until its 8s idle gate flipped a working backgrounded agent to "waiting"
    // (#10744 regression). COALESCE_MAX_DEFER_MS (1000ms) must force a drain.
    ptyOnDataCallback!("c0");
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(200);
      ptyOnDataCallback!(`c${i}`);
    }
    // ~800ms in, still under the ceiling: no forced drain yet.
    expect(emitData).not.toHaveBeenCalled();

    // Crossing the 1000ms ceiling must drain MID-BURST — pre-fix "drain only once
    // output quiets" would never fire while chunks keep arriving sub-interval.
    vi.advanceTimersByTime(200);
    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenLastCalledWith("t1", "c0c1c2c3c4");

    // Cycle 2 — the window must RESET after the drain (_backgroundOldestQueuedAt
    // back to 0, timer re-armed), so a fresh sustained burst drains within its OWN
    // ceiling rather than riding the previous window or never re-arming.
    ptyOnDataCallback!("c5");
    for (let i = 6; i <= 9; i++) {
      vi.advanceTimersByTime(200);
      ptyOnDataCallback!(`c${i}`);
    }
    expect(emitData).toHaveBeenCalledTimes(1); // still only cycle 1's drain

    vi.advanceTimersByTime(200);
    expect(emitData).toHaveBeenCalledTimes(2);
    expect(emitData).toHaveBeenLastCalledWith("t1", "c5c6c7c8c9");

    terminal.dispose();
  });

  it("keeps the latency ceiling hard when the background poll interval exceeds it", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    // A future tier could pass a drain interval larger than the 1000ms ceiling.
    // The min(interval, cap) on both the initial arm and the reschedule must still
    // force a drain by ~1000ms instead of waiting out the 2500ms soft interval.
    terminal.setActivityMonitorTier("background", 2500);

    ptyOnDataCallback!("a");
    vi.advanceTimersByTime(400);
    ptyOnDataCallback!("b"); // output still flowing; soft deadline pushed to ~2900ms
    expect(emitData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(700); // reach ~1100ms, past the 1000ms ceiling
    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "ab");

    terminal.dispose();
  });

  it("drains while still on the background tier before flipping to active", () => {
    const seenTierAtDrain: Array<"active" | "background"> = [];
    // emitData reads `terminal` lazily — only when the pipeline drains, well
    // after construction — so the const reference is safe.
    const emitData = vi.fn(() => {
      seenTierAtDrain.push(terminal.getActivityTier());
    });
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("queued");

    terminal.setActivityMonitorTier("active", 50);

    // The flush must run with the tier still "background" so a late chunk can't
    // re-enter the background branch mid-flush; the tier is "active" afterwards.
    expect(seenTierAtDrain).toEqual(["background"]);
    expect(terminal.getActivityTier()).toBe("active");

    terminal.dispose();
  });

  it("drains the queued output on kill before teardown so the pre-exit tail survives", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("pre-kill");
    expect(emitData).not.toHaveBeenCalled();

    // kill() must flush the coalesced queue through the pipeline BEFORE teardown
    // releases subscribers, so the final backgrounded chunk reaches forensics /
    // snapshot and the terminal:exited forensic tail stays complete (#10744).
    // The drain runs synchronously inside kill() — not on the deferred timer —
    // and clears the queue, so advancing timers fans nothing else out.
    terminal.kill("user requested");

    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "pre-kill");

    vi.advanceTimersByTime(1000);
    expect(emitData).toHaveBeenCalledTimes(1);
  });

  it("drains the queued output on natural exit before the forensic read", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(emitData);

    terminal.setActivityMonitorTier("background", 500);
    ptyOnDataCallback!("pre-exit");
    expect(emitData).not.toHaveBeenCalled();

    // The onExit handler must drain the coalesced queue BEFORE reading the
    // forensic tail, so a backgrounded terminal's final chunk lands in the
    // forensics buffer rather than being discarded by teardown (#10744). The
    // drain is synchronous inside the exit handler and empties the queue.
    ptyOnExitCallback!({ exitCode: 0 });

    expect(emitData).toHaveBeenCalledTimes(1);
    expect(emitData).toHaveBeenCalledWith("t1", "pre-exit");

    vi.advanceTimersByTime(1000);
    expect(emitData).toHaveBeenCalledTimes(1);

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
