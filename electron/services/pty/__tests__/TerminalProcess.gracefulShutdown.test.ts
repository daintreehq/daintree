import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS, GRACEFUL_SHUTDOWN_TIMEOUT_MS } from "../types.js";
import { SUBMIT_ENTER_DELAY_MS } from "../terminalInput.js";
import { logBuffer } from "../../LogBuffer.js";
import { getLogLevelOverrides, setLogLevelOverrides } from "../../../utils/logger.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

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

  it("captures Codex session ID after split-submitting /quit", async () => {
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit");

    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(handles.writeMock).toHaveBeenCalledTimes(3);
    expect(handles.writeMock.mock.calls[2]?.[0]).toBe("\r");

    handles.emitData("codex resume codex-session-123\n");
    await expect(shutdownPromise).resolves.toBe("codex-session-123");
    expect(terminal.getInfo().agentSessionId).toBe("codex-session-123");
  });

  it("skips Enter when the split-write agent demotes during the quit-submit delay", async () => {
    // Mid-flight liveness guard for the split-write path only — Codex (and
    // other Ratatui/readline CLIs) writes the body and Enter as separate
    // PTY writes with a delay between them. If the agent demotes during
    // that gap, the trailing Enter must be skipped so it doesn't land in a
    // plain shell. Claude uses single-write so this guard isn't reachable
    // for it; using `codex` keeps the split-write coverage explicit.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

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

  /** The outcome of the single entry logged so far, asserting there is only one. */
  function soleOutcome(): string | undefined {
    const entries = shutdownEntries();
    expect(entries).toHaveLength(1);
    return (entries[0]?.context as { outcome?: string } | undefined)?.outcome;
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

  it("reports a distinct outcome for each pre-quit early return", async () => {
    // `no-quit-signal` is deliberately absent: no agent in the roster ships a
    // resume config without a quitCommand or shutdownKeySequence, so that
    // branch is defensive-only and unreachable without mocking the registry.
    const collected: (string | undefined)[] = [];

    const exitedHandles = createMockPty();
    const exited = createAgentTerminal(exitedHandles);
    exited.getInfo().isExited = true;
    await expect(exited.gracefulShutdown()).resolves.toBeNull();
    collected.push(soleOutcome());
    logBuffer.clear();

    // Demoted to a plain shell via /quit — launchAgentId persists for
    // identity, so this still counts as an agent terminal (issue #6605).
    const demotedHandles = createMockPty();
    const demoted = createAgentTerminal(demotedHandles);
    demoted.getInfo().agentState = "exited";
    demoted.getInfo().detectedAgentId = undefined;
    await expect(demoted.gracefulShutdown()).resolves.toBeNull();
    collected.push(soleOutcome());
    logBuffer.clear();

    // Cursor is registered but ships no resume config at all.
    const noResumeHandles = createMockPty();
    const noResume = createAgentTerminal(noResumeHandles, "cursor");
    await expect(noResume.gracefulShutdown()).resolves.toBeNull();
    collected.push(soleOutcome());

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.every((o) => typeof o === "string" && o.length > 0)).toBe(true);
  });

  it("reports one capture outcome whether the id lands mid-stream or at exit", async () => {
    // Both are successes and neither explains a restore fallthrough, so they
    // share a bucket. What must hold is that `captured` tracks the returned id.
    const streamHandles = createMockPty();
    const streamTerminal = createAgentTerminal(streamHandles);
    const streamPromise = streamTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    streamHandles.emitData("claude --resume mid-stream\n");
    const streamResult = await streamPromise;
    const streamEntry = shutdownEntries()[0];
    const streamOutcome = soleOutcome();
    logBuffer.clear();

    // No trailing boundary, so onData declines and only the last-chance match
    // at exit can capture it.
    const exitHandles = createMockPty();
    const exitTerminal = createAgentTerminal(exitHandles);
    const exitPromise = exitTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    exitHandles.emitData("claude --resume at-exit");
    exitHandles.emitExit(0);
    const exitResult = await exitPromise;
    const exitEntry = shutdownEntries()[0];
    const exitOutcome = soleOutcome();

    expect(streamResult).not.toBeNull();
    expect(exitResult).not.toBeNull();
    expect(exitOutcome).toBe(streamOutcome);
    expect((streamEntry?.context as { captured?: boolean } | undefined)?.captured).toBe(
      streamResult !== null
    );
    expect((exitEntry?.context as { captured?: boolean } | undefined)?.captured).toBe(
      exitResult !== null
    );
  });

  it("separates a capture at exit from a pattern that never matched", async () => {
    const capturedHandles = createMockPty();
    const capturedTerminal = createAgentTerminal(capturedHandles);
    const capturedPromise = capturedTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    capturedHandles.emitData("claude --resume landed-late");
    capturedHandles.emitExit(0);
    await expect(capturedPromise).resolves.not.toBeNull();
    const capturedOutcome = soleOutcome();
    logBuffer.clear();

    const missHandles = createMockPty();
    const missTerminal = createAgentTerminal(missHandles);
    const missPromise = missTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    missHandles.emitData("goodbye, nothing resumable here\n");
    missHandles.emitExit(0);
    await expect(missPromise).resolves.toBeNull();
    const missOutcome = soleOutcome();

    // A miss points at the agent's sessionIdPattern; a capture points nowhere.
    expect(missOutcome).not.toBe(capturedOutcome);
  });

  it("separates an agent with no session-id pattern from one whose pattern missed", async () => {
    // Kiro is project-scoped: null is the designed result, not a failure.
    // Collapsing it into the pattern-miss bucket would send someone hunting a
    // sessionIdPattern bug for an agent that has no pattern at all (#4781).
    const kiroHandles = createMockPty();
    const kiroTerminal = createAgentTerminal(kiroHandles, "kiro");
    const kiroPromise = kiroTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    kiroHandles.emitExit(0);
    await expect(kiroPromise).resolves.toBeNull();
    const kiroOutcome = soleOutcome();
    logBuffer.clear();

    const missHandles = createMockPty();
    const missTerminal = createAgentTerminal(missHandles);
    const missPromise = missTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    missHandles.emitExit(0);
    await expect(missPromise).resolves.toBeNull();
    const missOutcome = soleOutcome();

    expect(kiroOutcome).not.toBe(missOutcome);
  });

  it("separates the two demotion windows", async () => {
    // They imply different amounts of submitted input: during the clear delay
    // no quit signal has gone out at all, while during the submit delay the
    // split-write body landed and only Enter is missing. Same cause
    // ("agent went away"), different thing to go look at.
    const clearHandles = createMockPty();
    const clearTerminal = createAgentTerminal(clearHandles);
    const clearPromise = clearTerminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();
    clearTerminal.getInfo().agentState = "exited";
    clearTerminal.getInfo().detectedAgentId = undefined;
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    await expect(clearPromise).resolves.toBeNull();
    const clearOutcome = soleOutcome();
    logBuffer.clear();

    // Codex splits body and Enter, so only it can reach the submit-delay gate.
    const submitHandles = createMockPty();
    const submitTerminal = createAgentTerminal(submitHandles, "codex");
    const submitPromise = submitTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    submitTerminal.getInfo().agentState = "exited";
    submitTerminal.getInfo().detectedAgentId = undefined;
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    await expect(submitPromise).resolves.toBeNull();
    const submitOutcome = soleOutcome();

    expect(clearOutcome).not.toBe(submitOutcome);
  });

  it("separates a failed prelude write from a failed quit-signal write", async () => {
    // The prelude failing means the PTY was already gone; the quit write
    // failing means it died in the clear-delay window. Different suspects.
    let preludePending = true;
    const preludeHandles = createMockPty((data: string) => {
      if (preludePending && data === "\x05\x15") {
        preludePending = false;
        throw new Error("pty dead");
      }
    });
    const preludeTerminal = createAgentTerminal(preludeHandles);
    await expect(preludeTerminal.gracefulShutdown()).resolves.toBeNull();
    const preludeOutcome = soleOutcome();
    logBuffer.clear();

    const quitHandles = createMockPty((data: string) => {
      if (data === "/quit\r") throw new Error("pty dead after prelude");
    });
    const quitTerminal = createAgentTerminal(quitHandles);
    const quitPromise = quitTerminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    await expect(quitPromise).resolves.toBeNull();
    const quitOutcome = soleOutcome();

    expect(preludeOutcome).not.toBe(quitOutcome);
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

    expect(JSON.stringify(shutdownEntries())).not.toContain(sentinel);
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
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles);

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    await expect(shutdownPromise).resolves.toBeNull();

    const context = shutdownEntries()[0]?.context as
      { terminalId?: string; agentId?: string; captured?: boolean; elapsedMs?: number } | undefined;

    expect(context?.terminalId).toBe(terminal.getInfo().id);
    expect(context?.agentId).toBe(terminal.getInfo().launchAgentId);
    expect(context?.captured).toBe(false);
    // Elapsed has to be measured, not stamped: a shutdown that ran the full
    // budget must report at least the budget, which a hardcoded 0 would not.
    expect(context?.elapsedMs).toBeGreaterThanOrEqual(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });
});
