import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubProcessKillForFile } from "../../../__tests__/helpers/processKillGuard.js";
import type { IPty } from "node-pty";
import { RATE_LIMIT_SETTLE_MS, TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { events } from "../../events.js";
import { AgentOutputForwarder } from "../AgentOutputForwarder.js";

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(async () => []),
  killWindowsProcessTreesSync: vi.fn(() => []),
}));

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
  agentStateService?: Partial<TerminalProcessDeps["agentStateService"]>,
  spawnContext: SpawnContext = defaultSpawnContext()
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
    spawnContext,
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
};

// Mock ptys carry made-up PIDs that belong to real processes on the machine
// running the suite; every kill path below must land on a stub (#14418). The
// stub outlives ProcessTreeKiller's 500ms SIGKILL escalation.
stubProcessKillForFile(600);

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
      (
        terminal as unknown as {
          analysis: Record<"getAgentOutputContentSnapshot", () => unknown>;
        }
      ).analysis,
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
      (
        terminal as unknown as {
          analysis: Record<"getAgentOutputContentSnapshot", () => unknown>;
        }
      ).analysis,
      "getAgentOutputContentSnapshot"
    );

    // Two same-window chunks: the second arms the trailing timer.
    ptyOnDataCallback!("\x1b[H\x1b[2Jframe a");
    await vi.advanceTimersByTimeAsync(1);
    ptyOnDataCallback!("\x1b[H\x1b[2Jframe b");
    await vi.advanceTimersByTimeAsync(1);
    const analysis = (terminal as unknown as { analysis: { agentOutputNoteTimer: unknown } })
      .analysis;
    expect(analysis.agentOutputNoteTimer).not.toBeNull();

    terminal.dispose();
    expect(analysis.agentOutputNoteTimer).toBeNull();
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
    const internals = (terminal as unknown as { analysis: { outputProgressTimer: unknown } })
      .analysis;

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

  it("keeps the latest banner on the pane for an account switch to read (#16136)", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "codex" });

    ptyOnDataCallback!("■ You've hit your usage limit. Try again at 3:40 PM.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().usageLimitObservedAt).toBe(seen[0]?.observedAt);

    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(60_000);
    ptyOnDataCallback!("■ You've hit your usage limit.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(2);
    expect(terminal.getInfo().usageLimitObservedAt).toBe(seen[1]?.observedAt);

    terminal.dispose();
  });

  it("remembers a limit hit again inside the event's cooldown (#16136)", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "codex" });

    ptyOnDataCallback!("■ You've hit your usage limit.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    // The pane worked again, and its memory went with it.
    terminal.getInfo().usageLimitObservedAt = undefined;
    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(1_000);
    ptyOnDataCallback!("■ You've hit your usage limit.\r\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toHaveLength(1);
    expect(terminal.getInfo().usageLimitObservedAt).toBeGreaterThan(Number(seen[0]?.observedAt));

    terminal.dispose();
  });

  it("ignores a plain shell with no agent", async () => {
    const seen = collect();
    const terminal = createTerminal();

    ptyOnDataCallback!("HTTP 429 Too Many Requests\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(0);
    expect(terminal.getInfo().usageLimitObservedAt).toBeUndefined();

    terminal.dispose();
  });
});

describe("TerminalProcess update-installed observation (#17905)", () => {
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
      events.on("agent:update-installed-changed", (payload) => seen.push({ ...payload }))
    );
    return seen;
  }

  // Claude's footer on the 80-column pane: hints left, the notice flush right.
  const footer = (notice = "✔ Update installed · /restart to apply") => {
    const left = "  ? for shortcuts";
    return `${left}${" ".repeat(79 - left.length - notice.length)}${notice}\r\n`;
  };

  function claudeTerminal(updateAgentState = vi.fn()) {
    const terminal = createTerminal({ launchAgentId: "claude" }, undefined, {
      updateAgentState,
    });
    terminal.getInfo().detectedAgentId = "claude";
    terminal.getInfo().agentState = "working";
    return terminal;
  }

  it("records the footer on a working Claude pane without touching its state", async () => {
    const seen = collect();
    const updateAgentState = vi.fn();
    const terminal = claudeTerminal(updateAgentState);

    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);

    const observedAt = seen[0]?.timestamp;
    expect(seen).toEqual([
      {
        terminalId: "t1",
        updateInstalled: { observedAt, namesRestart: true },
        timestamp: observedAt,
      },
    ]);
    expect(terminal.getInfo().updateInstalled).toEqual({ observedAt, namesRestart: true });
    expect(terminal.getInfo().agentState).toBe("working");
    expect(updateAgentState).not.toHaveBeenCalled();

    // Repaints with the footer still up are the same observation.
    ptyOnDataCallback!("more output\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("reads which offer the footer made", async () => {
    const seen = collect();
    const terminal = claudeTerminal();

    ptyOnDataCallback!(footer("✔ Update installed · Restart to update"));
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getInfo().updateInstalled?.namesRestart).toBe(false);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it.each([
    ["a pane launched as Claude before detection names it", "claude", undefined],
    ["a pane whose detected agent is Codex", "codex", "codex"],
    ["a plain shell", undefined, undefined],
  ] as const)("ignores the footer on %s", async (_name, launchAgentId, detectedAgentId) => {
    const seen = collect();
    const terminal = createTerminal(launchAgentId ? { launchAgentId } : undefined);
    if (detectedAgentId) terminal.getInfo().detectedAgentId = detectedAgentId;

    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([]);
    expect(terminal.getInfo().updateInstalled).toBeUndefined();

    terminal.dispose();
  });

  it("clears on the first frame after another CLI takes the pane", async () => {
    const seen = collect();
    const terminal = claudeTerminal();

    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().updateInstalled).toBeDefined();

    terminal.getInfo().detectedAgentId = "codex";
    ptyOnDataCallback!("codex output\r\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getInfo().updateInstalled).toBeUndefined();
    expect(seen.at(-1)).toEqual({
      terminalId: "t1",
      updateInstalled: null,
      timestamp: expect.any(Number),
    });

    terminal.dispose();
  });

  const detect = (terminal: TerminalProcess, agentType: "claude" | "codex") =>
    terminal.handleAgentDetection(
      { detectionState: "agent", detected: true, agentType, processName: agentType },
      terminal.getInfo().spawnedAt
    );

  it("reads a footer already on screen the moment Claude is first detected", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    // Claude's screen, drawn before detection caught up, then nothing more.
    ptyOnDataCallback!(`${"─".repeat(79)}\r\n❯ \r\n${"─".repeat(79)}\r\n${footer()}`);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    detect(terminal, "claude");

    expect(terminal.getInfo().updateInstalled?.namesRestart).toBe(true);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("doesn't credit footer text a shell left on screen to a Claude detected before it draws", async () => {
    const seen = collect();
    const terminal = createTerminal();

    ptyOnDataCallback!(
      "$ tail notes.txt\r\n  ✔ Update installed · /restart to apply\r\n$ claude\r\n"
    );
    await vi.advanceTimersByTimeAsync(250);
    detect(terminal, "claude");

    expect(seen).toEqual([]);
    expect(terminal.getInfo().updateInstalled).toBeUndefined();

    terminal.dispose();
  });

  it("keeps the last run's fence through a first-detection screen it can't read", async () => {
    const terminal = claudeTerminal();
    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);

    // Claude exits; its footer stays up above the shell prompt.
    terminal.getInfo().detectedAgentId = undefined;
    terminal.getInfo().launchAgentId = undefined;
    ptyOnDataCallback!("$ claude\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().updateFooterSighting?.fenced).toBe(true);

    // The next Claude is detected before it draws: no composer in view.
    detect(terminal, "claude");
    expect(terminal.getInfo().updateFooterSighting?.fenced).toBe(true);
    ptyOnDataCallback!("\r\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getInfo().updateInstalled).toBeUndefined();

    terminal.dispose();
  });

  it("clears the moment another agent is detected, with no frame after", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });
    detect(terminal, "claude");
    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().updateInstalled).toBeDefined();

    detect(terminal, "codex");

    expect(terminal.getInfo().updateInstalled).toBeUndefined();
    expect(seen.at(-1)?.updateInstalled).toBeNull();

    terminal.dispose();
  });

  it("clears when an idle Claude pane is killed", async () => {
    const seen = collect();
    const terminal = claudeTerminal();
    terminal.getInfo().agentState = "idle";
    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().updateInstalled).toBeDefined();

    terminal.kill();

    expect(terminal.getInfo().updateInstalled).toBeUndefined();
    expect(seen.at(-1)?.updateInstalled).toBeNull();

    terminal.dispose();
  });

  it("lets the next run read its own footer once the shell has scrolled the old one away", async () => {
    const terminal = claudeTerminal();
    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);

    // Claude exits to the shell, which keeps drawing under the old footer.
    terminal.getInfo().detectedAgentId = undefined;
    terminal.getInfo().launchAgentId = undefined;
    ptyOnDataCallback!("$ ls\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().updateInstalled).toBeUndefined();
    expect(terminal.getInfo().updateFooterSighting?.fenced).toBe(true);

    ptyOnDataCallback!("\x1b[2J\x1b[H$ clear\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.getInfo().updateFooterSighting?.fenced).toBe(false);

    terminal.dispose();
  });

  it("clears when a detection pass names a different Claude process", async () => {
    const seen = collect();
    const terminal = claudeTerminal();

    ptyOnDataCallback!(footer());
    await vi.advanceTimersByTimeAsync(250);
    const spawnedAt = terminal.getInfo().spawnedAt;
    terminal.handleAgentProcessObservation(
      { agentType: "claude", command: "claude", pid: 4242 },
      spawnedAt
    );
    terminal.handleAgentProcessObservation(
      { agentType: "claude", command: "claude", pid: 4242 },
      spawnedAt
    );
    expect(terminal.getInfo().updateInstalled).toBeDefined();

    terminal.handleAgentProcessObservation(
      { agentType: "claude", command: "claude", pid: 5151 },
      spawnedAt
    );

    expect(terminal.getInfo().updateInstalled).toBeUndefined();
    expect(seen.at(-1)?.updateInstalled).toBeNull();

    terminal.dispose();
  });
});

describe("TerminalProcess Claude usage observation (#15727)", () => {
  // 10am on Nov 2 in Sydney.
  const now = Date.UTC(2026, 10, 1, 23, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
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
      events.on("agent:claude-usage-observed", (payload) => seen.push({ ...payload }))
    );
    return seen;
  }

  // Claude's footer on the 80-column pane: hints left, its warning flush right.
  const footerRow = (message: string) => {
    const left = "  ? for shortcuts";
    return `${left}${" ".repeat(79 - left.length - message.length)}${message}\r\n`;
  };
  const footer = (percent: number) =>
    footerRow(`You've used ${percent}% of your weekly limit · resets 6pm (UTC)`);

  it("reports the parsed fields of a footer warning, never its text", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        terminalId: "t1",
        window: "weekly limit",
        statement: "used",
        usedPercent: 87,
        // 6pm UTC has passed today, so it's tomorrow's.
        resetsAt: Date.UTC(2026, 10, 2, 18, 0),
        observedAt: expect.any(Number),
        // No CLAUDE_CONFIG_DIR in the launch env: Claude's own folder.
        configDir: path.join(os.homedir(), ".claude"),
        // The shell whose startup files could still move that folder.
        shell: "/bin/zsh",
        timestamp: seen[0]?.observedAt,
      },
    ]);
    // When the sample read it, not when the bytes arrived or the message reset.
    expect(seen[0]?.observedAt).toBeGreaterThanOrEqual(now);
    expect(seen[0]?.observedAt).toBeLessThanOrEqual(Date.now());

    terminal.dispose();
  });

  it.each([
    [
      "an account's folder",
      { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), ".claude-work") },
      path.join(os.tmpdir(), ".claude-work"),
    ],
    ["a folder that can't be resolved", { CLAUDE_CONFIG_DIR: "relative/claude" }, null],
  ])("names the config folder the pane launched on: %s (#16370)", async (_name, env, expected) => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" }, undefined, undefined, {
      ...defaultSpawnContext(),
      env,
    });

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);

    expect(seen.map((payload) => payload.configDir)).toEqual([expected]);
    terminal.dispose();
  });

  it("leaves a warning after a gap short of the pane's edge alone", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!("  ? for shortcuts  Approaching weekly limit · resets 6pm (UTC)\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);
    // The same message flush right is Claude's footer.
    ptyOnDataCallback!(footerRow("Approaching weekly limit · resets 6pm (UTC)"));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("reports a message once while it stays, and again when it changes", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    // On screen past the cooldown, through repaints, it is one observation.
    for (let i = 0; i < 3; i++) {
      ptyOnDataCallback!(`more output ${i}\r\n${footer(87)}`);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(seen).toHaveLength(1);

    // A repaint that drops it for a frame is the same message.
    ptyOnDataCallback!("line\r\n".repeat(30));
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    ptyOnDataCallback!(footer(91));
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!(footerRow("Over 90% of your weekly limit used · resets 6pm (UTC)"));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen.map((payload) => [payload.statement, payload.usedPercent])).toEqual([
      ["used", 87],
      ["used", 91],
      ["over", 90],
    ]);

    // Gone a while, then shown again, it is seen again.
    ptyOnDataCallback!("line\r\n".repeat(30));
    await vi.advanceTimersByTimeAsync(60_000);
    ptyOnDataCallback!(footerRow("Over 90% of your weekly limit used · resets 6pm (UTC)"));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(4);

    terminal.dispose();
  });

  it("reports each limit on its own", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!("  ⎿  You've hit your 5-hour limit · resets 3pm (Australia/Sydney)\r\n");
    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);

    expect(seen.map((payload) => [payload.window, payload.statement])).toEqual([
      ["weekly limit", "used"],
      ["5-hour limit", "reached"],
    ]);

    terminal.dispose();
  });

  it("reads Claude Code panes only", async () => {
    const seen = collect();
    const codex = createTerminal({ launchAgentId: "codex" });
    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    codex.dispose();

    const shell = createTerminal();
    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    shell.dispose();

    expect(seen).toEqual([]);
  });

  it("goes by the agent detected in a pane launched as Claude", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });
    const info = (terminal as unknown as { terminalInfo: { detectedAgentId?: string } })
      .terminalInfo;
    info.detectedAgentId = "codex";

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    terminal.dispose();
  });

  it("stops reading once Claude has exited the pane", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    const info = (terminal as unknown as { terminalInfo: { agentState?: string } }).terminalInfo;
    info.agentState = "exited";
    ptyOnDataCallback!(footer(91));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("reads a footer warning in the frame Claude exits on", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(footer(87));
    await vi.advanceTimersByTimeAsync(1);
    // The agent and its PTY exit before the sample is taken; the exit path
    // settles the last frame as it releases the mirror.
    const info = (
      terminal as unknown as { terminalInfo: { agentState?: string; isExited?: boolean } }
    ).terminalInfo;
    info.agentState = "exited";
    info.isExited = true;
    terminal.dispose();

    expect(seen.map((payload) => payload.usedPercent)).toEqual([87]);
  });

  it("ignores a Claude pane's prose about a limit", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!("⏺ The footer says you've used 87% of your weekly limit · resets Nov 2\r\n");
    ptyOnDataCallback!("⚠ Heads up, you have less than 10% of your weekly limit left.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    terminal.dispose();
  });
});

describe("TerminalProcess rate-limit fallback offer (#14370)", () => {
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
      events.on("agent:fallback-triggered", (payload) => seen.push({ ...payload }))
    );
    return seen;
  }

  const preset = {
    launchAgentId: "claude",
    agentPresetId: "claude-work",
    originalAgentPresetId: "claude-home",
  } as const;
  const banner = "  ⎿  You’ve hit your weekly limit · resets Oct 2 at 9pm\r\n";

  it("offers the chain once the banner has sat still, with no terminal text", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);

    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS - 100);
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      terminalId: "t1",
      agentId: "claude",
      fromPresetId: "claude-work",
      originalPresetId: "claude-home",
      reason: "rate-limit",
      timestamp: expect.any(Number),
    });

    // Sitting there longer, or redrawn, is the same banner, not a second offer.
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 4);
    ptyOnDataCallback!("prompt\r\n");
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 4);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("waits while output is still arriving under the banner", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);

    ptyOnDataCallback!(banner);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ptyOnDataCallback!(`retrying ${i}\r\n`);
    }
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("waits while bytes keep arriving even when the screen doesn't change", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);

    ptyOnDataCallback!(banner);
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ptyOnDataCallback!("\x1b[?25h");
    }
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("never offers a banner the agent kept working past", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);

    ptyOnDataCallback!(banner);
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ptyOnDataCallback!(`\rretrying ${i % 5}`);
    }
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 4);
    expect(seen).toHaveLength(0);

    terminal.dispose();
  });

  it("waits while the agent is still working at the banner", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);
    const info = (terminal as unknown as { terminalInfo: { agentState?: string } }).terminalInfo;

    info.agentState = "working";
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 3);
    expect(seen).toHaveLength(0);

    info.agentState = "waiting";
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen).toHaveLength(1);

    terminal.dispose();
  });

  it("drops the offer when the banner goes before it settles, and offers again on a new one", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);

    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(1_000);
    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 2);
    expect(seen).toHaveLength(0);

    // Inside the chip's cooldown, but a fresh appearance all the same.
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen).toHaveLength(1);

    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(500);
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen).toHaveLength(2);

    terminal.dispose();
  });

  it("never offers once another agent has taken over the pane", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);
    const info = (terminal as unknown as { terminalInfo: { detectedAgentId?: string } })
      .terminalInfo;

    info.detectedAgentId = "codex";
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 2);
    expect(seen).toHaveLength(0);

    terminal.dispose();
  });

  it("never offers for a pane launched without a preset", async () => {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 2);
    expect(seen).toHaveLength(0);

    terminal.dispose();
  });

  it("cancels a pending offer when the pane is killed", async () => {
    const seen = collect();
    const terminal = createTerminal(preset);

    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(1_000);
    terminal.kill("user");
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 2);
    expect(seen).toHaveLength(0);

    terminal.dispose();
  });
});

describe("TerminalProcess agent:output coalescing", () => {
  // Only the Assistant's output is forwarded to Main (#15667).
  const assistant = { launchAgentId: "claude", isAssistantTerminal: true } as const;
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
    const terminal = createTerminal(assistant);
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
    const terminal = createTerminal(assistant);
    const big = "x".repeat(2500);

    ptyOnDataCallback!(big);
    expect(received).toHaveLength(1);
    expect(received[0].data).toBe(big);

    terminal.dispose();
  });

  it("emits nothing for an agent terminal that is not the Assistant", () => {
    const queue = vi.spyOn(AgentOutputForwarder.prototype, "queue");
    const emitData = vi.fn();
    const terminal = createTerminal({ launchAgentId: "claude" }, { emitData });
    const big = "x".repeat(2500);

    ptyOnDataCallback!("agent output");
    ptyOnDataCallback!(big);
    vi.advanceTimersByTime(100);
    terminal.kill("user requested");

    expect(received).toHaveLength(0);
    expect(queue).not.toHaveBeenCalled();
    // The renderer still gets every byte.
    expect(emitData.mock.calls.map((call) => call[1]).join("")).toBe(`agent output${big}`);

    queue.mockRestore();
    terminal.dispose();
  });

  // #16426: nothing read this ring, and each chunk paid to concatenate and slice it.
  it("keeps no rolling copy of an agent's output on the terminal record", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!("agent output");

    expect(terminal.getInfo()).not.toHaveProperty("outputBuffer");

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
    const terminal = createTerminal(assistant, undefined, {
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
    const terminal = createTerminal(assistant);

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
  const internal = terminal as unknown as {
    analysis: { osc94Parser: { feed: (d: string, n: number) => void } };
  };
  return vi.spyOn(internal.analysis.osc94Parser, "feed");
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
    expect(emitData).toHaveBeenNthCalledWith(
      1,
      "t1",
      "alpha",
      5,
      new TextEncoder().encode("alpha")
    );
    expect(emitData).toHaveBeenNthCalledWith(2, "t1", "beta", 9, new TextEncoder().encode("beta"));

    terminal.dispose();
  });

  it("offsets the stream by each chunk's UTF-8 bytes and hands those bytes on", () => {
    const emitData = vi.fn();
    const terminal = createTerminal(undefined, { emitData });
    const chunks = ["héllo │ ", "😀", "lone \ud83d half", "\ufeffbom"];

    let offset = 0;
    for (const chunk of chunks) ptyOnDataCallback!(chunk);

    chunks.forEach((chunk, index) => {
      offset += Buffer.byteLength(chunk, "utf8");
      const [id, data, streamEnd, encoded] = emitData.mock.calls[index];
      expect([id, data, streamEnd]).toEqual(["t1", chunk, offset]);
      expect(Buffer.from(encoded as Uint8Array).equals(Buffer.from(chunk, "utf8"))).toBe(true);
    });

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
    expect(emitData).toHaveBeenNthCalledWith(
      1,
      "t1",
      "chunk-a",
      7,
      new TextEncoder().encode("chunk-a")
    );
    expect(emitData).toHaveBeenNthCalledWith(
      2,
      "t1",
      "chunk-b",
      14,
      new TextEncoder().encode("chunk-b")
    );
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

describe("TerminalProcess in-thread bracketed paste (#15629)", () => {
  it("reports the mode its own mirror parsed from the output", async () => {
    ptyOnDataCallback = null;
    const terminal = createTerminal();
    expect(terminal.isBracketedPasteMode()).toBe(false);

    ptyOnDataCallback!("\x1b[?2004h❯ ");
    await vi.waitFor(() => expect(terminal.isBracketedPasteMode()).toBe(true));

    ptyOnDataCallback!("\x1b[?2004l$ ");
    await vi.waitFor(() => expect(terminal.isBracketedPasteMode()).toBe(false));

    terminal.dispose();
    expect(terminal.isBracketedPasteMode()).toBe(false);
  });
});

describe("TerminalProcess Codex limit reset (#17906)", () => {
  // 10:00 in New York (EST, UTC-5), where the pane's Codex runs.
  const seenAt = Date.UTC(2026, 10, 19, 15, 0);
  const env = { TZ: "America/New_York" };
  const banner = "■ You’ve hit your usage limit. Try again at 3:40 PM.\r\n";
  const resetMinute = Date.UTC(2026, 10, 19, 20, 40);
  const weeklyReset = Date.UTC(2026, 10, 21, 20, 40);
  // Codex ignores TZ on Windows, so the fixture's zone only holds elsewhere.
  const itWithTz = it.skipIf(process.platform === "win32");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(seenAt);
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  const codexPane = () =>
    createTerminal({ launchAgentId: "codex" }, undefined, undefined, {
      ...defaultSpawnContext(),
      env,
    });
  const stampOf = (terminal: TerminalProcess) => {
    const answer = terminal.answerCodexLimit({}, terminal.analysisObservedSince());
    if ("reset" in answer) throw new Error(`expected a stamp, got ${JSON.stringify(answer)}`);
    return answer.stamp;
  };
  const codexBucket = (...windows: Array<{ usedPercent: number; resetsAt: number | null }>) => ({
    limitId: "codex",
    limitName: null,
    windows,
    unreadable: false,
  });

  itWithTz("answers from the banner alone, with no text leaving", async () => {
    const terminal = codexPane();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const stamp = stampOf(terminal);
    const answer = terminal.answerCodexLimit(
      { ...stamp, evidence: null },
      terminal.analysisObservedSince()
    );
    expect(answer).toEqual({
      reset: {
        status: "known",
        resetsAt: resetMinute + 60_000,
        precision: "minute",
        source: "banner",
        observedAt: stamp.observedAt,
      },
      // The sighting it is about, so a wait can be tied to it (#17909).
      stamp,
    });
    expect(JSON.stringify(answer)).not.toMatch(/usage limit|PM/);
    terminal.dispose();
  });

  itWithTz(
    "keeps yesterday's stop as yesterday's through an idle night and a repaint",
    async () => {
      const terminal = codexPane();
      ptyOnDataCallback!(banner);
      await vi.advanceTimersByTimeAsync(250);
      const sighted = stampOf(terminal);

      // Nothing all night, then a repaint after local midnight passes through a
      // blank and a half-drawn frame on its way back.
      vi.setSystemTime(Date.UTC(2026, 10, 20, 5, 30));
      ptyOnDataCallback!("\x1b[2J\x1b[H");
      await vi.advanceTimersByTimeAsync(250);
      const since = terminal.analysisObservedSince();
      expect(terminal.answerCodexLimit({}, since)).toEqual({
        reset: { status: "unknown", reason: "no-banner" },
      });
      ptyOnDataCallback!("■ You’ve hit your usage limi");
      await vi.advanceTimersByTimeAsync(250);
      expect(terminal.answerCodexLimit({}, since)).toEqual({
        reset: { status: "unknown", reason: "unreadable-banner" },
      });
      ptyOnDataCallback!("t. Try again at 3:40 PM.\r\n");
      await vi.advanceTimersByTimeAsync(250);

      // Still Thursday's 3:40 PM, long passed: never a known Friday 3:40 PM.
      expect(terminal.answerCodexLimit({ ...sighted, evidence: null }, since)).toEqual({
        reset: { status: "unknown", reason: "late-reading", observedAt: sighted.observedAt },
        stamp: sighted,
      });
      terminal.dispose();
    }
  );

  itWithTz("reads the same banner back after a prompt as a new stop", async () => {
    const terminal = codexPane();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const first = stampOf(terminal);
    ptyOnDataCallback!("\x1b[2J\x1b[H");
    await vi.advanceTimersByTimeAsync(250);
    (
      terminal as unknown as { terminalInfo: { lastTypedInputAt: number } }
    ).terminalInfo.lastTypedInputAt = Date.now();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    expect(stampOf(terminal).seq).toBe(first.seq + 1);
    terminal.dispose();
  });

  itWithTz("answers from a prompt reading, and won't from a late one that can't tell", async () => {
    const terminal = codexPane();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const stamp = stampOf(terminal);
    const since = terminal.analysisObservedSince();
    const reading = (requestedAt: number) => ({
      requestedAt,
      receivedAt: requestedAt + 1_000,
      buckets: [
        codexBucket(
          { usedPercent: 100, resetsAt: resetMinute + 42_000 },
          { usedPercent: 100, resetsAt: weeklyReset }
        ),
      ],
    });
    expect(
      terminal.answerCodexLimit({ ...stamp, evidence: reading(Date.now()) }, since)
    ).toMatchObject({ reset: { status: "known", resetsAt: weeklyReset, source: "quota" } });

    const late = resetMinute + 5 * 60_000;
    vi.setSystemTime(late);
    expect(terminal.answerCodexLimit({ ...stamp, evidence: reading(late) }, since)).toMatchObject({
      reset: { status: "unknown", reason: "late-reading" },
    });
    // Asked afresh that late, it answers without asking for a reading at all.
    expect(terminal.answerCodexLimit({}, since)).toMatchObject({
      reset: { status: "unknown", reason: "late-reading" },
    });
    terminal.dispose();
  });

  itWithTz("starts a new sighting once the banner was gone past a repaint", async () => {
    const terminal = codexPane();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const first = stampOf(terminal);
    ptyOnDataCallback!("\x1b[2J\x1b[H");
    await vi.advanceTimersByTimeAsync(10_000);
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const second = stampOf(terminal);
    expect(second.seq).toBe(first.seq + 1);
    expect(second.observedAt).toBeGreaterThan(first.observedAt + 10_000);
    terminal.dispose();
  });

  itWithTz("offers the evening before for a banner half-drawn across midnight", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 20, 4, 58, 30));
    const terminal = codexPane();
    ptyOnDataCallback!("• Working\r\n");
    await vi.advanceTimersByTimeAsync(250);

    vi.setSystemTime(Date.UTC(2026, 10, 20, 5, 0, 10));
    ptyOnDataCallback!("■ You’ve hit your usage limit.");
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!(" Try again at 11:59 PM.\r\n");
    await vi.advanceTimersByTimeAsync(250);

    // Tonight's 11:59 PM, or last night's, which has passed: it can't be told.
    expect(terminal.answerCodexLimit({}, terminal.analysisObservedSince())).toMatchObject({
      reset: { status: "unknown", reason: "ambiguous-time" },
    });
    terminal.dispose();
  });

  it("answers for its own process and agent run only", async () => {
    const replaced = codexPane();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const replacedStamp = stampOf(replaced);
    replaced.dispose();

    const terminal = codexPane();
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    const stamp = stampOf(terminal);
    // A replacement counts from the same sequence; only the run tells them apart.
    expect(stamp.seq).toBe(replacedStamp.seq);
    expect(stamp.run).not.toBe(replacedStamp.run);
    const since = terminal.analysisObservedSince();

    expect(
      terminal.answerCodexLimit({ seq: stamp.seq, run: "another-pane", evidence: null }, since)
    ).toEqual({ reset: { status: "unknown", reason: "banner-changed" } });
    expect(
      terminal.answerCodexLimit({ ...stamp, seq: stamp.seq + 1, evidence: null }, since)
    ).toEqual({ reset: { status: "unknown", reason: "banner-changed" } });
    expect(terminal.answerCodexLimit({}, null)).toEqual({
      reset: { status: "unknown", reason: "not-observed" },
    });
    expect(terminal.answerCodexLimit({}, (since ?? 0) + 1)).toEqual({
      reset: { status: "unknown", reason: "not-observed" },
    });

    // Another Codex took over the pane before any look at its screen.
    (
      terminal as unknown as { terminalInfo: { agentIncarnation: number } }
    ).terminalInfo.agentIncarnation = 1;
    expect(terminal.answerCodexLimit({}, since)).toEqual({
      reset: { status: "unknown", reason: "no-banner" },
    });
    terminal.dispose();
  });

  it("answers a credit stop outright and stops answering once the banner is gone", async () => {
    const terminal = codexPane();
    ptyOnDataCallback!("■ Your workspace is out of credits. Add credits to continue.\r\n");
    await vi.advanceTimersByTimeAsync(250);
    const since = terminal.analysisObservedSince();
    expect(terminal.answerCodexLimit({}, since)).toMatchObject({
      reset: { status: "unknown", reason: "no-reset" },
    });

    ptyOnDataCallback!("line\r\n".repeat(20));
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.answerCodexLimit({}, since)).toEqual({
      reset: { status: "unknown", reason: "no-banner" },
    });
    terminal.dispose();
  });

  it("reads no Codex banner in another agent's pane", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    ptyOnDataCallback!(banner);
    await vi.advanceTimersByTimeAsync(250);
    expect(terminal.answerCodexLimit({}, terminal.analysisObservedSince())).toEqual({
      reset: { status: "unknown", reason: "no-banner" },
    });
    terminal.dispose();
  });
});

describe("TerminalProcess continuing at a Codex limit's reset (#17909)", () => {
  const unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 19, 15, 0));
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  function collect() {
    const stops: Array<Record<string, unknown>> = [];
    const offers: unknown[] = [];
    unsubscribers.push(
      events.on("agent:codex-limit-stopped", (payload) => stops.push({ ...payload })),
      events.on("agent:fallback-triggered", (payload) => offers.push(payload))
    );
    return { stops, offers };
  }

  const BANNER = "■ You’ve hit your usage limit. Try again at 3:40 PM.";
  /** Codex 0.170 at its stop: the banner, then the composer's tinted band and its footer. */
  const stopScreen = (footer = "  ? for shortcuts") =>
    "\x1b[?2004h\x1b[2J\x1b[H• Ran the tests.\r\n\r\n" +
    `${BANNER}\r\n\r\n` +
    "\x1b[48;2;30;30;30m\x1b[K\r\n" +
    "\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m\x1b[K\r\n" +
    "\x1b[K\x1b[0m\r\n" +
    footer;

  type Internals = {
    terminalInfo: { ptyProcess: IPty; agentState?: string; waitingReason?: string };
  };
  const infoOf = (terminal: TerminalProcess) => (terminal as unknown as Internals).terminalInfo;

  async function stoppedPane({ armed = true, footer }: { armed?: boolean; footer?: string } = {}) {
    const seen = collect();
    const terminal = createTerminal({ launchAgentId: "codex" });
    if (armed) terminal.setCodexLimitContinueArmed(true);
    ptyOnDataCallback!(stopScreen(footer));
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    const write = vi.spyOn(infoOf(terminal).ptyProcess, "write");
    const typed = () => write.mock.calls.map(([data]) => data).join("");
    return { terminal, seen, typed };
  }

  const stopOf = (seen: { stops: Array<Record<string, unknown>> }) => {
    const { run, seq } = seen.stops[0] as { run: string; seq: number };
    return { run, seq };
  };

  async function continueAt(terminal: TerminalProcess, stop: { run: string; seq: number }) {
    const result = terminal.continueAtCodexLimit(stop);
    await vi.advanceTimersByTimeAsync(2_000);
    return result;
  }

  it("reports an armed pane's settled stop once, as its process and sighting alone", async () => {
    const { terminal, seen } = await stoppedPane();
    expect(seen.stops).toEqual([
      { terminalId: "t1", run: expect.any(String), seq: 1, timestamp: expect.any(Number) },
    ]);
    // Sitting there, or repainted, is the same stop.
    ptyOnDataCallback!(stopScreen());
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 4);
    expect(seen.stops).toHaveLength(1);
    // A pane launched with no preset never offers a fallback.
    expect(seen.offers).toEqual([]);
    terminal.dispose();
  });

  it("reports nothing for an unarmed pane, and the stop already on screen once armed", async () => {
    const { terminal, seen } = await stoppedPane({ armed: false });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 4);
    expect(seen.stops).toEqual([]);

    terminal.setCodexLimitContinueArmed(true);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen.stops).toHaveLength(1);
    terminal.dispose();
  });

  it("types `continue` into a pane still where its limit left it", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    expect(await continueAt(terminal, stopOf(seen))).toEqual({
      status: "continued",
      line: "continue",
    });
    expect(typed()).toBe("continue\r");
    terminal.dispose();
  });

  it("resumes a /goal run whose footer says it hit the limit", async () => {
    const { terminal, seen, typed } = await stoppedPane({
      footer: "  Goal hit usage limits (/goal resume)",
    });
    expect(await continueAt(terminal, stopOf(seen))).toEqual({
      status: "continued",
      line: "/goal resume",
    });
    expect(typed()).toBe("/goal resume\r");
    terminal.dispose();
  });

  it("types nothing after any input since the stop", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    terminal.write("x");
    terminal.write("\x7f");
    expect(await continueAt(terminal, stopOf(seen))).toEqual({
      status: "skipped",
      reason: "input-since",
    });
    expect(typed()).not.toContain("continue");
    terminal.dispose();
  });

  it("counts an Enter alone, sent through the input lane, as input since the stop", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    terminal.submit("\r");
    await vi.advanceTimersByTimeAsync(500);
    expect(await continueAt(terminal, stopOf(seen))).toEqual({
      status: "skipped",
      reason: "input-since",
    });
    expect(typed()).not.toContain("continue");
    terminal.dispose();
  });

  it("keeps what happened since the stop when the same banner comes back after a while", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    // A transcript opened over the stop for a while, then closed.
    terminal.write("\x14");
    ptyOnDataCallback!("\x1b[2J\x1b[H  Transcript\r\n");
    await vi.advanceTimersByTimeAsync(10_000);
    terminal.write("q");
    ptyOnDataCallback!(stopScreen());
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(seen.stops).toHaveLength(2);
    const redisplayed = seen.stops[1] as { run: string; seq: number };
    expect(await continueAt(terminal, { run: redisplayed.run, seq: redisplayed.seq })).toEqual({
      status: "skipped",
      reason: "input-since",
    });
    expect(typed()).toBe("\x14q");
    terminal.dispose();
  });

  it("starts afresh at the same banner when a new turn ran into it", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    terminal.write("try again\r");
    ptyOnDataCallback!("\x1b[2J\x1b[H› try again\r\n\r\n• Working (2s)\r\n");
    await vi.advanceTimersByTimeAsync(250);
    ptyOnDataCallback!(
      "\x1b[2J\x1b[H› try again\r\n\r\n• Looked at the failing test.\r\n\r\n" +
        `${BANNER}\r\n\r\n` +
        "\x1b[48;2;30;30;30m\x1b[K\r\n" +
        "\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m\x1b[K\r\n" +
        "\x1b[K\x1b[0m\r\n  ? for shortcuts"
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.stops).toHaveLength(2);
    const next = seen.stops[1] as { run: string; seq: number };
    expect(await continueAt(terminal, { run: next.run, seq: next.seq })).toEqual({
      status: "continued",
      line: "continue",
    });
    expect(typed()).toBe("try again\rcontinue\r");
    terminal.dispose();
  });

  it("withholds the Enter of a line disarmed while it waits for it", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    const result = terminal.continueAtCodexLimit(stopOf(seen));
    await vi.advanceTimersByTimeAsync(0);
    expect(typed()).toBe("continue");
    terminal.setCodexLimitContinueArmed(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual({ status: "skipped", reason: "not-delivered" });
    expect(typed()).toBe("continue");
    terminal.dispose();
  });

  it("refuses a line asked for under an arming that was turned off and on again", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    const result = terminal.continueAtCodexLimit(stopOf(seen));
    terminal.setCodexLimitContinueArmed(false);
    terminal.setCodexLimitContinueArmed(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual({ status: "skipped", reason: "disarmed" });
    expect(typed()).toBe("");
    terminal.dispose();
  });

  it("types nothing once a choice dialog showed after the stop, though it has gone", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    const info = infoOf(terminal);
    info.agentState = "waiting";
    info.waitingReason = "approval";
    ptyOnDataCallback!(stopScreen());
    await vi.advanceTimersByTimeAsync(250);
    info.waitingReason = "error";
    expect(await continueAt(terminal, stopOf(seen))).toEqual({
      status: "skipped",
      reason: "dialog-since",
    });
    expect(typed()).toBe("");
    terminal.dispose();
  });

  it("types nothing for another process's stop, or once disarmed", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    const stop = stopOf(seen);
    expect(await continueAt(terminal, { ...stop, run: "an-earlier-process" })).toEqual({
      status: "skipped",
      reason: "process-changed",
    });
    terminal.setCodexLimitContinueArmed(false);
    expect(await continueAt(terminal, stop)).toEqual({ status: "skipped", reason: "disarmed" });
    expect(typed()).toBe("");
    terminal.dispose();
  });

  it("types nothing once something was printed below the banner", async () => {
    const { terminal, seen, typed } = await stoppedPane();
    ptyOnDataCallback!(
      "\x1b[2J\x1b[H" +
        `${BANNER}\r\n\r\n• Retrying the request\r\n\r\n` +
        "\x1b[48;2;30;30;30m\x1b[K\r\n" +
        "\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m\x1b[K\r\n" +
        "\x1b[K\x1b[0m\r\n  ? for shortcuts"
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(await continueAt(terminal, stopOf(seen))).toEqual({
      status: "skipped",
      reason: "banner-not-last",
    });
    expect(typed()).toBe("");
    terminal.dispose();
  });
});

describe("TerminalProcess continuing a Claude Code pane once its own wait is gone (#18192)", () => {
  const unsubscribers: Array<() => void> = [];
  // 3pm UTC; the banner's reset is 9pm UTC the same day.
  const resetsAt = Date.UTC(2026, 10, 19, 21, 0) + 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 19, 15, 0));
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  const RULE = "─".repeat(78);
  const BANNER = "  ⎿  You've hit your weekly limit · resets 9pm (UTC)";
  const CANCELLED = "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm";
  const COUNTDOWN = "  Usage limit reached · continuing automatically at 9pm · esc to cancel";
  /** Claude Code 2.1 at a plan limit: the banner, then its composer and footer. */
  const claudeScreen = ({
    notice = [] as string[],
    footer = "  ⏵⏵ accept edits on (shift+tab to cycle)",
    after = [] as string[],
  } = {}) =>
    "\x1b[2J\x1b[H" +
    [
      "● Refactoring the parser.",
      BANNER,
      "     /upgrade to increase your usage limit.",
      "",
      ...notice,
      ...after,
      RULE,
      "❯ ",
      RULE,
      footer,
    ].join("\r\n");
  const countdownScreen = () => claudeScreen({ footer: COUNTDOWN });
  const cancelledScreen = () => claudeScreen({ notice: [CANCELLED, ""] });

  function collect() {
    const stops: Array<{ run: string; seq: number }> = [];
    unsubscribers.push(
      events.on("agent:codex-limit-stopped", (payload) =>
        stops.push({ run: payload.run, seq: payload.seq })
      )
    );
    return stops;
  }

  type Internals = { terminalInfo: { ptyProcess: IPty } };
  async function armedClaudePane(first: string) {
    const stops = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });
    terminal.setCodexLimitContinueArmed(true);
    ptyOnDataCallback!(first);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    const write = vi.spyOn((terminal as unknown as Internals).terminalInfo.ptyProcess, "write");
    const typed = () => write.mock.calls.map(([data]) => data).join("");
    return { terminal, stops, typed };
  }

  async function show(screen: string) {
    ptyOnDataCallback!(screen);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
  }

  const answer = (terminal: TerminalProcess) =>
    terminal.answerCodexLimit({}, terminal.analysisObservedSince());

  async function continueAt(terminal: TerminalProcess, stop: { run: string; seq: number }) {
    const result = terminal.continueAtCodexLimit(stop);
    await vi.advanceTimersByTimeAsync(2_000);
    return result;
  }

  it("holds no stop while Claude's own countdown is on screen, and types nothing once it continues by itself", async () => {
    const { terminal, stops, typed } = await armedClaudePane(countdownScreen());
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS * 4);
    expect(stops).toEqual([]);
    expect(answer(terminal)).toEqual({ reset: { status: "unknown", reason: "no-banner" } });

    // Claude's own wait ran out and it took the turn up again.
    await show(claudeScreen({ after: ["> continue", "", "● Picking up where the parser left off.", ""] }));
    expect(stops).toEqual([]);
    expect(typed()).toBe("");
    terminal.dispose();
  });

  it("continues at the reset once an assistant's Escape cancelled the countdown", async () => {
    const { terminal, stops, typed } = await armedClaudePane(countdownScreen());
    terminal.write("\x1b", undefined, "assistant-1");
    await show(cancelledScreen());

    expect(stops).toHaveLength(1);
    const reply = answer(terminal);
    expect(reply).toEqual({
      reset: {
        status: "known",
        resetsAt,
        precision: "minute",
        source: "banner",
        observedAt: expect.any(Number),
      },
      stamp: { run: stops[0]!.run, seq: stops[0]!.seq, observedAt: expect.any(Number) },
    });
    expect(JSON.stringify(reply)).not.toMatch(/limit|9pm/);
    expect(await continueAt(terminal, stops[0]!)).toEqual({ status: "continued", line: "continue" });
    expect(typed()).toBe("\x1bcontinue\r");
    terminal.dispose();
  });

  it("leaves the pane stopped when a person's Escape cancelled the countdown", async () => {
    const { terminal, stops, typed } = await armedClaudePane(countdownScreen());
    terminal.write("\x1b");
    await show(cancelledScreen());

    expect(stops).toHaveLength(1);
    expect(answer(terminal)).toMatchObject({
      reset: { status: "known", resetsAt },
      skipAtStop: "auto-continue-cancelled",
    });
    terminal.dispose();
    expect(typed()).toBe("\x1b");
  });

  it("tells a person's Escape from an assistant's even when the cancelled screen is the first one seen", async () => {
    const idle = claudeScreen({ after: [] }).replace(BANNER, "● Done.");
    const person = await armedClaudePane(idle);
    person.terminal.write("\x1b");
    await show(cancelledScreen());
    expect(answer(person.terminal)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
    person.terminal.dispose();

    const assistant = await armedClaudePane(idle);
    assistant.terminal.write("\x1b", undefined, "assistant-1");
    await show(cancelledScreen());
    expect(answer(assistant.terminal)).not.toHaveProperty("skipAtStop");
    assistant.terminal.dispose();
  });

  it("counts a person's key beside an assistant's Escape as the person's", async () => {
    const { terminal } = await armedClaudePane(countdownScreen());
    terminal.write("\x1b", undefined, "assistant-1");
    terminal.write("x");
    await show(cancelledScreen());
    expect(answer(terminal)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
    terminal.dispose();
  });

  it("types nothing after input written once the cancelled screen showed", async () => {
    const { terminal, stops, typed } = await armedClaudePane(countdownScreen());
    terminal.write("\x1b", undefined, "assistant-1");
    await show(cancelledScreen());
    terminal.write("x");
    terminal.write("\x7f");
    expect(await continueAt(terminal, stops[0]!)).toEqual({
      status: "skipped",
      reason: "input-since",
    });
    expect(typed()).not.toContain("continue");
    terminal.dispose();
  });

  it("continues a stop already on screen when the pane is armed, and again after a person's Escape once re-armed", async () => {
    const stops = collect();
    const terminal = createTerminal({ launchAgentId: "claude" });
    terminal.write("\x1b");
    ptyOnDataCallback!(cancelledScreen());
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(stops).toEqual([]);

    terminal.setCodexLimitContinueArmed(true);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_SETTLE_MS + 500);
    expect(stops).toHaveLength(1);
    expect(answer(terminal)).not.toHaveProperty("skipAtStop");
    expect(await continueAt(terminal, stops[0]!)).toEqual({ status: "continued", line: "continue" });
    terminal.dispose();
  });

  it("continues a limit Claude drew no wait for at all", async () => {
    const { terminal, stops, typed } = await armedClaudePane(claudeScreen());
    expect(stops).toHaveLength(1);
    expect(answer(terminal)).toMatchObject({ reset: { status: "known", resetsAt } });
    expect(answer(terminal)).not.toHaveProperty("skipAtStop");
    expect(await continueAt(terminal, stops[0]!)).toEqual({ status: "continued", line: "continue" });
    expect(typed()).toBe("continue\r");
    terminal.dispose();
  });

  it("types nothing once Claude's own countdown is back on screen", async () => {
    const { terminal, stops, typed } = await armedClaudePane(countdownScreen());
    terminal.write("\x1b", undefined, "assistant-1");
    await show(cancelledScreen());
    await show(claudeScreen({ notice: [CANCELLED, ""], footer: COUNTDOWN }));
    expect(await continueAt(terminal, stops[0]!)).toEqual({ status: "skipped", reason: "own-wait" });
    expect(typed()).toBe("\x1b");
    terminal.dispose();
  });

  it("drops the stop when the pane is disarmed", async () => {
    const { terminal, stops } = await armedClaudePane(claudeScreen());
    terminal.setCodexLimitContinueArmed(false);
    expect(answer(terminal)).toEqual({ reset: { status: "unknown", reason: "no-banner" } });
    expect(await continueAt(terminal, stops[0]!)).toEqual({ status: "skipped", reason: "disarmed" });
    terminal.dispose();
  });
});
