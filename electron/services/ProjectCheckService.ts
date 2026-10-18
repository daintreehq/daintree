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
 * Process handling lives in `boundedProcess.ts`, shared with
 * `project.runCommand`; this service owns only the check policy — which
 * runner, which directory, one check per directory, and the environment.
 */

import {
  PROJECT_CHECK_DEFAULT_TIMEOUT_MS,
  PROJECT_CHECK_MAX_OUTPUT_BYTES,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
  type ProjectCheckRunArgs,
  type ProjectCheckRunResult,
} from "../../shared/types/projectCheck.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { buildInstallEnv } from "../utils/spawnEnv.js";
import {
  runBoundedProcess,
  type BoundedProcessOutcome,
  type BoundedProcessSlot,
} from "./boundedProcess.js";
import { resolveProjectCwd } from "./projectCwd.js";

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
 * Reserved entry in the in-flight map. `runCheck` claims the slot before it
 * spawns so two concurrent callers can never both pass the busy check, and the
 * process runner fills in the cancels once the child exists.
 */
interface ActiveSlot extends BoundedProcessSlot {
  runnerName: string;
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

    const cwd = await resolveProjectCwd(
      project.path,
      args.cwd,
      (message) => new ProjectCheckError(message)
    );

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

    // Claim the slot synchronously, before the first await inside the run,
    // so a second concurrent caller for this cwd sees it as busy.
    const slot: ActiveSlot = { runnerName: runner.name, abort: () => {}, abortNow: () => {} };
    this.active.set(cwd, slot);

    let outcome: BoundedProcessOutcome;
    try {
      outcome = await runBoundedProcess({
        command: runner.command,
        cwd,
        env: () => buildCheckEnv(cwd),
        timeoutMs,
        maxOutputBytes: PROJECT_CHECK_MAX_OUTPUT_BYTES,
        label: runner.name,
        logPrefix: "[ProjectCheckService]",
        signal: options?.signal,
        slot,
        createError: (message) => new ProjectCheckError(message),
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
