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
