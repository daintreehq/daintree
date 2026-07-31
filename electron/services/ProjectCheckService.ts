/**
 * Runs one of a project's detected runners as a real child process and reports
 * its authoritative exit code (#11548).
 *
 * Why this exists in main rather than as an ordinary renderer action: a check
 * is the one operation whose whole value is the exit code, and renderer MCP
 * dispatch is capped at `MCP_DISPATCH_TIMEOUT_MS` (30s) — shorter than almost
 * any real test suite. The MCP `AbortSignal` also cannot cross IPC, so a
 * renderer-hosted run could never be cancelled. `terminal.waitUntilIdle` set
 * the precedent: register the manifest entry in the renderer, execute here.
 *
 * Security boundary: callers name a `runnerId`, never a command. The command
 * text is looked up here from the detector's view of the target directory, so
 * the MCP surface is "run something this project already declares", not
 * "run arbitrary shell". `cwd` is likewise validated against the repo's
 * registered worktrees rather than trusted.
 *
 * Two known limits of that boundary, both accepted: `RunCommandDetector`
 * caches for 60s, so a runner the user just deleted stays runnable for up to a
 * minute; and the cwd is validated by path, so a local process that can rename
 * the directory between the check and the spawn could redirect it. Closing
 * either needs an uncached detect path and handle-based execution
 * respectively — neither is in scope for #11548.
 *
 * Process handling is ported from `AgentVersionService.runVersionProbe` —
 * close-first settlement with an exit-grace timer, a single-settle guard, and
 * process-group kills — because a check runs untrusted-shaped project scripts
 * that routinely spawn grandchildren holding the stdout pipe open.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { realpath } from "fs/promises";
import {
  PROJECT_CHECK_DEFAULT_TIMEOUT_MS,
  PROJECT_CHECK_MAX_OUTPUT_BYTES,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
  type ProjectCheckRunArgs,
  type ProjectCheckRunResult,
} from "../../shared/types/projectCheck.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { buildInstallEnv } from "../utils/spawnEnv.js";

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
 * Thrown when a check could not be started at all — unknown project, unknown
 * runner, unusable directory, or a busy target. Distinct from a check that ran
 * and failed, which is a normal result with `passed: false`.
 */
export class ProjectCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectCheckError";
  }
}

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
   * Decode the retained tail, dropping any partial first line.
   *
   * Dropping that line is a security requirement, not cosmetics. The byte cap
   * cuts at an arbitrary offset, and `scrubSecrets` recognizes a credential by
   * its sigil (`ghp_`, `sk-`, …). If the cut lands just after the sigil, the
   * retained bytes are the token's body with nothing left for the scrubber to
   * match — a redaction bypass that hands the caller a reconstructable secret.
   * Realigning the front edge to a line start means a straddling token is
   * either wholly retained (and therefore scrubbed) or wholly dropped.
   *
   * A tail with no newline at all cannot be realigned; it is passed through so
   * a single enormous line still yields output. Slicing may also cut a
   * multi-byte codepoint, leaving a leading U+FFFD.
   */
  toText(): string {
    const text = Buffer.concat(this.chunks).toString("utf-8");
    if (!this.truncated) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? text : text.slice(firstBreak + 1);
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
  return { text: marker + buf.subarray(buf.length - budget).toString("utf-8"), truncated: true };
}

/**
 * Reserved entry in the in-flight map. `runCheck` claims the slot before it
 * spawns so two concurrent callers can never both pass the busy check, and
 * `spawnCheck` fills in `abort` once the child exists.
 */
interface ActiveSlot {
  runnerName: string;
  /** Cooperative cancel: marks the run aborted, then SIGTERM → SIGKILL. */
  abort: () => void;
  /**
   * Shutdown cancel: same, but SIGKILLs immediately. The escalation timer is
   * useless during quit — the process exits before it could fire.
   */
  abortNow: () => void;
}

interface SpawnOutcome {
  exitCode: number | null;
  signalName: string | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  outputTruncated: boolean;
}

let cachedDetector: typeof import("./RunCommandDetector.js").runCommandDetector | null = null;
async function getRunCommandDetector(): Promise<
  typeof import("./RunCommandDetector.js").runCommandDetector
> {
  if (!cachedDetector) {
    const mod = await import("./RunCommandDetector.js");
    cachedDetector = mod.runCommandDetector;
  }
  return cachedDetector;
}

async function canonicalize(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

export class ProjectCheckService {
  /** In-flight runs keyed by canonical cwd, so one target runs one check. */
  private readonly active = new Map<string, ActiveSlot>();
  private disposed = false;

  /**
   * Resolve, authorize, and run a single check.
   *
   * @throws {ProjectCheckError} when no run could be started. A run that
   * started and then failed, timed out, or was cancelled resolves normally
   * with the corresponding flags set.
   */
  async runCheck(
    args: ProjectCheckRunArgs,
    options?: { signal?: AbortSignal }
  ): Promise<ProjectCheckRunResult> {
    if (this.disposed) {
      throw new ProjectCheckError("Daintree is shutting down; no new checks can start.");
    }

    const projectId = args.projectId.trim();
    const runnerId = args.runnerId.trim();
    if (!projectId) throw new ProjectCheckError("`projectId` is required.");
    if (!runnerId) throw new ProjectCheckError("`runnerId` is required.");

    const { projectStore } = await import("./ProjectStore.js");
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new ProjectCheckError(
        `No project found with id "${projectId}". Use project.getAll to list open projects.`
      );
    }

    const cwd = await this.resolveCwd(project.path, args.cwd);

    const detector = await getRunCommandDetector();
    const runners = await detector.detect(cwd);
    const runner = runners.find((r) => r.id === runnerId);
    if (!runner) {
      const available = runners.map((r) => r.id);
      throw new ProjectCheckError(
        available.length > 0
          ? `No runner "${runnerId}" detected in ${cwd}. Available runner ids: ${available.join(", ")}.`
          : `No runner "${runnerId}" detected in ${cwd}: no runners were detected there at all.`
      );
    }

    // Abort that arrives before the spawn means nothing ever ran, so there is
    // no exit code to report — that is a failure to start, not a result.
    if (options?.signal?.aborted) {
      throw new ProjectCheckError("Cancelled before the check started.");
    }

    // Re-checked after every await above: `dispose()` may have run while this
    // call sat in resolveCwd/detect, and it only aborts what is already in the
    // active map. Without this, a check would spawn detached AFTER shutdown
    // reaped everything — exactly the orphan the shutdown hook exists to stop.
    if (this.disposed) {
      throw new ProjectCheckError("Daintree is shutting down; no new checks can start.");
    }

    const existing = this.active.get(cwd);
    if (existing) {
      throw new ProjectCheckError(
        `A check ("${existing.runnerName}") is already running in ${cwd}. Wait for it to finish before starting another.`
      );
    }

    const timeoutMs = clampTimeout(args.timeoutMs);
    const startedAt = Date.now();

    // Claim the slot synchronously, before the first await inside spawnCheck,
    // so a second concurrent caller for this cwd sees it as busy.
    const slot: ActiveSlot = { runnerName: runner.name, abort: () => {}, abortNow: () => {} };
    this.active.set(cwd, slot);

    let outcome: SpawnOutcome;
    try {
      outcome = await this.spawnCheck(runner.command, cwd, timeoutMs, runner.name, {
        signal: options?.signal,
        slot,
      });
    } finally {
      // Identity-checked: `dispose()` clears the map wholesale, so a later run
      // can already own this key by the time this settles. An unconditional
      // delete would free a directory that is still busy.
      if (this.active.get(cwd) === slot) this.active.delete(cwd);
    }

    return {
      projectId: project.id,
      cwd,
      runnerId: runner.id,
      runnerName: runner.name,
      command: runner.command,
      passed: outcome.exitCode === 0 && !outcome.timedOut && !outcome.aborted,
      exitCode: outcome.exitCode,
      signalName: outcome.signalName,
      durationMs: Date.now() - startedAt,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      output: outcome.output,
      outputTruncated: outcome.outputTruncated,
    };
  }

  /**
   * Kill every in-flight check. Called from the app shutdown chain: POSIX
   * children are spawned detached, so an unreaped `npm test` outlives the app.
   * Synchronous by design — it issues signals and returns rather than awaiting
   * settlement, so it adds no await to the bounded shutdown chain.
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.active.values()) {
      try {
        entry.abortNow();
      } catch (err) {
        console.warn(
          "[ProjectCheckService] abort during dispose failed:",
          formatErrorMessage(err, "unknown error")
        );
      }
    }
    this.active.clear();
  }

  /**
   * A caller-supplied `cwd` must be the project root or one of the repo's
   * registered worktrees — resolved through git, never trusted as a path. Both
   * sides are canonicalized so a symlinked worktree root still matches.
   */
  private async resolveCwd(projectPath: string, requested: string | undefined): Promise<string> {
    const projectRoot = await canonicalize(projectPath);
    if (!projectRoot) {
      throw new ProjectCheckError(`Project directory does not exist: ${projectPath}`);
    }
    if (requested === undefined || requested.trim() === "") return projectRoot;

    const candidate = await canonicalize(requested);
    if (!candidate) {
      throw new ProjectCheckError(`Directory does not exist: ${requested}`);
    }
    if (candidate === projectRoot) return candidate;

    const { GitService } = await import("./GitService.js");
    let worktrees: Array<{ path: string; bare: boolean }>;
    try {
      worktrees = await new GitService(projectRoot).listWorktrees();
    } catch (err) {
      throw new ProjectCheckError(
        `Could not list worktrees for ${projectRoot} to validate cwd: ${formatErrorMessage(err, "unknown error")}`
      );
    }

    const allowed: string[] = [projectRoot];
    for (const wt of worktrees) {
      if (wt.bare) continue;
      const resolved = await canonicalize(wt.path);
      if (resolved) allowed.push(resolved);
    }

    if (!allowed.includes(candidate)) {
      throw new ProjectCheckError(
        `${requested} is not the project root or one of its worktrees. Allowed: ${allowed.join(", ")}.`
      );
    }
    return candidate;
  }

  /**
   * Port of the `AgentVersionService.runVersionProbe` lifecycle, adapted to
   * report an exit code instead of parsed stdout. `shell: true` is mandatory:
   * `RunCommandDetector` emits real shell strings (`npm run test`, Procfile
   * entries with pipes, `bash -c '...'` remnants), not argv arrays.
   */
  private spawnCheck(
    command: string,
    cwd: string,
    timeoutMs: number,
    runnerName: string,
    context: { signal: AbortSignal | undefined; slot: ActiveSlot }
  ): Promise<SpawnOutcome> {
    const { signal, slot } = context;
    return new Promise<SpawnOutcome>((resolve, reject) => {
      const useGroup = process.platform !== "win32";
      const tail = new OutputTail(PROJECT_CHECK_MAX_OUTPUT_BYTES);

      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          detached: useGroup,
          env: buildCheckEnv(cwd),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(
          new ProjectCheckError(
            `Failed to start "${runnerName}": ${formatErrorMessage(err, "unknown error")}`
          )
        );
        return;
      }

      // Detached + unref'd so an in-flight check can't pin main-process
      // teardown. `dispose()` reaps the group; unref only drops the event-loop
      // ref-count, the ChildProcess object stays referenced here.
      child.unref();

      let settled = false;
      let timedOut = false;
      let aborted = false;
      // Set the moment the OS reports the process gone. Once it is, the run has
      // a real terminal cause, so a deadline or an abort landing during the
      // stdio drain must not relabel a check that already finished on its own.
      let exited = false;
      let escalationTimer: ReturnType<typeof setTimeout> | null = null;
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
      let forceSettleTimer: ReturnType<typeof setTimeout> | null = null;

      const killTree = (force = false): void => {
        const pid = child.pid;
        if (typeof pid !== "number") {
          child.kill();
          return;
        }
        if (!useGroup) {
          // Windows has no process groups here — `child.kill()` would terminate
          // only the shell and orphan the runner it launched.
          try {
            const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
              windowsHide: true,
              stdio: "ignore",
              timeout: 3_000,
            });
            // spawnSync reports failure in the result rather than throwing.
            // status 0 = killed, 128 = already gone (benign).
            if (result?.error) {
              console.warn(
                `[ProjectCheckService] taskkill pid=${pid}: ${formatErrorMessage(result.error, "unknown error")}`
              );
            } else if (result && result.status !== 0 && result.status !== 128) {
              console.warn(`[ProjectCheckService] taskkill pid=${pid} exited ${result.status}`);
            }
          } catch (err) {
            console.warn(
              `[ProjectCheckService] taskkill pid=${pid}: ${formatErrorMessage(err, "unknown error")}`
            );
          }
          return;
        }

        // `force` skips the polite phase: the caller is settling now and will
        // stop watching, so there is no later event to escalate on.
        if (force) {
          signalGroup(pid, "SIGKILL");
          return;
        }

        // Negative pid signals the whole group, so a test runner's worker pool
        // dies with it. SIGTERM first to let the runner clean up, SIGKILL after
        // a grace period for anything that ignores it.
        signalGroup(pid, "SIGTERM");
        if (escalationTimer === null) {
          escalationTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_ESCALATION_MS);
          escalationTimer.unref?.();
        }
      };

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        // The escalation timer is deliberately NOT cleared. Settling means the
        // foreground process is done, not that its group is — a descendant that
        // ignored SIGTERM still needs the SIGKILL. The timer is unref'd, and
        // signalGroup swallows ESRCH, so letting it fire on an already-dead
        // group is free.
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
        // Scrub BEFORE the final cap: the scrubber's own contract is that
        // callers truncate downstream of it, because a cut inside a token
        // hides the sigil it matches on.
        const capped = capTail(scrubSecrets(tail.toText()), PROJECT_CHECK_MAX_OUTPUT_BYTES);
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
       * uninterruptible I/O, or a failed Windows `taskkill`, emits neither
       * `exit` nor `close`. Without this the promise (and the cwd's
       * concurrency slot) would stay pending past the advertised ceiling
       * forever. Settles with a null exit code, which `passed` already treats
       * as a failure.
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
      // the drain, not the run, and must not mark a finished check timed out.
      const onAbort = (): void => {
        if (settled || aborted || timedOut || exited) return;
        aborted = true;
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
        onAbort();
        killTree(true);
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
      // until the timeout, reporting a spurious timedOut on a passing check.
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
          new ProjectCheckError(
            `Failed to run "${runnerName}": ${formatErrorMessage(err, "unknown error")}`
          )
        );
      });
    });
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    // ESRCH means the group is already gone — nothing to reap. EPERM/EINVAL
    // mean the tree may still be alive, which an operator needs to know about.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn(
        `[ProjectCheckService] ${sig} group pid=${pid}: ${formatErrorMessage(err, "unknown error")}`
      );
    }
  }
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return PROJECT_CHECK_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(
    PROJECT_CHECK_MAX_TIMEOUT_MS,
    Math.max(PROJECT_CHECK_MIN_TIMEOUT_MS, Math.floor(requested))
  );
}

/**
 * `buildInstallEnv()` is the reviewed allowlist already used for running
 * package managers — it carries PATH, HOME, proxy/CA settings, and version
 * manager roots (NVM_DIR, VOLTA_HOME, PYENV_ROOT, …) that `npm test` needs to
 * resolve a toolchain, and sets `TERM=dumb`. The overrides below then force
 * non-interactive behaviour so a runner can never sit waiting on a prompt
 * nobody can answer — there is no PTY attached to this process.
 */
function buildCheckEnv(cwd: string): Record<string, string> {
  return {
    ...buildInstallEnv(),
    CI: "1",
    NONINTERACTIVE: "1",
    GIT_TERMINAL_PROMPT: "0",
    DEBIAN_FRONTEND: "noninteractive",
    DAINTREE_CHECK_CWD: cwd,
  };
}

export const projectCheckService = new ProjectCheckService();
