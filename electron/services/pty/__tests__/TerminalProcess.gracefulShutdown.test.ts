import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS, GRACEFUL_SHUTDOWN_TIMEOUT_MS } from "../types.js";
import { SUBMIT_ENTER_DELAY_MS } from "../terminalInput.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { logBuffer } from "../../LogBuffer.js";
import { getLogLevelOverrides, setLogLevelOverrides } from "../../../utils/logger.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

// Built rather than written as an escape in a pattern: eslint's `no-control-regex`
// is error-level in this repo, so a raw control char must never reach a regex
// literal. Keeping the byte in one named constant also makes every assertion
// below read as "the Ctrl-C press" rather than as an opaque escape.
const CTRL_C = String.fromCharCode(3);

/**
 * Mirrors `shared/config/agents/codex.ts`'s `shutdownSignal`. Deliberately NOT
 * imported from the config: these tests drive the escalation's timing, and
 * reading the same numbers the implementation reads would make them agree by
 * construction. If Codex's tuning changes, these should fail and be re-derived.
 */
const CODEX_PER_PRESS_TIMEOUT_MS = 750;
const CODEX_MAX_PRESSES = 3;

interface MockPtyHandles {
  pty: IPty;
  writeMock: ReturnType<typeof vi.fn<(data: string) => void>>;
  emitData: (data: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
  /**
   * Deliver an exit event to the observer even after it was disposed —
   * node-pty can hand over an already-queued exit during teardown, which is
   * exactly the re-entry `finish()`'s `resolved` guard exists to absorb.
   * `emitExit` can't reach it because dispose drops the callback first.
   */
  emitExitIgnoringDispose: (exitCode: number, signal?: number) => void;
  onDataDispose: ReturnType<typeof vi.fn>;
  onExitDispose: ReturnType<typeof vi.fn>;
}

function createMockPty(writeOverride?: (data: string) => void): MockPtyHandles {
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  let undisposedExitCallback: ((event: { exitCode: number; signal?: number }) => void) | null =
    null;

  const writeMock = vi.fn<(data: string) => void>();
  const onDataDispose = vi.fn(() => {
    dataCallback = null;
  });
  const onExitDispose = vi.fn(() => {
    exitCallback = null;
  });

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
    onData: (cb: (data: string) => void) => {
      dataCallback = cb;
      return { dispose: onDataDispose };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCallback = cb;
      undisposedExitCallback = cb;
      return { dispose: onExitDispose };
    },
  };

  return {
    pty: pty as IPty,
    writeMock,
    emitData: (data: string) => dataCallback?.(data),
    emitExit: (exitCode: number, signal?: number) => exitCallback?.({ exitCode, signal }),
    emitExitIgnoringDispose: (exitCode: number, signal?: number) =>
      undisposedExitCallback?.({ exitCode, signal }),
    onDataDispose,
    onExitDispose,
  };
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

function createAgentTerminal(handles: MockPtyHandles, agentId = "claude"): TerminalProcess {
  const opts: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
    launchAgentId: agentId,
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

/**
 * A terminal whose session id was known at spawn (#11782) — the shape produced
 * when the launch assigned the id via `resume.assignSessionIdArgs`, or when a
 * restore relaunched into a conversation it already had the id for.
 */
function createAgentTerminalWithSession(
  handles: MockPtyHandles,
  agentId: string,
  agentSessionId: string
): TerminalProcess {
  const opts: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
    launchAgentId: agentId,
    agentSessionId,
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

describe("TerminalProcess.gracefulShutdown — input-clear prelude", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes Ctrl-E + Ctrl-U then submits Claude's /quit body and Enter as a single write", async () => {
    // Issue #6981: Claude Code (Ink TUI) requires body + Enter in one PTY
    // write — any gap between them is treated as deliberate slow typing
    // and the slash-command parser never fires, so no session-ID line is
    // ever echoed. Claude is configured with `quitSubmitMode: "single-write"`.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();

    // Let microtasks run so the async IIFE inside gracefulShutdown emits the first write.
    await Promise.resolve();
    await Promise.resolve();

    // Only the clear prelude should have been written — not the quit command yet.
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");

    // Advance past the clear delay and the combined quit+Enter write should fire.
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit\r");

    // Emit the session-ID line and the promise should resolve with the captured ID.
    handles.emitData("claude --resume abc-123\n");
    await expect(shutdownPromise).resolves.toBe("abc-123");

    // The captured ID must also be stored on the terminal for resume-later callers.
    expect(terminal.getInfo().agentSessionId).toBe("abc-123");
  });

  it("captures session ID when surrounded by ANSI erase sequences from the clear prelude", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    // The CLI echoes back ANSI erase sequences in response to Ctrl-U before the real
    // session-ID line. stripAnsiCodes in the matcher should strip these cleanly.
    handles.emitData("\x1b[2K\x1b[0G");
    handles.emitData("claude --resume session-xyz\n");

    await expect(shutdownPromise).resolves.toBe("session-xyz");
  });

  it("waits for a terminator before accepting a capture that ends at the buffer tail", async () => {
    // Repro: Gemini's resume hint arrives in two PTY chunks. The first chunk
    // ends mid-UUID at "fc1c3a37-2294-4". Without a trailing-terminator guard,
    // the greedy `[\w-]+` capture matches the partial token and resume-on-
    // restart hands the agent an invalid 14-char identifier.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "gemini");

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    handles.emitData("Resume with: gemini --resume fc1c3a37-2294-4");
    // First chunk ends mid-UUID — capture must NOT resolve yet.
    await Promise.resolve();
    await Promise.resolve();

    handles.emitData("c8d-9abc-1234567890ab\n");
    await expect(shutdownPromise).resolves.toBe("fc1c3a37-2294-4c8d-9abc-1234567890ab");
  });

  it("resolves null when no session ID is emitted before the shutdown timeout", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    await expect(shutdownPromise).resolves.toBeNull();
    // Prelude and combined quit+Enter must both be attempted before timeout.
    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit\r");
  });

  it("skips the quit write when the PTY exits during the clear-delay window", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();

    // Wait for the prelude write, then fire onExit before the delay timer elapses.
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    handles.emitExit(0);

    // Advance past the clear delay — the guarded branch should short-circuit and
    // NOT issue the quit command after the process has already exited.
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    await expect(shutdownPromise).resolves.toBeNull();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
  });

  it("resolves null when the clear-prelude write throws, without attempting the quit write", async () => {
    let firstCall = true;
    const handles = createMockPty((data: string) => {
      if (firstCall && data === "\x05\x15") {
        firstCall = false;
        throw new Error("pty dead");
      }
    });
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await expect(shutdownPromise).resolves.toBeNull();

    // Only the throwing prelude write should have been attempted.
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
  });

  it("resolves null when the quit-command write throws after a successful prelude", async () => {
    const handles = createMockPty((data: string) => {
      if (data === "/quit\r") {
        throw new Error("pty dead after prelude");
      }
    });
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    await expect(shutdownPromise).resolves.toBeNull();
    expect(handles.writeMock).toHaveBeenCalledTimes(2);
  });

  it("returns null immediately for a terminal without agent shutdown config", async () => {
    const handles = createMockPty();
    const terminal = new TerminalProcess(
      "t-no-agent",
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
      },
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

    await expect(terminal.gracefulShutdown()).resolves.toBeNull();
    expect(handles.writeMock).not.toHaveBeenCalled();
  });

  it("skips quit injection when agent already exited via /quit (issue #6605)", async () => {
    // Repro #6605: user types /quit, terminal demotes to plain shell (agentState
    // becomes "exited", detectedAgentId clears) but launchAgentId persists. On
    // app shutdown, gracefulShutdown must NOT inject /quit into what is now a
    // plain interactive shell.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    terminal.getInfo().agentState = "exited";
    terminal.getInfo().detectedAgentId = undefined;

    await expect(terminal.gracefulShutdown()).resolves.toBeNull();
    expect(handles.writeMock).not.toHaveBeenCalled();
  });

  it("skips the quit write when the agent demotes during the clear-delay window", async () => {
    // Race-guard companion to the #6605 fix: if the agent exits between the
    // prelude write and the clear-delay timeout, the post-delay write must
    // also short-circuit — otherwise /quit lands in a plain shell.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();

    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    // Demote mid-flight — same mutation the demotion path performs.
    terminal.getInfo().agentState = "exited";
    terminal.getInfo().detectedAgentId = undefined;

    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    await expect(shutdownPromise).resolves.toBeNull();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
  });

  it("still injects quit for a live launched agent that has not been detected yet", async () => {
    // Regression guard: the new isAgentLive gate must NOT block cold-launched
    // agents that haven't yet been detected by the process tree scan
    // (launchAgentId set, detectedAgentId undefined, agentState !== "exited").
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit\r");

    handles.emitData("claude --resume live-agent\n");
    await expect(shutdownPromise).resolves.toBe("live-agent");
  });

  it("skips Enter when the split-write agent demotes during the quit-submit delay", async () => {
    // Mid-flight liveness guard for the split-write path only — a readline/
    // Ratatui CLI writes the body and Enter as separate PTY writes with a delay
    // between them. If the agent demotes during that gap, the trailing Enter
    // must be skipped so it doesn't land in a plain shell. Claude uses
    // single-write so this guard isn't reachable for it, and Codex no longer
    // writes a quit command at all (#11851) — Gemini is the split-write agent
    // that still exercises it.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "gemini");

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit");

    terminal.getInfo().agentState = "exited";
    terminal.getInfo().detectedAgentId = undefined;

    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);

    await expect(shutdownPromise).resolves.toBeNull();
    expect(handles.writeMock).toHaveBeenCalledTimes(2);
  });

  it("project-scoped (Kiro) skips the session-ID capture loop and resolves null", async () => {
    // Lesson #4781: agents with directory-based sessions never emit session
    // IDs. The capture regex must NOT run for `project-scoped` resume kinds
    // — otherwise a stale match against unrelated terminal output could
    // poison `terminal.agentSessionId` for the next launch.
    const handles = createMockPty();
    const opts: TerminalProcessOptions = {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      launchAgentId: "kiro",
    };
    const terminal = new TerminalProcess(
      "t-kiro",
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

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit");

    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(handles.writeMock).toHaveBeenCalledTimes(3);
    expect(handles.writeMock.mock.calls[2]?.[0]).toBe("\r");

    // Emit a string that LOOKS like a Claude session-ID line — it must be
    // ignored (Kiro doesn't have a sessionIdPattern at all in the new schema).
    handles.emitData("claude --resume bogus-id\n");
    handles.emitExit(0);

    await expect(shutdownPromise).resolves.toBeNull();
    expect(terminal.getInfo().agentSessionId).toBeUndefined();
  });
});

describe("TerminalProcess.gracefulShutdown — gated Ctrl-C escalation (#11851)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Every resolved shutdown ends in TerminalProcess.kill(), which arms a
    // ~500ms SIGKILL escalation in ProcessTreeKiller. Left queued, the next
    // test's timer advance fires it and sweeps the mock's pid — a real number —
    // against the real OS.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** One Ratatui repaint of the confirm-to-quit footer, with its usual ANSI dressing. */
  function footerFrame(): string {
    return "\x1b[2K\x1b[0G  Ctrl+C again to quit  \x1b[0m";
  }

  it("writes Ctrl-C as its very first byte, never the prelude or a quit command", async () => {
    // The whole point of the issue: `\x05\x15` assumes readline semantics
    // Codex does not have, and `/quit` mid-turn is queued as a chat message
    // that ends up in the user's transcript and in Codex's own resume picker.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    expect(handles.writeMock).toHaveBeenCalledTimes(1);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe(CTRL_C);

    handles.emitData("  codex resume gated-1\n");
    await expect(promise).resolves.toBe("gated-1");

    const written = handles.writeMock.mock.calls.map((c) => c[0]);
    expect(written.every((chunk) => chunk === CTRL_C)).toBe(true);
    expect(written.join("")).not.toContain("/quit");
  });

  it("stops at one press when that press was enough", async () => {
    // An idle session with a clean composer quits on the first press and never
    // prints the footer at all. Pressing again on a process already on its way
    // out is the fatal case, so silence must mean stop.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    handles.emitData("  codex resume single-press\n");
    await expect(promise).resolves.toBe("single-press");
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
  });

  it("sends the next press only after a fresh gate match", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    // Most of the per-press window passes with no footer: still one press.
    await vi.advanceTimersByTimeAsync(CODEX_PER_PRESS_TIMEOUT_MS - 50);
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    handles.emitData(footerFrame());
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe(CTRL_C);

    handles.emitData("  codex resume two-press\n");
    await expect(promise).resolves.toBe("two-press");
  });

  it("spends one press per gate arm no matter how often the footer repaints", async () => {
    // Ratatui repaints the whole frame every tick, so one absorbed press
    // produces the footer text over and over. Counting matches instead of
    // latching per arm would burn the press budget on a single confirmation and
    // walk straight into the third press that measured as fatal.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    // Five repaints of the same confirmation, all landing before the loop gets
    // a chance to arm its next press.
    for (let i = 0; i < 5; i++) {
      handles.emitData(footerFrame());
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(handles.writeMock).toHaveBeenCalledTimes(2);

    handles.emitData("  codex resume no-double-fire\n");
    await expect(promise).resolves.toBe("no-double-fire");
    expect(handles.writeMock).toHaveBeenCalledTimes(2);
  });

  it("matches a gate string split across two PTY chunks", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    handles.emitData("  Ctrl+C ag");
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    handles.emitData("ain to quit  ");
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(2);

    handles.emitData("  codex resume split-gate\n");
    await expect(promise).resolves.toBe("split-gate");
  });

  it("keeps listening for the whole budget after the gate goes quiet", async () => {
    // The measured resume hint lands 0.76-1.16s after the first press. Treating
    // an unanswered gate as a reason to finish would kill the terminal while its
    // hint was still in flight — worse than the code this replaces.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    // Gate never matches: the escalation gives up after one press...
    await vi.advanceTimersByTimeAsync(CODEX_PER_PRESS_TIMEOUT_MS + 10);
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    // ...but the terminal is still alive and still scraping.
    handles.emitData("  codex resume late-hint\n");
    await expect(promise).resolves.toBe("late-hint");
    expect(terminal.getInfo().agentSessionId).toBe("late-hint");
  });

  it("never exceeds the configured press cap, and still waits out the budget", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    // Answer every gate, so only the cap can stop the escalation.
    for (let i = 0; i < CODEX_MAX_PRESSES + 2; i++) {
      handles.emitData(footerFrame());
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(handles.writeMock).toHaveBeenCalledTimes(CODEX_MAX_PRESSES);

    handles.emitData("  codex resume capped\n");
    await expect(promise).resolves.toBe("capped");
    expect(handles.writeMock).toHaveBeenCalledTimes(CODEX_MAX_PRESSES);
  });

  it("sends no further press once the process has exited", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    handles.emitData("  codex resume on-exit-capture");
    handles.emitExit(0);

    await expect(promise).resolves.toBe("on-exit-capture");

    // A footer racing in behind the exit must not resurrect the escalation.
    handles.emitData(footerFrame());
    await vi.advanceTimersByTimeAsync(CODEX_PER_PRESS_TIMEOUT_MS * 2);
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
  });

  it("stops pressing when the capture wins between two presses", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    // One frame carrying both the footer and the resume hint: the capture has
    // to win, or the escalation presses again on an agent already quitting.
    handles.emitData(`${footerFrame()}\n  codex resume same-frame\n`);
    await expect(promise).resolves.toBe("same-frame");
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
  });

  it("leaves room to hear the resume hint even when a press stalls", async () => {
    // A press whose gate never answers costs a full `perPressTimeoutMs` and
    // then ends the escalation — but that press may well be the one that quit
    // the agent, whose hint was measured arriving up to 1160ms later. So the
    // stall plus the hint has to fit the per-terminal budget, and the whole
    // escalation must not be able to consume it outright. Read from the real
    // config so a retune has to face both numbers.
    const MEASURED_HINT_LATENCY_MS = 1160;
    const resume = getAgentConfig("codex")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind !== "session-id") return;
    const signal = resume.shutdownSignal;
    expect(signal).toBeDefined();
    const perPress = signal?.perPressTimeoutMs ?? Infinity;
    expect(perPress + MEASURED_HINT_LATENCY_MS).toBeLessThan(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    expect((signal?.maxPresses ?? Infinity) * perPress).toBeLessThanOrEqual(
      GRACEFUL_SHUTDOWN_TIMEOUT_MS
    );
  });

  it("gives up at the overall budget rather than pressing past it", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    await expect(promise).resolves.toBeNull();
    expect(handles.writeMock.mock.calls.length).toBeLessThanOrEqual(CODEX_MAX_PRESSES);
  });
});

describe("TerminalProcess.gracefulShutdown — input lock (#11851)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refuses user input for the duration and releases it when the teardown ends", async () => {
    // Teardown writes bypass TerminalInputController entirely, so without the
    // lock a keystroke on the <=512-byte fast path lands between two presses —
    // in the agent's composer, and in the middle of the press economics the
    // gate depends on.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    const writesBefore = handles.writeMock.mock.calls.length;
    terminal.write("hello");
    terminal.submit("some prompt");
    terminal.stage("staged text");
    expect(handles.writeMock.mock.calls.length).toBe(writesBefore);
    expect(terminal.tryWrite("x").ok).toBe(false);

    handles.emitData("  codex resume locked\n");
    await expect(promise).resolves.toBe("locked");
  });

  it("drops input still pacing through the write queue", async () => {
    // A chunked paste mid-flight would otherwise keep emitting its chunks on
    // the pacing timer, straight into the shutdown exchange.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    terminal.write("x".repeat(4096));
    const queuedBefore = handles.writeMock.mock.calls.length;
    expect(queuedBefore).toBeGreaterThan(0);

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    // Only the Ctrl-C press was added; the rest of the paste is gone.
    expect(handles.writeMock.mock.calls.length).toBe(queuedBefore + 1);
    await vi.advanceTimersByTimeAsync(CODEX_PER_PRESS_TIMEOUT_MS);
    const written = handles.writeMock.mock.calls.map((c) => c[0]);
    expect(written.filter((chunk) => chunk.startsWith("x"))).toHaveLength(1);

    handles.emitData("  codex resume paste-dropped\n");
    await expect(promise).resolves.toBe("paste-dropped");
  });

  it("releases the lock even when the kill on the way out throws", async () => {
    // finish() calls host.kill() from inside the onData listener, so a throw
    // there unwinds into node-pty's emitter rather than this promise — leaving
    // it forever pending and the input lock forever held. The captured id has
    // to come back regardless of whether the kill succeeded.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");
    vi.spyOn(terminal, "kill").mockImplementation(() => {
      throw new Error("kill exploded");
    });

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();
    handles.emitData("  codex resume kill-throws\n");

    await expect(promise).resolves.toBe("kill-throws");

    // Input works again despite the throw.
    const writesBefore = handles.writeMock.mock.calls.length;
    terminal.write("after");
    expect(handles.writeMock.mock.calls.length).toBe(writesBefore + 1);
  });
});

describe("TerminalProcess.gracefulShutdown — listener disposal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disposes both onData and onExit observers when the timeout fires", async () => {
    // Pre-fix the timeout path leaked both listeners — `finish()` only
    // cleared the timer and called host.kill(). Now disposal is centralized
    // in `finish()` so every resolution path frees the observers.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    await expect(shutdownPromise).resolves.toBeNull();

    expect(handles.onDataDispose).toHaveBeenCalled();
    expect(handles.onExitDispose).toHaveBeenCalled();
  });

  it("disposes both observers when the session-ID pattern matches", async () => {
    // Pre-fix the pattern-match path disposed only `origOnData`; `origOnExit`
    // remained registered until the PTY was GC'd. The centralized
    // `finish()` now disposes both.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    handles.emitData("claude --resume captured-session\n");
    await expect(shutdownPromise).resolves.toBe("captured-session");

    expect(handles.onDataDispose).toHaveBeenCalled();
    expect(handles.onExitDispose).toHaveBeenCalled();
  });

  it("disposes both observers when the PTY exits naturally", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    handles.emitExit(0);
    await expect(shutdownPromise).resolves.toBeNull();

    expect(handles.onDataDispose).toHaveBeenCalled();
    expect(handles.onExitDispose).toHaveBeenCalled();
  });
});

describe("TerminalProcess.gracefulShutdown — outcome logging", () => {
  const SOURCE = "pty:TerminalGracefulShutdown";
  let savedOverrides: Record<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    savedOverrides = getLogLevelOverrides();
    // Vitest runs with NODE_ENV=development, which floors the logger at
    // "debug". Pin it to production's "info" floor: these lines only earn
    // their keep if they reach daintree.log on a user's machine, so an
    // implementation that emitted them at debug must fail here rather than
    // pass on the looser dev floor.
    setLogLevelOverrides({ "*": "info" });
    logBuffer.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setLogLevelOverrides(savedOverrides);
    logBuffer.clear();
  });

  function shutdownEntries() {
    return logBuffer.getFiltered({ sources: [SOURCE] });
  }

  function contextOf(entry: { context?: unknown } | undefined) {
    return entry?.context as
      | {
          terminalId?: string;
          projectId?: string | null;
          agentId?: string;
          outcome?: string;
          captured?: boolean;
          elapsedMs?: number;
        }
      | undefined;
  }

  /**
   * The outcome of the single entry logged so far, asserting there is exactly
   * one and that it actually names something. Returning `undefined` on a
   * missing outcome would let a branch that logs nothing useful slip past the
   * distinctness checks below.
   */
  function soleOutcome(): string {
    const entries = shutdownEntries();
    expect(entries).toHaveLength(1);
    const outcome = contextOf(entries[0])?.outcome;
    expect(typeof outcome).toBe("string");
    expect(outcome).not.toBe("");
    logBuffer.clear();
    return outcome as string;
  }

  function createPlainTerminal(handles: MockPtyHandles): TerminalProcess {
    return new TerminalProcess(
      "t-plain",
      { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal" },
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

  it("stays silent for a terminal that never had an agent", async () => {
    // The scope gate. A plain shell fails `isAgentLive` for lack of any agent
    // id, so without the gate every non-agent pane would report
    // "agent-not-live" on each quit and bury the agent lines that matter.
    const handles = createMockPty();
    const terminal = createPlainTerminal(handles);

    await expect(terminal.gracefulShutdown()).resolves.toBeNull();

    expect(shutdownEntries()).toHaveLength(0);
  });

  // Every branch that is reachable without mocking the agent registry, each
  // driven to completion and reduced to the outcome it logged. `no-quit-signal`
  // is absent on purpose: no agent in the roster ships a resume config lacking
  // both a quitCommand and a shutdownKeySequence, so it is defensive-only.
  const BRANCHES: Record<string, () => Promise<string>> = {
    async alreadyExited() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      terminal.getInfo().isExited = true;
      await expect(terminal.gracefulShutdown()).resolves.toBeNull();
      return soleOutcome();
    },

    // `wasKilled` is set when a kill is *requested*; the process may still be
    // running. Distinct from having already exited.
    async alreadyKilled() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      terminal.getInfo().wasKilled = true;
      await expect(terminal.gracefulShutdown()).resolves.toBeNull();
      return soleOutcome();
    },

    // Demoted to a plain shell via /quit — launchAgentId persists for
    // identity, so this still counts as an agent terminal (issue #6605).
    async agentNotLive() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      terminal.getInfo().agentState = "exited";
      terminal.getInfo().detectedAgentId = undefined;
      await expect(terminal.gracefulShutdown()).resolves.toBeNull();
      return soleOutcome();
    },

    // Cursor is registered but ships no resume config at all.
    async noResumeConfig() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles, "cursor");
      await expect(terminal.gracefulShutdown()).resolves.toBeNull();
      return soleOutcome();
    },

    async capturedOnData() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.emitData("claude --resume mid-stream\n");
      await expect(promise).resolves.toBe("mid-stream");
      return soleOutcome();
    },

    // No trailing boundary, so onData must decline and only the last-chance
    // match at exit can capture it.
    async capturedAtExit() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.emitData("claude --resume at-exit");
      // If onData wrongly accepted the buffer-tail capture it would resolve
      // here, dispose the exit listener, and make the emitExit below a no-op —
      // the outcome would still look right. Pin the interim state.
      expect(shutdownEntries()).toHaveLength(0);
      handles.emitExit(0);
      await expect(promise).resolves.toBe("at-exit");
      return soleOutcome();
    },

    async timeout() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    // Kiro is project-scoped: null is the designed result, not a failure.
    // Folding it into the pattern-miss bucket would send someone hunting a
    // sessionIdPattern bug for an agent that has no pattern at all (#4781).
    async exitedNoPattern() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles, "kiro");
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
      handles.emitExit(0);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    async exitedNoMatch() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.emitData("goodbye, nothing resumable here\n");
      handles.emitExit(0);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    async preludeWriteFailed() {
      let pending = true;
      const handles = createMockPty((data: string) => {
        if (pending && data === "\x05\x15") {
          pending = false;
          throw new Error("pty dead");
        }
      });
      const terminal = createAgentTerminal(handles);
      await expect(terminal.gracefulShutdown()).resolves.toBeNull();
      return soleOutcome();
    },

    async quitSignalWriteFailed() {
      const handles = createMockPty((data: string) => {
        if (data === "/quit\r") throw new Error("pty dead after prelude");
      });
      const terminal = createAgentTerminal(handles);
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    // No quit signal has gone out yet at this point...
    async demotedDuringClearDelay() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles);
      const promise = terminal.gracefulShutdown();
      await Promise.resolve();
      await Promise.resolve();
      terminal.getInfo().agentState = "exited";
      terminal.getInfo().detectedAgentId = undefined;
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    // ...whereas here the split-write body landed and only Enter is missing.
    // Gemini splits body and Enter, so it reaches this gate; Codex takes the
    // gated-escalation path below instead and never writes a quit command.
    async demotedDuringSubmitDelay() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles, "gemini");
      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      terminal.getInfo().agentState = "exited";
      terminal.getInfo().detectedAgentId = undefined;
      await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    // The gated escalation's own demotion guard (#11851). Codex's presses are
    // separated by a gate wait, so the agent can exit between them just as it
    // can between a split-write body and its Enter — and the next press would
    // land in whatever replaced it.
    async demotedDuringGatedSignal() {
      const handles = createMockPty();
      const terminal = createAgentTerminal(handles, "codex");
      const promise = terminal.gracefulShutdown();
      await Promise.resolve();
      await Promise.resolve();
      // Satisfy the first press's gate so the loop comes back for a second one.
      handles.emitData("  Ctrl+C again to quit\n");
      terminal.getInfo().agentState = "exited";
      terminal.getInfo().detectedAgentId = undefined;
      await vi.advanceTimersByTimeAsync(CODEX_PER_PRESS_TIMEOUT_MS);
      await expect(promise).resolves.toBeNull();
      return soleOutcome();
    },

    // Distinct from `quit-signal-write-failed`: a dead PTY on the gated path
    // has written no slash command to be half-submitted, so the two failures
    // point at different suspects.
    async gatedSignalWriteFailed() {
      const handles = createMockPty((data: string) => {
        if (data === CTRL_C) throw new Error("pty dead");
      });
      const terminal = createAgentTerminal(handles, "codex");
      await expect(terminal.gracefulShutdown()).resolves.toBeNull();
      return soleOutcome();
    },
  };

  it("gives every branch its own outcome, and both capture paths the same one", async () => {
    // The point of the whole feature: a reader of daintree.log can tell which
    // branch fired. That only holds if no two branches share a label —
    // checking pairs in isolation would miss a label reused across pairs.
    // The two capture paths are the one deliberate collision: both succeeded,
    // so neither explains a restore fallthrough.
    const results: Record<string, string> = {};
    for (const [name, run] of Object.entries(BRANCHES)) {
      results[name] = await run();
      // Every resolved shutdown ends in TerminalProcess.kill(), which leaves a
      // pending SIGKILL escalation (ProcessTreeKiller). Queued across runners,
      // the next scenario's timer advance would fire the earlier ones and
      // sigkillSweep the mock's pid — a real number — against the real OS.
      vi.clearAllTimers();
    }

    expect(results.capturedAtExit).toBe(results.capturedOnData);

    const distinct = Object.entries(results)
      .filter(([name]) => name !== "capturedAtExit")
      .map(([, outcome]) => outcome);
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("reports captured only when an id actually came back", async () => {
    // `captured` is the field the issue asked for — it must track the returned
    // value, not the branch's optimism.
    const hitHandles = createMockPty();
    const hitTerminal = createAgentTerminal(hitHandles);
    const hitPromise = hitTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    hitHandles.emitData("claude --resume landed\n");
    const hitResult = await hitPromise;
    expect(contextOf(shutdownEntries()[0])?.captured).toBe(hitResult !== null);
    expect(hitResult).not.toBeNull();
    logBuffer.clear();

    const missHandles = createMockPty();
    const missTerminal = createAgentTerminal(missHandles);
    const missPromise = missTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    missHandles.emitData("goodbye, nothing resumable here\n");
    missHandles.emitExit(0);
    const missResult = await missPromise;
    expect(contextOf(shutdownEntries()[0])?.captured).toBe(missResult !== null);
    expect(missResult).toBeNull();
  });

  it("never lets the captured session id reach the log", async () => {
    // A captured id is a resume credential (`--resume <id>`) and logs.getAll
    // serves this buffer to agents verbatim, so leaking one would let any
    // agent with log access resume another terminal's session. `captured`
    // answers the diagnostic question without carrying the secret.
    //
    // The sentinel is deliberately plain: the logger's redaction is keyed on
    // field names, so a leak under a name like `capturedId` would sail
    // through it. Absence here has to come from never passing the id at all.
    const sentinel = "zzz-sentinel-zzz";
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    handles.emitData(`claude --resume ${sentinel}\n`);

    await expect(shutdownPromise).resolves.toBe(sentinel);
    expect(terminal.getInfo().agentSessionId).toBe(sentinel);

    // Positive control first: an empty buffer trivially "contains no secret",
    // so without this the test would stay green if logging were deleted.
    const entries = shutdownEntries();
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(sentinel);

    // Whitelist the context rather than just scanning for this one value: a
    // leak under a brand-new key would slip a substring scan, and the logger's
    // redaction only covers key names it already knows about.
    expect(Object.keys(contextOf(entries[0]) ?? {}).sort()).toEqual([
      "agentId",
      "captured",
      "elapsedMs",
      "outcome",
      "pressesSent",
      "projectId",
      "terminalId",
    ]);
  });

  it("emits at info — loud enough for daintree.log, not louder", async () => {
    // The info floor above proves it isn't debug, but warn would clear that bar
    // too. Raising the floor to warn must silence it, which pins the level from
    // both sides without asserting the literal "info" the implementation uses.
    setLogLevelOverrides({ "*": "warn" });

    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);
    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    await expect(promise).resolves.toBeNull();

    expect(shutdownEntries()).toHaveLength(0);
  });

  it("logs once when a late exit event races the capture that already won", async () => {
    // `finish()` is re-entrant by design — the timer, onData and onExit can
    // all reach it. The log sits behind the same `resolved` guard as the
    // resolve itself, so a losing racer must add nothing.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    handles.emitData("claude --resume winner\n");
    await expect(shutdownPromise).resolves.toBe("winner");

    // An exit already queued inside node-pty when the listeners were disposed.
    handles.emitExitIgnoringDispose(0);

    expect(shutdownEntries()).toHaveLength(1);
  });

  it("carries the terminal's identity and a real elapsed measurement", async () => {
    // The issue's complaint was not being able to tell two panes of the same
    // project apart, so every identity field has to survive the trip.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);
    terminal.getInfo().projectId = "proj-11591";

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    await expect(shutdownPromise).resolves.toBeNull();

    const context = contextOf(shutdownEntries()[0]);

    expect(context?.terminalId).toBe(terminal.getInfo().id);
    expect(context?.projectId).toBe(terminal.getInfo().projectId);
    expect(context?.agentId).toBe(terminal.getInfo().launchAgentId);
    expect(context?.captured).toBe(false);
    // Elapsed has to be measured, not stamped. Bounded on both sides: a
    // hardcoded 0 fails the lower bound, and a sentinel like Infinity or a raw
    // Date.now() stamp fails the upper one.
    expect(context?.elapsedMs).toBeGreaterThanOrEqual(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    expect(context?.elapsedMs).toBeLessThan(GRACEFUL_SHUTDOWN_TIMEOUT_MS * 10);
  });

  it("measures elapsed from the start of the shutdown, not the whole session", async () => {
    // A capture that lands early must report a small elapsed — that is what
    // makes "timeout points at the 2.5s budget" actionable rather than noise.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    // Age the terminal well past the upper bound first. Without this the
    // terminal is born at the same instant the shutdown starts, so an
    // implementation measuring from spawn time instead of from the shutdown
    // would report the same small number and pass.
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS * 20);

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    handles.emitData("claude --resume quick\n");
    await expect(promise).resolves.toBe("quick");

    const elapsed = contextOf(shutdownEntries()[0])?.elapsedMs ?? -1;
    expect(elapsed).toBeGreaterThanOrEqual(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(elapsed).toBeLessThan(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  describe("session id assigned at launch (#11782)", () => {
    it("returns the assigned id without writing anything into the PTY", async () => {
      // The whole point of assigning the id up front: the quit signal that the
      // scrape depends on is what a mid-turn agent swallows as chat text and a
      // modal eats outright. Writing nothing means none of that can happen —
      // and nothing is left in the user's transcript either.
      const handles = createMockPty();
      const terminal = createAgentTerminalWithSession(handles, "claude", "assigned-abc");

      await expect(terminal.gracefulShutdown()).resolves.toBe("assigned-abc");

      expect(handles.writeMock).not.toHaveBeenCalled();
      expect(terminal.getInfo().agentSessionId).toBe("assigned-abc");
    });

    it("resolves without spending any of the shutdown budget", async () => {
      // Resolution has to happen before a single timer fires. Asserting on an
      // elapsed number would pass for an implementation that still waits out
      // the clear delay; requiring the promise to settle with the clock frozen
      // is what actually proves the teardown path costs no wall clock.
      const handles = createMockPty();
      const terminal = createAgentTerminalWithSession(handles, "claude", "assigned-fast");

      let settled = false;
      const promise = terminal.gracefulShutdown().then((id) => {
        settled = true;
        return id;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(true);
      await expect(promise).resolves.toBe("assigned-fast");
    });

    it("logs its own outcome rather than inflating the scrape's capture rate", async () => {
      const handles = createMockPty();
      const terminal = createAgentTerminalWithSession(handles, "claude", "assigned-log");

      await terminal.gracefulShutdown();

      const context = contextOf(shutdownEntries()[0]);
      expect(context?.outcome).toBe("preassigned");
      expect(context?.captured).toBe(true);
    });

    it("does not hand one agent's stored id to a different live agent", async () => {
      // A pane that launched codex and now hosts a hand-started claude still
      // carries codex's id. Claude declares the capability, so a gate that
      // checked only the capability would file codex's conversation as
      // claude's and restore would resume the wrong one.
      const handles = createMockPty();
      const terminal = createAgentTerminalWithSession(handles, "codex", "codex-owned-id");
      terminal.getInfo().detectedAgentId = "claude";

      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS + SUBMIT_ENTER_DELAY_MS);

      // Falls through to the scrape rather than returning the borrowed id.
      expect(handles.writeMock).toHaveBeenCalled();
      handles.emitData("claude --resume claude-owned-id\n");
      await expect(promise).resolves.toBe("claude-owned-id");
    });

    it("still scrapes for an agent that mints its own id, even when one is stored", async () => {
      // Codex declares no `assignSessionIdArgs`, so a stored id is a PREVIOUS
      // session's, not a promise about this one. Skipping the scrape for it
      // would drop the id only teardown can observe.
      const handles = createMockPty();
      const terminal = createAgentTerminalWithSession(handles, "codex", "stale-codex-id");

      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS + SUBMIT_ENTER_DELAY_MS);

      expect(handles.writeMock).toHaveBeenCalled();

      handles.emitData("codex resume fresh-codex-id\n");
      await expect(promise).resolves.toBe("fresh-codex-id");
    });
  });
});
