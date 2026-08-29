import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ASSISTANT_HOST_PROTOCOL_VERSION,
  type AssistantHostCommand,
  type AssistantHostEvent,
  type AssistantHostReadyEvent,
  type AssistantHostSessionDescriptor,
} from "../../../shared/types/ipc/assistantHost.js";
import { parseAssistantHostEvent } from "../../schemas/ipc.js";

/**
 * Owns one `daintree-assistant host --stdio` child process and the NDJSON protocol
 * channel to it.
 *
 * ## Why `child_process.spawn`, not `utilityProcess.fork`
 *
 * The previous version of this file forked a JavaScript entry point from an npm
 * package. The engine is a Go binary now, and `utilityProcess.fork` runs a Node
 * script — it cannot execute one. That mismatch (plus a structured-clone transport
 * where the engine speaks NDJSON) is why Daintree sat at protocol v1 while the engine
 * moved to v3.
 *
 * ## Framing
 *
 * stdin  — the first line is the {@link AssistantHostSessionDescriptor}; every
 *          subsequent line is one {@link AssistantHostCommand}.
 * stdout — one {@link AssistantHostEvent} per line, Zod-validated before it is
 *          forwarded. An unparseable line is DROPPED, never partially applied.
 * stderr — human diagnostics only. Protocol JSON never appears here, and this class
 *          never tries to parse it.
 *
 * ## Sequence gaps
 *
 * v3 stamps a monotonic `seq` on every event. This class checks it and reports a gap
 * through `onSequenceGap`, because a gap means the transcript being rendered is
 * incomplete — and a UI that shows an incomplete answer as if it were the whole one
 * is worse than a UI that says it lost something. Gaps should be vanishingly rare
 * (the engine applies backpressure rather than shedding), which is exactly why one is
 * worth surfacing rather than absorbing.
 */

/** Frames larger than this are a protocol violation; matches the engine's own cap. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Readiness budget. The engine can spend up to 60s acquiring the project ownership
 * lease from a previous owner before it answers `host:ready`, so a 30s parent timeout
 * would kill a perfectly legitimate handover. A parent deadline must exceed the
 * child's own maximum plus margin, or it turns a slow success into a hard failure.
 */
const READY_TIMEOUT_MS = 90_000;

/**
 * Graceful-exit budget. Teardown in the engine joins a cancelled turn (up to ~5s),
 * re-arms undelivered wake events so they are not lost, and drains its writer queue
 * so the tail of the conversation is actually delivered. SIGKILLing at 2s would cut
 * all three off — the durable work is the part that matters, since it is what the
 * next session resumes from.
 */
const GRACEFUL_EXIT_MS = 10_000;

export interface AssistantHostProcessOptions {
  /** Absolute path to the engine binary (see `resolveAssistantBinary`). */
  binaryPath: string;
  /** Non-secret descriptor written as the first stdin line. */
  descriptor: AssistantHostSessionDescriptor;
  /**
   * Environment for the child. Secrets (`DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN` /
   * `DAINTREE_WINDOW_ID`) and project context travel HERE, never in the descriptor —
   * so a descriptor that leaks into a log or a port message carries nothing.
   */
  env: Record<string, string>;
  /** Working directory (the project root). */
  cwd: string;
  /** Every validated inbound event, including `host:ready`. */
  onEvent: (event: AssistantHostEvent) => void;
  /** The child exited, cooperatively or otherwise. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** A line of engine diagnostics (stderr). Never protocol data. */
  onDiagnostic?: (line: string) => void;
  /**
   * A sequence gap was observed: `missing` frames were lost between `after` and
   * `received`. The transcript is incomplete from here.
   */
  onSequenceGap?: (info: { after: number; received: number; missing: number }) => void;
}

export class AssistantHostProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** True once the child has actually exited, so a waiter arriving late is not stranded. */
  private exited = false;
  private readonly exitWaiters = new Set<() => void>();

  /** Records the exit and releases anything waiting on it. Idempotent. */
  private markExited(): void {
    this.child = null;
    this.exited = true;
    for (const resolve of this.exitWaiters) resolve();
    this.exitWaiters.clear();
  }
  private readonly readyPromise: Promise<void>;
  private readyEvent: AssistantHostReadyEvent | null = null;
  /**
   * Events the engine emitted BEFORE the renderer could know its session id.
   *
   * The renderer discards every frame until `start()` resolves and tells it which
   * session it owns, so anything the engine says during boot lands in that gap. The
   * ready frame is already handed back through the start result; these are the others,
   * replayed the same way rather than lost.
   */
  private preReadyEvents: AssistantHostEvent[] = [];
  /** Flips once the start result has been handed back, after which nothing buffers. */
  private readyReported = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private disposed = false;

  /** Partial stdout line carried across chunk boundaries. */
  private stdoutBuffer = "";
  private stderrBuffer = "";
  /** Highest `seq` seen; 0 means nothing yet (the engine counts from 1). */
  private lastSeq = 0;

  constructor(private readonly opts: AssistantHostProcessOptions) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  start(): void {
    if (this.child || this.disposed) return;

    const child = spawn(this.opts.binaryPath, ["host", "--stdio"], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Never a shell: the binary path and args are ours, and a shell would add
      // quoting semantics to a path that may legitimately contain spaces.
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("error", (error) => {
      // Spawn failed outright (missing, or not executable). There will be no exit event
      // carrying a useful code, so fail readiness here with the real cause.
      this.rejectReady(
        new Error(
          `Failed to start the assistant engine (${this.opts.binaryPath}): ${error.message}`
        )
      );
      // Settle the same state the exit handler settles. Node does not promise an `exit`
      // after a spawn failure, so without this a shutdown waiting on this host sits out
      // its full grace period for a process that never existed — and `onExit` could then
      // be called twice if an exit did arrive.
      if (this.exited) return;
      this.markExited();
      this.opts.onExit?.(null, null);
    });

    // stdin errors MUST be consumed. A prompt that races child exit or disposal
    // produces an asynchronous EPIPE / ERR_STREAM_WRITE_AFTER_END, and an unhandled
    // 'error' on a stream can take down Electron's main process — losing every window,
    // not just the assistant.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // EPIPE just means the child is gone; the exit handler owns that story.
      if (error.code !== "EPIPE") {
        this.opts.onDiagnostic?.(`[assistant-host] stdin error: ${error.message}`);
      }
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));

    child.on("exit", (code, signal) => {
      if (this.exited) return;
      this.markExited();
      this.clearReadyTimer();
      if (!this.settled) {
        this.rejectReady(
          new Error(`The assistant engine exited before it was ready (code ${code ?? "null"}).`)
        );
      }
      this.opts.onExit?.(code, signal);
    });

    // The descriptor is the FIRST line, before any command. The engine validates it
    // and answers `host:ready`; a version it does not recognise is refused outright
    // rather than guessed at.
    this.writeLine(this.opts.descriptor);

    this.readyTimer = setTimeout(() => {
      this.rejectReady(
        new Error(`The assistant engine did not signal ready within ${READY_TIMEOUT_MS / 1000}s.`)
      );
      this.dispose();
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  /** Resolves on `host:ready`; rejects on early exit, spawn failure, or timeout. */
  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Resolves when the child exits, or when `timeoutMs` runs out — and KILLS it if it
   * does. Resolves immediately if there was never a child, or it is already gone.
   *
   * This is the piece shutdown needs that `dispose` cannot provide. `dispose` asks the
   * engine to stop and arms an unref'd backstop, which is right while the app is
   * running: a displaced engine must not hold the process open. At quit that same
   * unref'd timer is worthless, because `app.exit()` takes it with it — so the kill has
   * to happen synchronously with the shutdown sequence, while there is still a process
   * around to issue it. A spawned child is not reaped with its parent.
   */
  waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.exitWaiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(() => {
        // Out of budget. A signal is not a bad outcome for a process being torn down;
        // an orphan holding a state lease is.
        let signalled: boolean;
        try {
          signalled = child.kill("SIGKILL");
        } catch {
          // Exited between the timer firing and this call — which is the outcome we
          // wanted anyway.
          signalled = true;
        }
        if (!signalled) {
          // The signal did not land, and reporting "shut down" over that would be the
          // same lie this method exists to stop telling. Say so and settle regardless:
          // there is nothing further this process can do about it, and holding the
          // quit open would not change the answer.
          console.warn(
            `[assistant-host] Could not signal engine ${this.opts.descriptor.sessionId}; it may outlive Daintree.`
          );
        }
        settle();
      }, timeoutMs);
      timer.unref?.();
      this.exitWaiters.add(settle);
    });
  }

  /** The `host:ready` frame this engine announced itself with, once ready. */
  getReadyEvent(): AssistantHostReadyEvent | null {
    return this.readyEvent;
  }

  /**
   * The child's pid, or null before spawn and after exit.
   *
   * For the host's own logging: a startup that hangs before `host:ready` looks
   * identical from the outside whether the engine never spawned or spawned and went
   * quiet, and the pid is what separates the two — it is also what someone reaching for
   * `lldb`/`sample` on a wedged engine needs.
   */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Events emitted before readiness, for the caller to replay. Drained by this call. */
  takePreReadyEvents(): AssistantHostEvent[] {
    this.readyReported = true;
    const events = this.preReadyEvents;
    this.preReadyEvents = [];
    return events;
  }

  /**
   * Sends a command. Returns whether it was ACCEPTED — not whether it was flushed.
   *
   * The distinction matters: `stream.write()` returns false for backpressure, which
   * means "accepted, buffered" and not "rejected". Treating that as a failure invites
   * a caller to retry a command the engine will also receive, and a duplicated
   * `approval:decide` or `prompt` is a real bug rather than a wasted byte.
   */
  send(command: AssistantHostCommand): boolean {
    return this.writeLine(command);
  }

  /**
   * Cooperative shutdown, then a hard kill backstop. Idempotent.
   *
   * The engine drains its writer queue before emitting `host:shutdown`, so the
   * graceful path genuinely delivers the tail of the conversation rather than
   * truncating it — which is why it is worth waiting a moment for.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReadyTimer();

    const child = this.child;
    if (!child) return;

    // Written directly: `writeLine` refuses once `disposed` is set, and this frame is
    // the whole point of a cooperative shutdown.
    try {
      if (child.stdin.writable) {
        child.stdin.write(
          `${JSON.stringify({ type: "shutdown", sessionId: this.opts.descriptor.sessionId })}\n`
        );
      }
    } catch {
      // Already gone; the kill backstop below still applies.
    }
    try {
      child.stdin.end();
    } catch {
      // Already closed; the kill backstop below still applies.
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing left to kill.
      }
    }, GRACEFUL_EXIT_MS);
    killTimer.unref?.();
  }

  /**
   * Writes one NDJSON line to the child's stdin. Returns whether the write was
   * accepted; see `send` for why that is not the same as `write()`'s return value.
   */
  private writeLine(payload: unknown): boolean {
    const child = this.child;
    // `disposed` is checked too: after dispose() the stream may not yet be destroyed,
    // and a late write would land after the shutdown command.
    if (!child || this.disposed || child.stdin.destroyed || !child.stdin.writable) {
      return false;
    }
    try {
      // Ignore the backpressure signal deliberately — the payloads here are tiny
      // control frames and Node buffers them for us.
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Splits stdout into lines across chunk boundaries and validates each.
   *
   * A single event can exceed one chunk, so the tail is carried forward. The buffer
   * is capped: without it, an engine that somehow emitted an unterminated stream
   * would grow this string until the main process died — a bad frame must cost a
   * frame, not the app.
   */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    // Complete lines are extracted FIRST. Checking the aggregate length before
    // splitting meant a large-but-valid frame plus the chunk carrying its newline
    // could exceed the cap and discard BOTH — the frame and the perfectly good one
    // behind it. The cap belongs on the unterminated tail, which is the only part
    // that can actually grow without bound.
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.handleLine(line);
    }

    if (this.stdoutBuffer.length > MAX_FRAME_BYTES) {
      this.opts.onDiagnostic?.(
        `[assistant-host] dropped an oversize unterminated stdout frame (>${MAX_FRAME_BYTES})`
      );
      this.stdoutBuffer = "";
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stderrBuffer.indexOf("\n")) !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.opts.onDiagnostic?.(line);
    }
    // Cap the partial tail so a stderr flood cannot grow unbounded either.
    if (this.stderrBuffer.length > 64 * 1024) this.stderrBuffer = "";
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.opts.onDiagnostic?.(`[assistant-host] dropped a non-JSON stdout line`);
      return;
    }

    const event = parseAssistantHostEvent(raw);
    if (!event) {
      // Dropped, never partially applied: a message we cannot validate is a message
      // we cannot reason about, and forwarding half of it would put the renderer into
      // a state no schema describes.
      this.opts.onDiagnostic?.(`[assistant-host] dropped an invalid host event`);
      return;
    }

    // A frame must name OUR session. The engine is a separate process speaking a wire
    // protocol; a frame for another session id is either a bug or a crossed stream, and
    // accepting one lets a wrong-session `host:ready` satisfy this session's readiness.
    if (event.sessionId !== this.opts.descriptor.sessionId) {
      this.opts.onDiagnostic?.(
        `[assistant-host] dropped a frame for a different session (${event.sessionId})`
      );
      return;
    }

    if (!this.checkSequence(event)) return;

    if (event.type === "host:ready") {
      if (event.protocolVersion !== ASSISTANT_HOST_PROTOCOL_VERSION) {
        // Refuse rather than guess. The two halves of this protocol drifted silently
        // once already; a mismatched peer is a hard failure, not a degraded mode.
        this.rejectReady(
          new Error(
            `Assistant engine protocol mismatch: it speaks v${event.protocolVersion}, ` +
              `Daintree speaks v${ASSISTANT_HOST_PROTOCOL_VERSION}. ` +
              `Update the vendor/daintree-assistant submodule and rebuild.`
          )
        );
        this.dispose();
        return;
      }
      this.clearReadyTimer();
      // Retained so the start IPC can hand it back to the caller. `host:ready` is
      // emitted before `start()` returns, and the renderer discards events until it
      // learns its own session id, so the frame carrying `autoApprove` — the flag that
      // says mutating tools run with NO confirmation — is the one most likely to be
      // dropped, and the least acceptable to lose.
      this.readyEvent = event;
      this.resolveReady();
    }

    // Buffered until readiness has been reported: everything after that reaches the
    // renderer normally, because by then it has been told its session id.
    if (!this.readyReported && event.type !== "host:ready") {
      this.preReadyEvents.push(event);
    }
    this.opts.onEvent(event);
  }

  /**
   * Detects a lost frame. The engine stamps `seq` monotonically from 1 under a single
   * lock, so a skipped number can only mean a frame did not arrive.
   */
  private checkSequence(event: AssistantHostEvent): boolean {
    const expected = this.lastSeq + 1;

    // Checked from the very first frame: the engine counts from 1, so `lastSeq === 0`
    // still has an expectation. Exempting it meant that if frame 1 failed validation,
    // frame 2 was silently adopted as the beginning and the loss went unreported.
    if (event.seq > expected) {
      this.opts.onSequenceGap?.({
        after: this.lastSeq,
        received: event.seq,
        missing: event.seq - expected,
      });
    }

    // A duplicate or backward frame is DROPPED, not forwarded. Applying a late event
    // would regress transcript state that newer frames already advanced — turning a
    // transport hiccup into visibly wrong content.
    if (event.seq <= this.lastSeq) {
      this.opts.onDiagnostic?.(
        `[assistant-host] dropped an out-of-order frame (seq ${event.seq} after ${this.lastSeq})`
      );
      return false;
    }

    this.lastSeq = event.seq;
    return true;
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private resolveReady(): void {
    if (this.settled) return;
    this.settled = true;
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private rejectReady(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
  }
}
