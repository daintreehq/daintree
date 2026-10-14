import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess, type TerminalProcessCallbacks } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import {
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
  GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_QUEUE_BYTES,
} from "../types.js";
import { SUBMIT_ENTER_DELAY_MS, OUTPUT_SETTLE_MAX_WAIT_MS } from "../terminalInput.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import type { AgentGatedKeyEscalation } from "../../../../shared/config/agentRegistry.js";
import { logBuffer } from "../../LogBuffer.js";
import { getLogLevelOverrides, setLogLevelOverrides } from "../../../utils/logger.js";
import { headlessMirrorScheduler } from "../HeadlessMirrorScheduler.js";
import { PtyPauseCoordinator } from "../../../pty-host/PtyPauseCoordinator.js";
import { GracefulCaptureTracker } from "../../../pty-host/GracefulCaptureTracker.js";
import { IpcQueueManager } from "../../../pty-host/ipcQueue.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

// Sizes of what the graceful teardown's matcher is asked to scan — the
// passive end-of-agent scan takes the last match, so it is filtered out.
const gracefulMatcherInputs = vi.hoisted(() => [] as number[]);

vi.mock("../sessionIdCapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessionIdCapture.js")>();
  return {
    ...actual,
    createSessionIdMatcher: (pattern: string | undefined) => {
      const matcher = actual.createSessionIdMatcher(pattern);
      if (!matcher) return matcher;
      const recording: typeof matcher = (raw, options) => {
        if (options.occurrence === "first") gracefulMatcherInputs.push(raw.length);
        return matcher(raw, options);
      };
      return recording;
    },
  };
});

// Built rather than written as an escape in a pattern: eslint's `no-control-regex`
// is error-level in this repo, so a raw control char must never reach a regex
// literal. Keeping the byte in one named constant also makes every assertion
// below read as "the Ctrl-C press" rather than as an opaque escape.
const CTRL_C = String.fromCharCode(3);

/**
 * Codex's declared escalation, read from the config the implementation reads.
 * Copying the numbers here instead would let an implementation that hardcoded
 * them — rather than honouring `shutdownSignal` — pass every test below.
 */
function codexShutdownSignal(): AgentGatedKeyEscalation {
  const resume = getAgentConfig("codex")?.resume;
  if (resume?.kind !== "session-id" || !resume.shutdownSignal) {
    throw new Error("codex must declare a gated shutdown signal");
  }
  return resume.shutdownSignal;
}

const CODEX_PER_PRESS_TIMEOUT_MS = codexShutdownSignal().perPressTimeoutMs;
const CODEX_MAX_PRESSES = codexShutdownSignal().maxPresses;

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
    // 0, not a real-looking pid: TerminalProcess.kill() routes through
    // ProcessTreeKiller, which for any pid > 0 calls process.kill(pid, ...) /
    // taskkill for real and arms a 500ms SIGKILL sweep. Every test here ends in
    // a kill, and several advance past that delay, so a plausible pid would
    // signal whatever actually owns it on this machine. `pid <= 0` takes the
    // early bail that only calls the mocked pty.kill().
    pid: 0,
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

  it("captures a session ID after split-submitting the quit command", async () => {
    // The split-write happy path: body, gap, Enter, then the resume hint. Claude
    // covers capture on the single-write path and Kiro covers a split write with
    // no capture, so without this nothing covers their composition. Used to be
    // Codex's test; Codex now takes the gated Ctrl-C path (#11851).
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "gemini");

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    expect(handles.writeMock).toHaveBeenCalledTimes(2);
    expect(handles.writeMock.mock.calls[0]?.[0]).toBe("\x05\x15");
    expect(handles.writeMock.mock.calls[1]?.[0]).toBe("/quit");

    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(handles.writeMock).toHaveBeenCalledTimes(3);
    expect(handles.writeMock.mock.calls[2]?.[0]).toBe("\r");

    handles.emitData("gemini --resume gemini-session-123\n");
    await expect(shutdownPromise).resolves.toBe("gemini-session-123");
    expect(terminal.getInfo().agentSessionId).toBe("gemini-session-123");
  });

  it("scrapes antigravity's session id from the `=` teardown split across chunks", async () => {
    // #11851 removed antigravity's pattern after 0 captures in 6 teardowns. A
    // live 1.1.22 capture showed why: agy writes `--conversation=<id>`, and the
    // old pattern expected a space. The real teardown banner and the id arrive
    // in separate PTY chunks, so scrape across the boundary, not within a chunk.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "antigravity");

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);

    expect(handles.writeMock.mock.calls.map((c) => c[0]).join("")).toContain("/quit");

    handles.emitData("Resume with -c (or command below):\r\nagy --conversa");
    handles.emitData("tion=adf330da-a07e-477d-af57-51c0e0f1b2c3\r\n");
    handles.emitExit(0);

    await expect(shutdownPromise).resolves.toBe("adf330da-a07e-477d-af57-51c0e0f1b2c3");
    expect(terminal.getInfo().agentSessionId).toBe("adf330da-a07e-477d-af57-51c0e0f1b2c3");
  });

  it("ignores the space-form `--conversation` that antigravity never prints", async () => {
    // The shape #11851 proved agy does not emit. Keeping it unmatched is what
    // stops a ghost regex from burning the shutdown budget on unrelated output.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "antigravity");

    const shutdownPromise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);

    handles.emitData("Run agy --conversation not-a-real-capture\n");
    handles.emitExit(0);

    await expect(shutdownPromise).resolves.toBeNull();
    expect(terminal.getInfo().agentSessionId).toBeUndefined();
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

  it("stops at the cap when repaints keep arriving in separate frames", async () => {
    // The repaint test above emits its frames back to back, so the loop never
    // gets a turn between them. node-pty delivers real frames in separate
    // callbacks with microtasks in between, which is the sequence that can walk
    // the escalation forward one press per repaint. Ratatui redraws the whole
    // frame, so a repaint emitted while a press is already tearing the TUI down
    // is indistinguishable from a genuine re-arm — the cap is the only thing
    // standing between that and the press count measured as unrecoverable.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    for (let frame = 0; frame < 6; frame++) {
      handles.emitData(footerFrame());
      // Yield fully between frames so each one meets a freshly armed press.
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(handles.writeMock).toHaveBeenCalledTimes(CODEX_MAX_PRESSES);

    handles.emitData("  codex resume capped-across-frames\n");
    await expect(promise).resolves.toBe("capped-across-frames");
    expect(handles.writeMock).toHaveBeenCalledTimes(CODEX_MAX_PRESSES);
  });

  it("never presses again off a frame that already carries a session id", async () => {
    // PTY chunk boundaries are arbitrary. A chunk ending exactly after the id
    // has no trailing boundary yet, so the capture is held as provisional — but
    // the agent is plainly quitting, and letting that same chunk satisfy the
    // gate would fire the next press at the exact moment the hint is printing.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    // Footer and an unterminated resume hint in one chunk.
    handles.emitData(`${footerFrame()}\n  codex resume boundary-id`);
    await vi.advanceTimersByTimeAsync(1);

    // Provisional capture, so not resolved yet — but no press either.
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    handles.emitData("\n");
    await expect(promise).resolves.toBe("boundary-id");
    expect(handles.writeMock).toHaveBeenCalledTimes(1);
  });

  it("shares one escalation between concurrent teardown callers", async () => {
    // Neither `isExited` nor `wasKilled` is set until a teardown finishes, so
    // two callers arriving together both clear the entry gates. Each loop
    // counts only its own presses, so without single-flighting the aggregate
    // sails past the cap the config exists to enforce.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const first = terminal.gracefulShutdown();
    const second = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    handles.emitData(footerFrame());
    await vi.advanceTimersByTimeAsync(1);
    expect(handles.writeMock).toHaveBeenCalledTimes(CODEX_MAX_PRESSES);

    handles.emitData("  codex resume shared-teardown\n");
    await expect(first).resolves.toBe("shared-teardown");
    await expect(second).resolves.toBe("shared-teardown");
    expect(handles.writeMock).toHaveBeenCalledTimes(CODEX_MAX_PRESSES);
  });

  it("writes no press once the wall-clock budget is spent, even if a gate answers late", async () => {
    // The overall timer only fires when the loop gets a turn. An onData that
    // began before the deadline can settle a gate and have its continuation run
    // after it, which on a loaded machine mid-app-quit is a real ordering.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    // Freeze the loop's view of the clock past the deadline WITHOUT letting the
    // overall timer run — the exact interleaving the write-site check exists for.
    vi.setSystemTime(Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS + 1);
    handles.emitData(footerFrame());
    await Promise.resolve();
    await Promise.resolve();

    expect(handles.writeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    await expect(promise).resolves.toBeNull();
  });

  it("leaves room to hear the resume hint even when a press stalls", async () => {
    // A press whose gate never answers costs a full `perPressTimeoutMs` and
    // then ends the escalation — but that press may well be the one that quit
    // the agent, whose hint was measured arriving up to 1160ms later. So the
    // stall plus the hint has to fit the per-terminal budget, and the whole
    // escalation must not be able to consume it outright. Read from the real
    // config so a retune has to face both numbers.
    const MEASURED_HINT_LATENCY_MS = 1160;
    const signal = codexShutdownSignal();
    // Worst case is every gate but the last one answering at its deadline, then
    // the final press printing its hint at the slowest measured latency. Both
    // halves have to fit, so neither term may be checked on its own.
    const worstCaseMs =
      (signal.maxPresses - 1) * signal.perPressTimeoutMs + MEASURED_HINT_LATENCY_MS;
    expect(worstCaseMs).toBeLessThan(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
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

  it("leaves no application-paced remainder to leak into the shutdown exchange", async () => {
    // This used to assert that a chunked paste stopped dripping once the lock
    // engaged. There is no chunk queue any more (#11875) — a large write goes
    // to node-pty in one call — so the guarantee is now stronger and simpler:
    // nothing of ours is left pending to interleave with the Ctrl-C exchange.
    // Written as a timer-advance rather than a one-shot count so a
    // reintroduced pacing lane would fail here.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    const paste = "x".repeat(4096);
    terminal.write(paste);

    const pasteWrites = handles.writeMock.mock.calls.filter((c) => c[0] === paste);
    expect(pasteWrites).toHaveLength(1);
    const writesBefore = handles.writeMock.mock.calls.length;

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    // Only the Ctrl-C press was added.
    expect(handles.writeMock.mock.calls.length).toBe(writesBefore + 1);
    await vi.advanceTimersByTimeAsync(CODEX_PER_PRESS_TIMEOUT_MS);

    // No further fragment of the payload arrived on any timer.
    const written = handles.writeMock.mock.calls.map((c) => c[0]);
    expect(written.filter((chunk) => chunk.startsWith("x"))).toHaveLength(1);

    handles.emitData("  codex resume paste-dropped\n");
    await expect(promise).resolves.toBe("paste-dropped");
  });

  it("abandons the Enter of a submit that was already in flight", async () => {
    // The entry guards catch input that STARTS after the lock. This is the other
    // half: performSubmit writes the body, awaits its pre-Enter gap, then writes
    // Enter. A teardown beginning inside that gap must leave the Enter unsent,
    // or it submits whatever the shutdown signal left in the composer.
    const handles = createMockPty();
    const terminal = createAgentTerminal(handles, "codex");

    terminal.submit("half-typed prompt");
    await vi.advanceTimersByTimeAsync(1);
    const afterBody = handles.writeMock.mock.calls.map((c) => c[0]).join("");
    expect(afterBody).toContain("half-typed prompt");
    expect(afterBody).not.toContain("\r");

    const promise = terminal.gracefulShutdown();
    await Promise.resolve();
    await Promise.resolve();

    // Let the submit's pre-Enter wait elapse inside the teardown. The gated
    // path writes only Ctrl-C, so any "\r" in the log can only be that Enter.
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS + OUTPUT_SETTLE_MAX_WAIT_MS);

    expect(handles.writeMock.mock.calls.map((c) => c[0]).join("")).not.toContain("\r");

    handles.emitData("  codex resume submit-abandoned\n");
    await expect(promise).resolves.toBe("submit-abandoned");
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
      // Logging the right outcome is not enough: the point of the guard is that
      // the press never went out, and an implementation that wrote first and
      // logged after would satisfy the outcome check alone.
      expect(handles.writeMock).toHaveBeenCalledTimes(1);
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

const NATIVE_READ_BYTES = 64 * 1024;

function codexGateText(): string {
  const resume = getAgentConfig("codex")?.resume;
  if (resume?.kind !== "session-id" || !resume.shutdownSignal) {
    throw new Error("codex must declare a gated shutdown signal");
  }
  return resume.shutdownSignal.gateText;
}

/**
 * A PTY that behaves like node-pty under flow control: while paused, what the
 * agent prints waits (in the kernel buffer, for real) and reaches listeners
 * only once reads resume. A test that merely invoked the capture callback
 * would pass against the original bug; this one has to actually unblock reads.
 *
 * The backlog is flushed synchronously on resume, which is stricter than
 * node-pty (its stream delivers on the next tick).
 */
function createPausablePty(options?: { writeThrows?: boolean }) {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const backlog: string[] = [];
  const events: string[] = [];
  const writes: string[] = [];
  let paused = false;

  const deliver = (data: string) => {
    for (const listener of [...dataListeners]) listener(data);
  };

  const pty: Partial<IPty> = {
    // pid 0 keeps ProcessTreeKiller from signalling a real process.
    pid: 0,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      events.push("write");
      if (options?.writeThrows) throw new Error("EIO");
      writes.push(data);
    },
    resize: () => {},
    kill: vi.fn(),
    pause: () => {
      paused = true;
      events.push("pause");
    },
    resume: () => {
      paused = false;
      events.push("resume");
      while (!paused && backlog.length > 0) deliver(backlog.shift()!);
    },
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener);
      events.push("listen");
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };

  return {
    pty: pty as IPty,
    events,
    writes,
    output(data: string) {
      if (paused) backlog.push(data);
      else deliver(data);
    },
    exit(exitCode: number) {
      for (const listener of [...exitListeners]) listener({ exitCode });
    },
    get paused() {
      return paused;
    },
    get backlog() {
      return backlog.length;
    },
  };
}

type PausablePty = ReturnType<typeof createPausablePty>;

const spawnedTerminals: TerminalProcess[] = [];

function spawnContext(): SpawnContext {
  return { shell: "/bin/zsh", args: ["-l"], env: {} };
}

/**
 * The pty-host side, as `pty-host.ts` wires it: one coordinator per terminal
 * over its raw pause/resume, and the tracker handing out capture windows.
 */
function createHost() {
  const coordinators = new Map<string, PtyPauseCoordinator>();
  const terminals = new Map<string, TerminalProcess>();
  const captureEvents: Array<[string, "open" | "close"]> = [];
  const tracker = new GracefulCaptureTracker({
    getPauseCoordinator: (id) => coordinators.get(id),
    getOrCreatePauseCoordinator: (id) => coordinators.get(id),
    isTerminalLive: (id) => {
      const info = terminals.get(id)?.getInfo();
      return info !== undefined && !info.wasKilled && !info.isExited;
    },
    emitDataLoss: vi.fn(),
  });

  function spawn(
    id: string,
    handles: PausablePty,
    options: {
      agentId?: string;
      agentSessionId?: string;
      withCapture?: boolean;
      openCapture?: TerminalProcessCallbacks["openGracefulCapture"];
      emitData?: (data: string) => void;
    } = {}
  ) {
    const coordinator = new PtyPauseCoordinator({
      pause: () => handles.pty.pause(),
      resume: () => handles.pty.resume(),
    });
    coordinators.set(id, coordinator);
    const callbacks: TerminalProcessCallbacks = {
      emitData: (_termId, data) => options.emitData?.(String(data)),
      onExit: () => {},
    };
    if (options.withCapture !== false) {
      callbacks.openGracefulCapture =
        options.openCapture ??
        ((termId) => {
          // Logged before opening: opening is what resumes reads.
          handles.events.push("capture-open");
          const lease = tracker.open(termId);
          if (!lease) {
            handles.events.pop();
            return null;
          }
          captureEvents.push([termId, "open"]);
          return {
            shouldDiscard: (data) => lease.shouldDiscard(data),
            close: () => {
              captureEvents.push([termId, "close"]);
              handles.events.push("capture-close");
              lease.close();
            },
          };
        });
    }
    const terminal = new TerminalProcess(
      id,
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: options.agentId,
        agentSessionId: options.agentSessionId,
      },
      callbacks,
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          // Reached here, unlike in the single-listener mock elsewhere: every
          // exit listener fires, TerminalProcess's own included.
          emitAgentCompleted: () => {},
        } as never,
        ptyPool: null,
        processTreeCache: null,
      },
      spawnContext(),
      handles.pty
    );
    terminals.set(id, terminal);
    spawnedTerminals.push(terminal);
    handles.events.length = 0;
    return { terminal, coordinator };
  }

  return { tracker, spawn, captureEvents };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalProcess.gracefulShutdown — capture window (#12432)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gracefulMatcherInputs.length = 0;
  });

  afterEach(async () => {
    // Let the shared headless scheduler run its pending tick before timers are
    // cleared: a cancelled tick leaves it convinced one is still coming.
    await vi.advanceTimersByTimeAsync(0);
    for (const terminal of spawnedTerminals.splice(0)) terminal.dispose();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captures through a governor hold that predates the teardown", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
    coordinator.pause("resource-governor");
    expect(handles.paused).toBe(true);

    const startedAt = Date.now();
    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toContain("/quit\r");

    handles.output("claude --resume held-1\n");

    await expect(promise).resolves.toBe("held-1");
    expect(Date.now() - startedAt).toBeLessThan(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    expect(coordinator.isCapturing).toBe(false);
  });

  it("times out on the same hold when nothing opens a capture window", async () => {
    // The control for the test above: the harness really does withhold output.
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      withCapture: false,
    });
    coordinator.pause("resource-governor");

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    handles.output("claude --resume held-2\n");
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    await expect(promise).resolves.toBeNull();
    expect(handles.backlog).toBe(1);
  });

  it("opens the window after its listeners exist and before the first write", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "codex" });
    coordinator.pause("port-queue-2");

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();

    const { events } = handles;
    expect(events.indexOf("listen")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("listen")).toBeLessThan(events.indexOf("capture-open"));
    expect(events.indexOf("capture-open")).toBeLessThan(events.indexOf("resume"));
    expect(events.indexOf("resume")).toBeLessThan(events.indexOf("write"));

    handles.output("  codex resume ordered-1\n");
    await expect(promise).resolves.toBe("ordered-1");
    expect(events.indexOf("capture-close")).toBeGreaterThan(events.indexOf("write"));
  });

  it("keeps draining through another pressure sample while an unrelated terminal stays paused", async () => {
    const host = createHost();
    const capturing = createPausablePty();
    const bystander = createPausablePty();
    const a = host.spawn("t1", capturing, { agentId: "codex" });
    const b = host.spawn("t2", bystander, { agentId: "codex" });
    a.coordinator.pause("resource-governor");
    b.coordinator.pause("resource-governor");

    const promise = a.terminal.gracefulShutdown();
    await flushMicrotasks();
    expect(capturing.writes).toEqual([CTRL_C]);

    // The governor disengages and re-engages mid-handshake.
    for (const { coordinator } of [a, b]) coordinator.resume("resource-governor");
    for (const { coordinator } of [a, b]) coordinator.pause("resource-governor");

    expect(capturing.paused).toBe(false);
    expect(bystander.paused).toBe(true);
    bystander.output("still held\n");
    expect(bystander.backlog).toBe(1);

    // Fresh footer output reaches the gate, so the escalation can continue.
    capturing.output(`\x1b[2K  Ctrl+C ${codexGateText()}  \x1b[0m`);
    await flushMicrotasks();
    expect(capturing.writes).toEqual([CTRL_C, CTRL_C]);

    capturing.output("  codex resume drained-1\n");
    await expect(promise).resolves.toBe("drained-1");
    expect(bystander.paused).toBe(true);
    expect(b.coordinator.isCapturing).toBe(false);
  });

  it("keeps held output out of the rest of the pipeline", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const delivered: string[] = [];
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      emitData: (data) => delivered.push(data),
    });
    const mirrorFeeds = vi.spyOn(headlessMirrorScheduler, "enqueue");

    handles.output("history line\n");
    expect(delivered).toEqual(["history line\n"]);
    expect(mirrorFeeds).toHaveBeenCalled();

    coordinator.pause("resource-governor");
    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    delivered.length = 0;
    mirrorFeeds.mockClear();
    for (let i = 0; i < 20; i++) handles.output("x".repeat(NATIVE_READ_BYTES));
    expect(delivered).toEqual([]);
    expect(mirrorFeeds).not.toHaveBeenCalled();

    // Once nothing holds it any more, output flows everywhere as usual.
    coordinator.resume("resource-governor");
    handles.output("visible goodbye\n");
    expect(delivered).toEqual(["visible goodbye\n"]);
    expect(mirrorFeeds).toHaveBeenCalled();

    handles.output("claude --resume shed-1\n");
    await expect(promise).resolves.toBe("shed-1");
  });

  it("still answers a colour query the held output carries", async () => {
    // A TUI blocks on this reply for longer than the teardown budget, so a
    // discarded query would cost the hint it prints afterwards.
    const host = createHost();
    const handles = createPausablePty();
    const delivered: string[] = [];
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      emitData: (data) => delivered.push(data),
    });
    coordinator.pause("resource-governor");

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    const writesBefore = handles.writes.length;

    handles.output("\x1b]11;?\x07");

    const replies = handles.writes.slice(writesBefore);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.startsWith("\x1b]11;rgb:")).toBe(true);
    expect(delivered).toEqual([]);

    handles.output("claude --resume answered-1\n");
    await expect(promise).resolves.toBe("answered-1");
  });

  it("captures while a renderer that never acknowledges stays within its queue watermark", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const coordinatorRef: { current?: PtyPauseCoordinator } = {};
    const queue = new IpcQueueManager({
      getTerminal: () => undefined,
      getPauseCoordinator: () => coordinatorRef.current,
      sendEvent: vi.fn(),
      metricsEnabled: () => false,
      emitTerminalStatus: vi.fn(),
      emitReliabilityMetric: vi.fn(),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The host's IPC fallback: post, account, and let the watermark decide.
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      emitData: (data) => {
        const bytes = Buffer.byteLength(data, "utf8");
        queue.addBytes("t1", bytes);
        queue.applyBackpressure("t1", queue.getUtilization("t1"));
      },
    });
    coordinatorRef.current = coordinator;

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    // Several times the queue's hard cap, and not one acknowledgement.
    for (let i = 0; i < 150; i++) {
      handles.output("y".repeat(NATIVE_READ_BYTES));
      expect(handles.paused).toBe(false);
    }
    const highWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    expect(coordinator.hasToken("ipc-queue")).toBe(true);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(highWatermarkBytes + NATIVE_READ_BYTES);

    handles.output("claude --resume unacked-1\n");
    await expect(promise).resolves.toBe("unacked-1");
    queue.dispose();
  });

  it("scans a bounded window however much the agent prints before its hint", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, { agentId: "claude" });

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    for (let i = 0; i < 40; i++) handles.output("z".repeat(NATIVE_READ_BYTES));
    handles.output("claude --resume frag-");
    handles.output("ment-1\n");

    await expect(promise).resolves.toBe("frag-ment-1");
    expect(gracefulMatcherInputs.length).toBeGreaterThan(40);
    expect(Math.max(...gracefulMatcherInputs)).toBeLessThanOrEqual(
      GRACEFUL_SHUTDOWN_BUFFER_SIZE + NATIVE_READ_BYTES
    );
  });

  it("reads the footer at the head of a burst larger than the capture buffer", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, { agentId: "codex" });

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();
    expect(handles.writes).toEqual([CTRL_C]);

    handles.output(`  Ctrl+C ${codexGateText()}  ${"\x1b[0m.".repeat(8 * 1024)}`);
    await flushMicrotasks();
    expect(handles.writes).toEqual([CTRL_C, CTRL_C]);

    handles.output("  codex resume burst-gate\n");
    await expect(promise).resolves.toBe("burst-gate");
  });

  it("settles without writing when the agent was already on its way out", async () => {
    // The hint was printed while the terminal was held — the agent was quit a
    // moment before the teardown began. Resumed reads can deliver it before a
    // single byte is written, and nothing must be sent after it.
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
    coordinator.pause("resource-governor");
    handles.output("claude --resume already-1\n");

    const promise = terminal.gracefulShutdown();

    await expect(promise).resolves.toBe("already-1");
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toEqual([]);
    expect(host.captureEvents).toEqual([
      ["t1", "open"],
      ["t1", "close"],
    ]);
  });

  it("puts a surviving terminal back under its holds when its close fails", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "codex" });
    coordinator.pause("resource-governor");
    vi.spyOn(terminal, "kill").mockImplementation(() => {
      throw new Error("kill exploded");
    });

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();
    handles.output("  codex resume survivor-1\n");
    await expect(promise).resolves.toBe("survivor-1");

    expect(terminal.getInfo().wasKilled).toBeFalsy();
    expect(coordinator.isCapturing).toBe(false);
    expect(host.tracker.isCapturing("t1")).toBe(false);
    expect(handles.paused).toBe(true);

    // Output produced now waits for the governor, as it would for any terminal.
    handles.output("after the failed close\n");
    expect(handles.backlog).toBe(1);
  });

  describe("under a system-sleep hold", () => {
    it("never reads past it, so a teardown asleep through its deadline times out", async () => {
      const host = createHost();
      const handles = createPausablePty();
      const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
      coordinator.pause("system-sleep");

      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.output("claude --resume asleep-1\n");
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      await expect(promise).resolves.toBeNull();
      expect(handles.backlog).toBe(1);
      expect(coordinator.hasToken("system-sleep")).toBe(true);
    });

    it("captures once the machine wakes, even with other holds still recorded", async () => {
      const host = createHost();
      const handles = createPausablePty();
      const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
      coordinator.pause("system-sleep");
      coordinator.pause("resource-governor");

      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.output("claude --resume woke-1\n");
      expect(handles.backlog).toBe(1);

      coordinator.resume("system-sleep");

      await expect(promise).resolves.toBe("woke-1");
    });
  });

  describe("opens and closes the window exactly once", () => {
    async function expectOneWindow(
      run: (ctx: { terminal: TerminalProcess; handles: PausablePty }) => Promise<unknown>,
      options: { agentId?: string; writeThrows?: boolean } = {}
    ) {
      const host = createHost();
      const handles = createPausablePty({ writeThrows: options.writeThrows });
      const { terminal, coordinator } = host.spawn("t1", handles, {
        agentId: options.agentId ?? "claude",
      });
      coordinator.pause("resource-governor");

      await run({ terminal, handles });

      expect(host.captureEvents).toEqual([
        ["t1", "open"],
        ["t1", "close"],
      ]);
      expect(coordinator.isCapturing).toBe(false);
      expect(host.tracker.isCapturing("t1")).toBe(false);
    }

    it("when the agent prints nothing", async () => {
      await expectOneWindow(async ({ terminal }) => {
        const promise = terminal.gracefulShutdown();
        await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        await expect(promise).resolves.toBeNull();
      });
    });

    it("when the process exits early", async () => {
      await expectOneWindow(async ({ terminal, handles }) => {
        const promise = terminal.gracefulShutdown();
        await flushMicrotasks();
        handles.exit(0);
        await expect(promise).resolves.toBeNull();
      });
    });

    it("when the hint arrives in fragments", async () => {
      await expectOneWindow(
        async ({ terminal, handles }) => {
          const promise = terminal.gracefulShutdown();
          await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
          handles.output("Resume with: gemini --resume fc1c3a37-2294-4");
          await flushMicrotasks();
          handles.output("c8d-9abc-1234567890ab\n");
          await expect(promise).resolves.toBe("fc1c3a37-2294-4c8d-9abc-1234567890ab");
        },
        { agentId: "gemini" }
      );
    });

    it("when the prelude write fails", async () => {
      await expectOneWindow(
        async ({ terminal }) => {
          await expect(terminal.gracefulShutdown()).resolves.toBeNull();
        },
        { writeThrows: true }
      );
    });

    it("when the gated press fails to write", async () => {
      await expectOneWindow(
        async ({ terminal }) => {
          await expect(terminal.gracefulShutdown()).resolves.toBeNull();
        },
        { agentId: "codex", writeThrows: true }
      );
    });

    it("when the kill on the way out throws", async () => {
      await expectOneWindow(
        async ({ terminal, handles }) => {
          vi.spyOn(terminal, "kill").mockImplementation(() => {
            throw new Error("kill exploded");
          });
          const promise = terminal.gracefulShutdown();
          await flushMicrotasks();
          handles.output("  codex resume kill-throws\n");
          await expect(promise).resolves.toBe("kill-throws");
        },
        { agentId: "codex" }
      );
    });

    it("when close requests overlap", async () => {
      await expectOneWindow(
        async ({ terminal, handles }) => {
          const first = terminal.gracefulShutdown();
          const second = terminal.gracefulShutdown();
          await flushMicrotasks();
          const third = terminal.gracefulShutdown();
          handles.output("  codex resume overlap-1\n");
          await expect(Promise.all([first, second, third])).resolves.toEqual([
            "overlap-1",
            "overlap-1",
            "overlap-1",
          ]);
          expect(handles.writes).toEqual([CTRL_C]);
        },
        { agentId: "codex" }
      );
    });

    it("when a burst larger than the capture buffer carries the hint at its head", async () => {
      await expectOneWindow(async ({ terminal, handles }) => {
        const promise = terminal.gracefulShutdown();
        await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
        handles.output(`claude --resume burst-1\n${"x".repeat(NATIVE_READ_BYTES)}`);
        await expect(promise).resolves.toBe("burst-1");
      });
    });
  });

  it("opens no window for a teardown that writes nothing", async () => {
    const host = createHost();
    const plain = createPausablePty();
    const assigned = createPausablePty();
    const plainTerminal = host.spawn("plain", plain).terminal;
    const assignedTerminal = host.spawn("assigned", assigned, {
      agentId: "claude",
      agentSessionId: "assigned-1",
    }).terminal;

    await expect(plainTerminal.gracefulShutdown()).resolves.toBeNull();
    await expect(assignedTerminal.gracefulShutdown()).resolves.toBe("assigned-1");

    expect(host.captureEvents).toEqual([]);
  });

  it("still tears down when the host cannot open the window", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, {
      agentId: "claude",
      openCapture: () => {
        throw new Error("host unavailable");
      },
    });

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toContain("/quit\r");
    handles.output("claude --resume no-window\n");

    await expect(promise).resolves.toBe("no-window");
  });
});
