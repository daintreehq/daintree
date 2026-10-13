import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { events } from "../../events.js";

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
type TerminalProcessCallbacks = ConstructorParameters<typeof TerminalProcess>[2];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  callbacks?: Partial<TerminalProcessCallbacks>,
  agentStateService?: Partial<TerminalProcessDeps["agentStateService"]>
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
    { emitData: () => {}, onExit: () => {}, ...callbacks },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        ...agentStateService,
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
    },
    defaultSpawnContext(),
    createMockPty()
  );
}

// Reach the private surface the pipeline tests observe. Runtime-only access —
// the properties exist on the instance/prototype regardless of visibility.
type PipelineInternals = {
  terminalInfo: {
    agentState?: string;
    headlessTerminal?: { write: (data: string, cb?: () => void) => void };
  };
  getAgentOutputContentSnapshot: () => unknown;
};

describe("TerminalProcess output pipeline ordering and throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("forwards a chunk to the renderer before the analysis stages run", () => {
    // The forward-before-analysis contract: emitData must reach the renderer
    // callback ahead of the headless mirror parse enqueue for the same chunk —
    // analysis cost is bookkeeping and must not sit in front of the visible
    // frame (scroll-driven TUI redraws are latency-sensitive).
    const order: string[] = [];
    const terminal = createTerminal(undefined, {
      emitData: () => {
        order.push("emit");
      },
    });
    const internals = terminal as unknown as PipelineInternals;
    const headless = internals.terminalInfo.headlessTerminal;
    expect(headless).toBeDefined();
    const originalWrite = headless!.write.bind(headless);
    headless!.write = (data: string, cb?: () => void) => {
      order.push("headless");
      originalWrite(data, cb);
    };

    ptyOnDataCallback!("frame bytes");

    expect(order).toEqual(["emit", "headless"]);
    terminal.dispose();
  });

  it("throttles agent-output content comparisons under a redraw-rate chunk stream", async () => {
    // While an agent is waiting/idle (exactly when a user wheel-scrolls a
    // settled TUI), every redraw chunk used to pay two full viewport
    // extractions plus a diff. The throttle bounds that to one comparison per
    // interval, with a trailing pass so the burst's final state still lands.
    const terminal = createTerminal({ launchAgentId: "claude" });
    const internals = terminal as unknown as PipelineInternals;
    internals.terminalInfo.agentState = "waiting";
    const snapshotSpy = vi.spyOn(
      internals as unknown as Record<"getAgentOutputContentSnapshot", () => unknown>,
      "getAgentOutputContentSnapshot"
    );

    // A scroll-driven redraw stream: chunks every 5ms for ~40ms — after the
    // first accepted comparison, the rest land inside one throttle window.
    for (let i = 0; i < 8; i++) {
      ptyOnDataCallback!(`\x1b[H\x1b[2Jframe ${i}`);
      await vi.advanceTimersByTimeAsync(5);
    }
    const duringBurst = snapshotSpy.mock.calls.length;
    // Unthrottled this would be ~16 (a before + after pair per chunk). The
    // throttle admits the first comparison and defers the rest to the trailing
    // pass; allow a small margin for interval-boundary crossings mid-burst.
    expect(duringBurst).toBeLessThanOrEqual(6);

    // The trailing timer (still pending at t≈40ms; it fires at the 50ms window
    // edge) must deliver the burst's final comparison — strictly more calls.
    await vi.advanceTimersByTimeAsync(60);
    expect(snapshotSpy.mock.calls.length).toBeGreaterThan(duringBurst);

    terminal.dispose();
  });

  it("still promotes a sustained waiting-state stream to busy through the throttle", async () => {
    // The throttle reduces comparison FREQUENCY; it must not break the
    // temperature model's promotion semantics (needs ≥4 changed samples over a
    // 2s dwell at ≥70 heat — trivially satisfied at the throttled ~20/s
    // cadence, but a regression that starved samples would fail here).
    const handleActivityState = vi.fn();
    const terminal = createTerminal({ launchAgentId: "claude" }, undefined, {
      handleActivityState,
    } as never);
    const internals = terminal as unknown as PipelineInternals;
    internals.terminalInfo.agentState = "waiting";

    // Distinct full-line updates every 100ms for 3s — a real redraw stream.
    for (let i = 0; i < 30; i++) {
      ptyOnDataCallback!(`\r\nstatus ${i}: ${"#".repeat(20 + (i % 7))}`);
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(handleActivityState).toHaveBeenCalledWith(expect.anything(), "busy", {
      trigger: "output",
    });
    terminal.dispose();
  });

  it("clears the trailing comparison timer on teardown", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    const internals = terminal as unknown as PipelineInternals;
    internals.terminalInfo.agentState = "waiting";
    const snapshotSpy = vi.spyOn(
      internals as unknown as Record<"getAgentOutputContentSnapshot", () => unknown>,
      "getAgentOutputContentSnapshot"
    );

    // Two same-window chunks: the second arms the trailing timer.
    ptyOnDataCallback!("\x1b[H\x1b[2Jframe a");
    await vi.advanceTimersByTimeAsync(1);
    ptyOnDataCallback!("\x1b[H\x1b[2Jframe b");
    await vi.advanceTimersByTimeAsync(1);

    terminal.dispose();
    const afterDispose = snapshotSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    // A live trailing timer would fire another comparison after teardown.
    expect(snapshotSpy.mock.calls.length).toBe(afterDispose);
  });
});

describe("TerminalProcess output progress, in-thread (#12428)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  const spinnerFrame = (glyph: string, seconds: number) =>
    `\r\x1b[2K${glyph} Thinking… (${seconds}s · esc to interrupt)`;

  it("stamps a content change once the burst settles, and not a spinner redraw", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    const writtenAt = Date.now();

    ptyOnDataCallback!("● The fix is in src/app.ts.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    const stamped = terminal.getPublicState().lastOutputChangeAt;
    // Sampled on the trailing timer, so after the write and before now.
    expect(stamped).toBeGreaterThan(writtenAt);
    expect(stamped).toBeLessThanOrEqual(Date.now());

    // A frozen turn: only the working footer moves, for well past the sample
    // cadence.
    for (let i = 0; i < 10; i++) {
      ptyOnDataCallback!(spinnerFrame(i % 2 === 0 ? "✻" : "✽", 12 + i));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(terminal.getPublicState().lastOutputChangeAt).toBe(stamped);

    // New output lands beside the still-animating footer.
    ptyOnDataCallback!(`\r\x1b[2KRunning the tests now.\r\n${spinnerFrame("✶", 23)}`);
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getPublicState().lastOutputChangeAt).toBeGreaterThan(stamped!);

    terminal.dispose();
  });

  it("does not report a resize's reflow as output", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(`${"wrapped ".repeat(8)}\r\n`);
    await vi.advanceTimersByTimeAsync(250);
    const stamped = terminal.getPublicState().lastOutputChangeAt;
    expect(stamped).toBeDefined();

    // The 64-column line rewraps at 40. The footer redraw is what makes the
    // in-thread path sample the reflowed screen.
    terminal.resize(40, 24);
    ptyOnDataCallback!(spinnerFrame("✻", 1));
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!(spinnerFrame("✽", 2));
    await vi.advanceTimersByTimeAsync(2_000);
    ptyOnDataCallback!(spinnerFrame("✶", 3));
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getPublicState().lastOutputChangeAt).toBe(stamped);
    terminal.dispose();
  });

  it("baselines the reflowed screen on resize even when no output follows it", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(`${"wrapped ".repeat(8)}\r\n`);
    await vi.advanceTimersByTimeAsync(250);
    const stamped = terminal.getPublicState().lastOutputChangeAt;
    expect(stamped).toBeDefined();

    // Nothing is written until the quiet window has long closed, so only the
    // resize itself can have sampled the rewrapped frame.
    terminal.resize(40, 24);
    await vi.advanceTimersByTimeAsync(3_000);
    ptyOnDataCallback!(spinnerFrame("✻", 1));
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getPublicState().lastOutputChangeAt).toBe(stamped);
    terminal.dispose();
  });

  it("settles a pending sample at dispose instead of leaving it armed", async () => {
    // A preserved exit drains its final output and then releases the mirror;
    // that frame must be observed before the mirror goes, not dropped with it.
    const terminal = createTerminal({ launchAgentId: "claude" });
    const internals = terminal as unknown as { outputProgressTimer: unknown };

    ptyOnDataCallback!("the final answer\r\n");
    await vi.advanceTimersByTimeAsync(1);
    expect(internals.outputProgressTimer).not.toBeNull();
    expect(terminal.getPublicState().lastOutputChangeAt).toBeUndefined();

    terminal.dispose();
    const settled = terminal.getPublicState().lastOutputChangeAt;
    expect(settled).toBe(Date.now());
    expect(internals.outputProgressTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect(terminal.getPublicState().lastOutputChangeAt).toBe(settled);
  });
});

describe("TerminalProcess rate-limit observation (#12797)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
  });

  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  function collect() {
    const seen: Array<Record<string, unknown>> = [];
    unsubscribers.push(
      events.on("agent:rate-limit-observed", (payload) => seen.push({ ...payload }))
    );
    return seen;
  }

  it("emits once per appearance of a banner, with no terminal text", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "codex" });

    ptyOnDataCallback!("■ You've hit your usage limit. Try again at 3:40 PM.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(["observedAt", "terminalId", "timestamp"]);
    expect(seen[0]?.terminalId).toBe("t1");

    // Repaints while the banner stays on screen are the same observation.
    ptyOnDataCallback!("still waiting\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    // A repaint that drops it for a frame and brings it straight back is the
    // same banner, not a second one.
    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!("■ You've hit your usage limit.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    // Gone for good, then a later limit is a new observation.
    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(60_000);
    ptyOnDataCallback!("■ You've hit your usage limit.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(2);

    terminal.dispose();
  });

  it("sees Claude's weekly-limit banner under the tool-result gutter (#13127)", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(
      "  ⎿  You’ve hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)\r\n"
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("ignores a plain shell with no agent", async () => {
    const seen = collect();
    const terminal = createTerminal();

    ptyOnDataCallback!("HTTP 429 Too Many Requests\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(0);

    terminal.dispose();
  });
});

describe("TerminalProcess agent:output coalescing", () => {
  let received: Array<{ agentId: string; data: string; terminalId?: string }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    received = [];
    unsubscribe = events.on("agent:output", (payload) => {
      received.push(payload);
    });
  });

  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("coalesces multiple chunks into one emit on the flush timer", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    expect(ptyOnDataCallback).not.toBeNull();

    ptyOnDataCallback!("chunk-a");
    ptyOnDataCallback!("chunk-b");
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(received).toHaveLength(1);
    expect(received[0].agentId).toBe("claude");
    expect(received[0].data).toBe("chunk-achunk-b");
    expect(received[0].terminalId).toBe("t1");

    terminal.dispose();
  });

  it("flushes immediately when pending output reaches the size cap", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    const big = "x".repeat(2500);

    ptyOnDataCallback!(big);
    expect(received).toHaveLength(1);
    expect(received[0].data).toBe(big);

    terminal.dispose();
  });

  it("emits nothing for plain terminals", () => {
    const terminal = createTerminal();

    ptyOnDataCallback!("plain shell output");
    vi.advanceTimersByTime(100);
    expect(received).toHaveLength(0);

    terminal.dispose();
  });

  it("flushes pending output before the kill transition", () => {
    const order: string[] = [];
    const offOrder = events.on("agent:output", () => {
      order.push("output");
    });
    const terminal = createTerminal({ launchAgentId: "claude" }, undefined, {
      updateAgentState: () => {
        order.push("state");
      },
    } as never);

    ptyOnDataCallback!("tail-data");
    expect(received).toHaveLength(0);

    terminal.kill("user requested");

    expect(received).toHaveLength(1);
    expect(received[0].data).toBe("tail-data");
    expect(order).toEqual(["output", "state"]);

    offOrder();
    terminal.dispose();
  });

  it("flushes pending output on dispose without waiting for the timer", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!("last-words");
    expect(received).toHaveLength(0);

    terminal.dispose();
    expect(received).toHaveLength(1);
    expect(received[0].data).toBe("last-words");
  });
});

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
    const terminal = createTerminal(undefined, { emitData });

    ptyOnDataCallback!("alpha");
    ptyOnDataCallback!("beta");

    expect(emitData).toHaveBeenCalledTimes(2);
    expect(emitData).toHaveBeenNthCalledWith(1, "t1", "alpha", 5);
    expect(emitData).toHaveBeenNthCalledWith(2, "t1", "beta", 9);

    terminal.dispose();
  });

  it("streams output live per chunk for backgrounded terminals (no coalescing)", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(undefined, { emitData });
    const feed = osc94FeedSpy(terminal);

    terminal.setActivityMonitorTier("background", 500);

    ptyOnDataCallback!("chunk-a");
    ptyOnDataCallback!("chunk-b");

    // No deferral: each background chunk reaches the renderer fan-out immediately,
    // exactly like a foreground chunk. The OSC 9;4 heartbeat also stays per-chunk.
    expect(emitData).toHaveBeenCalledTimes(2);
    expect(emitData).toHaveBeenNthCalledWith(1, "t1", "chunk-a", 7);
    expect(emitData).toHaveBeenNthCalledWith(2, "t1", "chunk-b", 14);
    expect(feed).toHaveBeenCalledTimes(2);

    // Advancing timers must NOT fan out any additional (coalesced) batch — there
    // is no queue to drain.
    vi.advanceTimersByTime(2000);
    expect(emitData).toHaveBeenCalledTimes(2);

    terminal.dispose();
  });
});

// A throwing pty surfaces a write error on every keystroke, exercising
// logWriteError's 5s throttle + suppression-summary path. On Windows the
// triggering errno differs (NTSTATUS vs EPIPE/EIO), but the throttle is
// error-code-agnostic, so the platform is irrelevant to this behavior.
describe("TerminalProcess write-error throttle", () => {
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

  const THROTTLE_MS = 5000;

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
    // Was "write(fast-path)" while a separate chunked lane existed for >512-byte
    // payloads. Both lanes are now one direct write, so there is one label (#11875).
    expect(logs[0]).toContain("PTY write(direct) failed for t1");
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

  // #11875. Payloads over 512 bytes used to be re-split into 50-byte chunks and
  // dripped through a 5ms interval timer. node-pty owns write queueing now, so
  // they go straight through — one call, whole payload, no timers involved.
  it("passes an oversized write to the PTY once, whole and unchunked", () => {
    const handles = createMockPty();
    const terminal = createTerminal(handles);
    const big = "x".repeat(4096);

    terminal.write(big);

    expect(handles.writeMock).toHaveBeenCalledTimes(1);
    expect(handles.writeMock).toHaveBeenCalledWith(big);
    expect(errorLogs()).toHaveLength(0);
  });
});
