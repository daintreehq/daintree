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
 * is re-resolved here against a fresh detection in the target directory, so
 * the MCP surface is "run something this project already declares", not
 * "run arbitrary shell". `cwd` is likewise validated against the repo's
 * registered worktrees rather than trusted.
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
   * Byte-accurate slicing can cut a multi-byte codepoint, yielding a leading
   * U+FFFD. Accepted — the alternative is a cap that silently over- or
   * under-shoots the documented byte limit.
   */
  toText(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

/**
 * Reserved entry in the in-flight map. `runCheck` claims the slot before it
 * spawns so two concurrent callers can never both pass the busy check, and
 * `spawnCheck` fills in `abort` once the child exists.
 */
interface ActiveSlot {
  runnerName: string;
  abort: () => void;
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
    const slot: ActiveSlot = { runnerName: runner.name, abort: () => {} };
    this.active.set(cwd, slot);

    let outcome: SpawnOutcome;
    try {
      outcome = await this.spawnCheck(runner.command, cwd, timeoutMs, runner.name, {
        signal: options?.signal,
        slot,
      });
    } finally {
      this.active.delete(cwd);
    }

    return {
      projectId: project.id,
      cwd,
      runnerId: runner.id,
      runnerName: runner.name,
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

  /** Abort every in-flight check. Used by the app shutdown chain. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.active.values()) {
      try {
        entry.abort();
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
      let escalationTimer: ReturnType<typeof setTimeout> | null = null;
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;

      const killTree = (): void => {
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
        if (escalationTimer) clearTimeout(escalationTimer);
        if (exitGraceTimer) clearTimeout(exitGraceTimer);
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
        resolve({
          exitCode,
          signalName,
          timedOut,
          aborted,
          output: scrubSecrets(tail.toText()),
          outputTruncated: tail.truncated,
        });
      };

      const onAbort = (): void => {
        if (settled || aborted || timedOut) return;
        aborted = true;
        killTree();
      };

      // First terminal cause wins: an abort that lands after the deadline
      // already fired must not relabel a timeout as a cancellation, and vice
      // versa — the agent's retry decision differs between the two.
      const timeoutTimer = setTimeout(() => {
        if (settled || timedOut || aborted) return;
        timedOut = true;
        killTree();
      }, timeoutMs);
      timeoutTimer.unref?.();

      signal?.addEventListener("abort", onAbort, { once: true });
      slot.abort = onAbort;

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
        if (settled || exitGraceTimer) return;
        exitGraceTimer = setTimeout(() => {
          killTree();
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
