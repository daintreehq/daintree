/**
 * One non-interactive shell command run to completion as a real child process,
 * with its process tree reaped on timeout, cancel and quit, and its output
 * scrubbed and capped. Shared by `project.runCheck` and `project.runCommand`,
 * which differ only in what they let a caller run and where — the lifecycle is
 * the same, and a second copy of it would be a second set of reaping bugs.
 *
 * Process handling is ported from `AgentVersionService.runVersionProbe` —
 * close-first settlement with an exit-grace timer, a single-settle guard, and
 * process-group kills — because the commands it runs are untrusted-shaped
 * project scripts that routinely spawn grandchildren holding the stdout pipe
 * open.
 */

import { spawn, type ChildProcess } from "child_process";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  describeWindowsTreeKillProblem,
  killWindowsProcessTreeInBackground,
  killWindowsProcessTreeSync,
  liveChildTreeTarget,
} from "../utils/windowsTreeKill.js";

/**
 * Grace period between `exit` and a forced settle. `exit` does not guarantee
 * stdio has flushed; `close` does. When `close` never arrives, a grandchild is
 * holding the pipe — reap the group and settle with what the foreground wrote.
 */
const EXIT_DRAIN_MS = 2_000;

/** Delay before escalating SIGTERM to SIGKILL on a POSIX process group. */
const KILL_ESCALATION_MS = 5_000;

/**
 * Extra headroom after the SIGKILL escalation before the run is force-settled
 * without an OS event. Only reached when the kill itself failed to reap.
 */
const FORCE_SETTLE_MARGIN_MS = 2_000;

/**
 * Extra bytes retained ahead of the reported tail, purely so `scrubSecrets`
 * sees whole credentials that straddle the final cut.
 *
 * The scrubber matches on a leading sigil (`ghp_`, `-----BEGIN … KEY-----`, …).
 * Cut the buffer immediately after one and the retained bytes are the token's
 * body with nothing left to match — a redaction bypass that hands the caller a
 * secret it can reconstruct by prepending the known prefix. Scrubbing this
 * larger window first means anything crossing the final cut was already seen
 * whole and redacted. Sized well past the longest supported pattern (a PEM
 * block) so no realistic secret can span the whole overlap.
 */
const SCRUB_OVERLAP_BYTES = 8 * 1024;

/**
 * Fixed-size tail of the child's combined output. Keeps the LAST `maxBytes`
 * and drops from the front, because runners print their summary last. Streams
 * are still drained past the cap so the child never blocks on backpressure.
 */
class OutputTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;

    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.bytes - this.maxBytes;
      const first = this.chunks[0];
      if (first === undefined) break;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
        this.droppedBytes += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
        this.droppedBytes += excess;
      }
    }
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  /**
   * Decode the retained window — the reported tail plus the scrub overlap.
   * Slicing may cut a multi-byte codepoint, leaving a leading U+FFFD; the
   * overlap is discarded by {@link capTail} after scrubbing, so that artefact
   * never reaches the caller.
   */
  toText(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

/**
 * Final byte cap, applied after scrubbing so `[REDACTED]` expansion and U+FFFD
 * replacement characters cannot push the payload past the documented limit.
 * Keeps the tail, matching what the type promises.
 */
function capTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };

  const marker = "[truncated]\n";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let slice = buf.subarray(buf.length - budget).toString("utf-8");

  // Decoding can grow the payload: every byte of an invalid sequence becomes a
  // 3-byte U+FFFD. Re-measure and shed the excess in one pass — each dropped
  // JS code unit frees at least one UTF-8 byte, so this always lands under.
  const over = Buffer.byteLength(marker + slice, "utf8") - maxBytes;
  if (over > 0) slice = slice.slice(over);

  return { text: marker + slice, truncated: true };
}

/**
 * The handle a caller keeps on a run it admitted, so shutdown and its own
 * bookkeeping can stop it. The caller claims it before spawning, which is what
 * lets an admission check be synchronous; {@link runBoundedProcess} fills in
 * the two cancels once the child exists.
 */
export interface BoundedProcessSlot {
  /** Cooperative cancel: marks the run aborted, then SIGTERM → SIGKILL. */
  abort: () => void;
  /**
   * Shutdown cancel: same, but SIGKILLs immediately. The escalation timer is
   * useless during quit — the process exits before it could fire.
   */
  abortNow: () => void;
}

export interface BoundedProcessOutcome {
  exitCode: number | null;
  signalName: string | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  outputTruncated: boolean;
}

export interface BoundedProcessOptions {
  command: string;
  /**
   * Runs this program with these arguments instead of handing `command` to
   * the system shell, for a caller that picks the shell itself; `command` is
   * then not run.
   */
  executable?: { file: string; args: readonly string[] };
  cwd: string;
  /**
   * Built inside the spawn's error boundary, once per run, so a failure to
   * assemble the environment is a failure to start rather than a stray throw.
   */
  env: () => Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Names the run in a start or run failure, e.g. a runner's name. */
  label: string;
  /** Prefixes this module's own warnings with the caller's service name. */
  logPrefix: string;
  signal: AbortSignal | undefined;
  slot: BoundedProcessSlot;
  /** Builds the error a failure to start or run is rejected with. */
  createError: (message: string) => Error;
}

/**
 * Run one command to its end and report how it ended. A `command` runs with
 * `shell: true`: callers hand over real shell strings (`npm run test`,
 * Procfile entries with pipes, `git -C … status`), not argv arrays. An
 * `executable` runs as given, for a caller that chose the shell itself.
 *
 * Resolves for every run that started, whatever its outcome; rejects only when
 * the child could not be spawned or errored before exiting.
 */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessOutcome> {
  const { command, executable, cwd, env, timeoutMs, maxOutputBytes, label, logPrefix, signal, slot } =
    options;
  return new Promise<BoundedProcessOutcome>((resolve, reject) => {
    const useGroup = process.platform !== "win32";
    const tail = new OutputTail(maxOutputBytes + SCRUB_OVERLAP_BYTES);

    let child: ChildProcess;
    try {
      const spawnOptions = {
        cwd,
        windowsHide: true,
        detached: useGroup,
        env: env(),
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      };
      child = executable
        ? spawn(executable.file, [...executable.args], spawnOptions)
        : spawn(command, { ...spawnOptions, shell: true });
    } catch (err) {
      reject(
        options.createError(
          `Failed to start "${label}": ${formatErrorMessage(err, "unknown error")}`
        )
      );
      return;
    }

    // Detached + unref'd so an in-flight run can't pin main-process teardown.
    // The caller's dispose reaps the group; unref only drops the event-loop
    // ref-count, the ChildProcess object stays referenced here.
    child.unref();

    let settled = false;
    let timedOut = false;
    let aborted = false;
    // Set the moment the OS reports the process gone. Once it is, the run has
    // a real terminal cause, so a deadline or an abort landing during the
    // stdio drain must not relabel a run that already finished on its own.
    let exited = false;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let forceSettleTimer: ReturnType<typeof setTimeout> | null = null;
    // Whether this run ever asked for the tree to die. Drives the final
    // SIGKILL in cleanup(); a run that exited on its own never gets one.
    let killRequested = false;

    // Windows: the tree kill in flight, so a later cause joins it instead of
    // walking the same tree again.
    let windowsKill: Promise<unknown> | null = null;

    /** `quit` (Windows only) blocks until the tree is gone; see `abortNow`. */
    const killTree = (force = false, quit = false): void => {
      killRequested = true;
      const pid = child.pid;
      if (typeof pid !== "number") {
        child.kill();
        return;
      }
      if (!useGroup) {
        // Windows has no process groups here — `child.kill()` would terminate
        // only the shell and orphan the runner it launched. Only while the
        // shell lives: after its exit the PID is free for reuse, and no walk
        // reaches a dead root's descendants. Anything that may leave the tree
        // alive is logged.
        const target = liveChildTreeTarget(child);
        if (!target) return;
        if (quit) {
          // Synchronous only on the quit path: dispose must not return before
          // the tree is gone, and Main exits right after. Repeats a kill still
          // in flight, which may never get to finish.
          try {
            const problem = describeWindowsTreeKillProblem(
              killWindowsProcessTreeSync(target, { timeoutMs: 3_000 })
            );
            if (problem) console.warn(`${logPrefix} tree kill pid=${pid}: ${problem}`);
          } catch (err) {
            console.warn(
              `${logPrefix} tree kill pid=${pid}: ${formatErrorMessage(err, "unknown error")}`
            );
          }
          return;
        }
        // A cancel or deadline runs on Main mid-session: never block it.
        if (windowsKill) return;
        windowsKill = killWindowsProcessTreeInBackground(target, logPrefix, {
          timeoutMs: 3_000,
        }).finally(() => {
          windowsKill = null;
        });
        return;
      }

      // `force` skips the polite phase: the caller is settling now and will
      // stop watching, so there is no later event to escalate on.
      if (force) {
        signalGroup(pid, "SIGKILL", logPrefix);
        return;
      }

      // Negative pid signals the whole group, so a test runner's worker pool
      // dies with it. SIGTERM first to let the runner clean up, SIGKILL after
      // a grace period for anything that ignores it.
      signalGroup(pid, "SIGTERM", logPrefix);
      if (escalationTimer === null) {
        escalationTimer = setTimeout(
          () => signalGroup(pid, "SIGKILL", logPrefix),
          KILL_ESCALATION_MS
        );
        escalationTimer.unref?.();
      }
    };

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      // Settling means the foreground process is done, not that its group is
      // — a descendant that ignored SIGTERM still needs the SIGKILL. Deliver
      // it NOW and drop the pending escalation rather than leaving a timer
      // armed: a delayed signal fires against a bare numeric pgid, which the
      // OS may have recycled onto an unrelated group by then.
      if (killRequested && useGroup && typeof child.pid === "number") {
        signalGroup(child.pid, "SIGKILL", logPrefix);
      }
      if (escalationTimer) clearTimeout(escalationTimer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      signal?.removeEventListener("abort", onAbort);
      // Drop only `data` so a late chunk can't re-enter finish(), but keep
      // the `error` sinks below alive — destroy() can surface a pending
      // EIO/EBADF on the next tick, and an unhandled stream error is fatal
      // in the main process.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = (exitCode: number | null, signalName: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Scrub the whole retained window BEFORE the final cap. The scrubber's
      // own contract is that callers truncate downstream of it: a cut inside
      // a token hides the sigil it matches on, and the overlap guarantees
      // anything spanning the cut was already seen — and redacted — here.
      const capped = capTail(scrubSecrets(tail.toText()), maxOutputBytes);
      resolve({
        exitCode,
        signalName,
        timedOut,
        aborted,
        output: capped.text,
        outputTruncated: tail.truncated || capped.truncated,
      });
    };

    /**
     * Kill escalation cannot be assumed to work — a process wedged in
     * uninterruptible I/O, or a failed Windows tree kill, emits neither
     * `exit` nor `close`. Without this the promise (and the caller's slot)
     * would stay pending past the advertised ceiling forever. Settles with a
     * null exit code, which every caller reads as a failure.
     */
    const armForceSettle = (): void => {
      if (forceSettleTimer !== null) return;
      forceSettleTimer = setTimeout(() => {
        killTree(true);
        finish(null, null);
      }, KILL_ESCALATION_MS + FORCE_SETTLE_MARGIN_MS);
      forceSettleTimer.unref?.();
    };

    // First terminal cause wins. `exited` participates: once the process is
    // gone, a deadline that elapses while stdio is still draining describes
    // the drain, not the run, and must not mark a finished run timed out.
    const claimAbort = (): boolean => {
      if (settled || aborted || timedOut || exited) return false;
      aborted = true;
      return true;
    };

    const onAbort = (): void => {
      if (!claimAbort()) return;
      killTree();
      armForceSettle();
    };

    const timeoutTimer = setTimeout(() => {
      if (settled || timedOut || aborted || exited) return;
      timedOut = true;
      killTree();
      armForceSettle();
    }, timeoutMs);
    timeoutTimer.unref?.();

    signal?.addEventListener("abort", onAbort, { once: true });
    slot.abort = onAbort;
    slot.abortNow = () => {
      if (settled) return;
      // Claims the cause without the polite kill, then issues exactly one
      // forced kill. Routing through onAbort() would run the tree-kill twice
      // — on Windows that is two serial 3s tree kills per run, blocking the
      // main thread during quit.
      claimAbort();
      killTree(true, true);
      armForceSettle();
    };

    // Unhandled stream `error` is fatal in main; these sinks must outlive
    // cleanup()'s destroy(), which is why cleanup only removes `data`.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));

    // `close` fires after exit AND stdio EOF, so it carries complete output.
    child.on("close", (code, closeSignal) => finish(code ?? null, closeSignal ?? null));

    // `exit` can precede the final stdout flush. Never wait on `close` alone:
    // a daemon grandchild holding the pipe would keep the promise pending
    // until the timeout, reporting a spurious timedOut on a run that passed.
    child.on("exit", (code, exitSignal) => {
      // Claim the terminal cause even when a grace timer is already armed —
      // the process is gone either way, and the deadline must stop competing.
      exited = true;
      if (settled || exitGraceTimer) return;
      exitGraceTimer = setTimeout(() => {
        // `close` never came, so a descendant still holds the pipe. SIGKILL
        // it outright: nothing is left watching for it to wind down politely.
        killTree(true);
        finish(code ?? null, exitSignal ?? null);
      }, EXIT_DRAIN_MS);
      exitGraceTimer.unref?.();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        options.createError(`Failed to run "${label}": ${formatErrorMessage(err, "unknown error")}`)
      );
    });
  });
}

function signalGroup(pid: number, sig: NodeJS.Signals, logPrefix: string): void {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    // ESRCH means the group is already gone — nothing to reap. EPERM/EINVAL
    // mean the tree may still be alive, which an operator needs to know about.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn(
        `${logPrefix} ${sig} group pid=${pid}: ${formatErrorMessage(err, "unknown error")}`
      );
    }
  }
}
