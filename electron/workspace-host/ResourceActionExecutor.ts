import { mkdir, writeFile } from "fs/promises";
import { join as pathJoin } from "path";
import PQueue from "p-queue";
import type { WorkspaceHostEvent } from "../../shared/types/workspace-host.js";
import type { WorktreeResourceStatus } from "../../shared/types/worktree.js";
import { WorktreeMonitor } from "./WorktreeMonitor.js";
import type { IdlePauseCheck, IdlePauseGuard } from "../../shared/types/idlePause.js";
import {
  LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
  WorktreeLifecycleService,
  publishRunningOutput,
  type ResolvedResourceSelection,
} from "./WorktreeLifecycleService.js";
import { digestCommands, type IdlePauseService } from "./idlePause.js";
import { applyResourceConfigToMonitor } from "./resourceConfigHelpers.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { isValidSshTarget } from "../../shared/utils/sshTarget.js";

const READY_STATUSES = new Set(["ready", "running", "healthy", "up"]);
const RESUMABLE_STATUSES = new Set(["paused", "stopped"]);
// "stopped" kept only to gracefully handle a transient read from a CLI
// that hasn't switched to "paused" yet; the schema/UI no longer emit it.

const RESOURCE_ENVIRONMENT_CHANGED_ERROR = "Resource environment changed";

/** Longer than a pause's default timeout, so only a command that never exits is cut off. */
const IDLE_PAUSE_DELETE_WAIT_MS = 5 * 60_000;
/** Past a pause's own timeout, for its killed commands to exit. */
const IDLE_PAUSE_KILL_MARGIN_MS = 30_000;
/** Inside the 20 minutes a delete's port request is given, so it never outlives its caller. */
const IDLE_PAUSE_DELETE_WAIT_CEILING_MS = 15 * 60_000;

const DEFAULT_TIMEOUT_MS = {
  provision: 300_000,
  teardown: 300_000,
  resume: 120_000,
  pause: 120_000,
  status: 120_000,
} as const;

/**
 * Narrow context interface that the executor needs from the owning
 * `WorkspaceService`. Mutable workspace state (e.g. `projectRootPath`) is
 * exposed through getters so the executor always reads the current value
 * rather than capturing it at construction.
 */
export interface ResourceActionContext {
  getProjectRootPath(): string | null;
  getMonitor(worktreeId: string): WorktreeMonitor | undefined;
  getProjectEnvVars(): Record<string, string>;
  emitUpdate(monitor: WorktreeMonitor): void;
  sendEvent(event: WorkspaceHostEvent): void;
  readonly lifecycleService: WorktreeLifecycleService;
  readonly idlePause: IdlePauseService;
}

/** A resource action's result; `skipped` when an idle pause was refused before anything ran. */
export interface ResourceActionResult {
  success: boolean;
  error?: string;
  output?: string;
  skipped?: true;
}

/** What fills in a worktree's commands and their environment. */
interface WorktreeValues {
  path: string;
  name: string;
  branch: string | undefined;
}

function sameValues(a: WorktreeValues | undefined, b: WorktreeValues): boolean {
  return a !== undefined && a.path === b.path && a.name === b.name && a.branch === b.branch;
}

/** The pause as it would run: its commands filled in, and the values its environment carries. */
function digestPause(commands: readonly string[], values: WorktreeValues): string {
  return digestCommands([...commands, "\0", values.path, values.name, values.branch ?? ""]);
}

/** The workspace service stamps its process epoch on the guard. */
export type ExecutorIdlePauseCheck =
  | { ok: true; guard: Omit<IdlePauseGuard, "processEpoch"> }
  | Extract<IdlePauseCheck, { ok: false }>;

export type ResourceActionOptions =
  | { origin?: "auto-poll" }
  /** Asked for by main once the worktree's own host granted its ended idle time (#17925). */
  | { origin: "idle-pause"; guard: IdlePauseGuard };

/**
 * Encapsulates resource-action coordination and execution (`provision` /
 * `teardown` / `resume` / `pause` / `status`). Owns the per-worktree
 * `PQueue` and `AbortController` Maps so queue lifecycle is co-located
 * with the execution body.
 */
export class ResourceActionExecutor {
  private resourceActionQueues = new Map<string, PQueue>();
  private resourceActionAbortControllers = new Map<string, AbortController>();
  /**
   * Resource actions other than `status` each worktree has started. An idle
   * pause checked before one started and asked for after it finished would
   * pause a box someone just resumed or replaced.
   */
  private mutationGenerations = new Map<string, number>();
  /** Worktrees a delete is tearing down: no idle pause starts on them meanwhile. */
  private idlePauseHolds = new Map<string, number>();
  /** Each worktree's idle pause from admission to its end, for a delete to wait out. */
  private idlePausesRunning = new Map<string, Promise<unknown>>();
  /**
   * The worktree values each worktree's last ready status reading ran under.
   * A rename since means the box that reading named may not be the one its
   * commands name now, so an idle pause waits for a fresh reading.
   */
  private statusReadings = new Map<string, WorktreeValues>();
  /** The running idle pause's own command timeout, which bounds a delete's wait on it. */
  private idlePauseTimeouts = new Map<string, number>();
  private disposed = false;

  constructor(private readonly ctx: ResourceActionContext) {}

  async execute(
    requestId: string,
    worktreeId: string,
    action: "provision" | "teardown" | "resume" | "pause" | "status",
    environmentId: string | undefined,
    environmentEpoch: number,
    signal: AbortSignal,
    idleGuard?: IdlePauseGuard
  ): Promise<ResourceActionResult> {
    if (this.disposed) return { success: false, error: "Aborted" };
    const generationAtStart = this.generationOf(worktreeId);
    if (action !== "status") this.mutationGenerations.set(worktreeId, generationAtStart + 1);

    // What this action learns describes the environment it was asked about, so
    // once the worktree has moved to another one it stops writing (#15005).
    // Commands already running are left to finish.
    const monitorInEnvironment = (): WorktreeMonitor | undefined => {
      const live = this.ctx.getMonitor(worktreeId);
      return live?.resourceEnvironmentEpoch === environmentEpoch ? live : undefined;
    };

    const monitor = this.ctx.getMonitor(worktreeId);
    const projectRootPath = this.ctx.getProjectRootPath();
    if (!monitor || !projectRootPath) {
      return { success: false, error: "Worktree not found" };
    }

    if (signal.aborted) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "Aborted",
      });
      return { success: false, error: "Aborted" };
    }

    const { resolvedConfig, selection } = await this.ctx.lifecycleService.resolveResourceSelection(
      monitor.path,
      projectRootPath,
      environmentId,
      () => monitor.worktreeMode
    );
    const resourceConfig = selection?.resource;
    const resourceEnvironments = selection?.environments ?? null;

    if (idleGuard) {
      const check = await this.idlePauseCheck(monitor, selection, projectRootPath);
      const refusal = !check.ok
        ? check.reason
        : (this.admissionRefusal(worktreeId, monitor, idleGuard, generationAtStart) ??
          (check.selector !== idleGuard.selector ||
          check.fingerprint !== idleGuard.fingerprint ||
          check.sshTarget !== idleGuard.sshTarget
            ? "The environment changed since the pause was checked"
            : null));
      if (refusal !== null) return { success: false, error: refusal, skipped: true };
    }

    if (!resourceConfig) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "No resource config found",
      });
      return { success: false, error: "No resource config found" };
    }

    const vars = this.ctx.lifecycleService.buildVariables(
      monitor.path,
      projectRootPath,
      monitor.name,
      monitor.branch
    );
    const sub = (cmd: string) => this.ctx.lifecycleService.substituteVariables(cmd, vars);
    const values: WorktreeValues = {
      path: monitor.path,
      name: monitor.name,
      branch: monitor.branch,
    };
    // The commands this run would start, filled in now: a branch renamed since
    // the check would name another machine in the same template.
    if (
      idleGuard &&
      digestPause((resourceConfig.pause ?? []).map(sub), values) !== idleGuard.commandsDigest
    ) {
      return {
        success: false,
        error: "The worktree's pause commands changed since the pause was checked",
        skipped: true,
      };
    }

    // Checked here, after dequeue and against the config just read, so neither
    // a queued action nor the automatic status poll can run commands that were
    // approved when it was scheduled but have changed since.
    const commandsApproved = await this.ctx.lifecycleService.isResourceApproved(
      resolvedConfig,
      resourceEnvironments,
      projectRootPath
    );

    if (monitor.resourceEnvironmentEpoch !== environmentEpoch) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: RESOURCE_ENVIRONMENT_CHANGED_ERROR,
      });
      return { success: false, error: RESOURCE_ENVIRONMENT_CHANGED_ERROR };
    }

    const previousConnectCommand = monitor.resourceConnectCommand;
    applyResourceConfigToMonitor(monitor, resourceConfig, sub, commandsApproved);

    if (!commandsApproved) {
      // No status is written: nothing ran, so there is nothing observed to
      // report, and the last real status stays truthful.
      const liveMonitor = this.ctx.getMonitor(worktreeId);
      if (
        liveMonitor &&
        (liveMonitor.lifecycleCommandsNeedApproval !== true ||
          liveMonitor.resourceConnectCommand !== previousConnectCommand)
      ) {
        liveMonitor.setLifecycleCommandsNeedApproval(true);
        this.ctx.emitUpdate(liveMonitor);
      }
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
      });
      return { success: false, error: LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR };
    }

    const env = this.ctx.lifecycleService.buildEnv(
      monitor.path,
      projectRootPath,
      monitor.name,
      monitor.branch,
      {
        provider: resourceConfig.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      this.ctx.getProjectEnvVars()
    );
    // The environment is built after the approval read, from the monitor as it
    // is now: a rename in between leaves commands and environment disagreeing.
    const valuesHeld = sameValues(values, {
      path: monitor.path,
      name: monitor.name,
      branch: monitor.branch,
    });
    if (idleGuard && !valuesHeld) {
      return {
        success: false,
        error: "The worktree changed while the pause was being prepared",
        skipped: true,
      };
    }

    // Idempotent provision: route to resume when paused, no-op when already running.
    let effectiveAction = action;
    if (action === "provision") {
      const currentStatus = monitor.resourceStatus?.lastStatus?.toLowerCase().trim();
      if (currentStatus && READY_STATUSES.has(currentStatus)) {
        console.log(
          `[WorktreeLifecycle] Provision no-op for worktree ${worktreeId}: already ${currentStatus}`
        );
        // Re-fetch monitor — it may have been removed during loadConfig await.
        // Without this, emitUpdate broadcasts a snapshot that the renderer would
        // resurrect via its monotonic version counter (worktree-update arriving
        // after worktree-removed re-inserts the entry).
        const liveMonitor = this.ctx.getMonitor(worktreeId);
        if (liveMonitor) {
          // applyResourceConfigToMonitor already ran above and may have updated
          // resourceConnectCommand (e.g. when the config file changed on disk
          // since the last provision). Emit so the renderer store sees it.
          this.ctx.emitUpdate(liveMonitor);
        }
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: true,
          output: `Resource is already ${currentStatus}`,
        });
        return { success: true, output: `Resource is already ${currentStatus}` };
      }
      if (currentStatus && RESUMABLE_STATUSES.has(currentStatus)) {
        console.log(
          `[WorktreeLifecycle] Provision routing to resume for worktree ${worktreeId}: currently ${currentStatus}`
        );
        effectiveAction = "resume";
      }
      // otherwise (not configured / error / unknown / undefined) fall through to provision.
    }

    if (action === "status") {
      if (!resourceConfig.status) {
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: false,
          error: "No status command configured",
        });
        return { success: false, error: "No status command configured" };
      }

      const statusCmd = sub(resourceConfig.status);

      monitor.setLifecycleStatus({
        phase: "resource-status",
        state: "running",
        commandIndex: 0,
        totalCommands: 1,
        currentCommand: statusCmd,
        startedAt: Date.now(),
      });
      this.ctx.emitUpdate(monitor);

      const statusTimeoutSec = resourceConfig.timeouts?.status;
      const statusTimeoutMs = statusTimeoutSec != null ? statusTimeoutSec * 1000 : 120_000;
      const result = await this.ctx.lifecycleService.runCommands([statusCmd], {
        cwd: monitor.path,
        env,
        timeoutMs: statusTimeoutMs,
        signal,
        onProgress: () => {},
      });

      if (result.aborted) {
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: false,
          error: "Aborted",
        });
        return { success: false, error: "Aborted" };
      }

      // Re-read monitor after await — it may have been removed during the command
      if (!this.ctx.getMonitor(worktreeId)) return { success: false, error: "Worktree removed" };
      const statusMonitor = monitorInEnvironment();
      if (!statusMonitor) {
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: result.success,
          output: result.output,
          error: result.error,
        });
        return { success: result.success, output: result.output, error: result.error };
      }

      try {
        const parsed = JSON.parse(result.output);
        const lastStatus = typeof parsed.status === "string" ? parsed.status : "unhealthy";
        statusMonitor.setResourceStatus({
          lastStatus,
          lastOutput: result.output,
          lastCheckedAt: Date.now(),
          endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
          // Arrays are typeof "object" but aren't a string-keyed record, and
          // `worktree.resource.status` now publishes this field to MCP as an
          // object — passing one through would violate the advertised schema.
          meta:
            parsed.meta != null && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
              ? parsed.meta
              : undefined,
          // Daintree acts on this one (it adds a Remote Host), so it is held to
          // the host list's own target rule and only believed of a ready box.
          ssh:
            lastStatus === "ready" && typeof parsed.ssh === "string" && isValidSshTarget(parsed.ssh)
              ? parsed.ssh
              : undefined,
        });
        // Only a reading whose commands and environment saw the same worktree vouches for its box.
        if (valuesHeld) this.statusReadings.set(worktreeId, values);
        else this.statusReadings.delete(worktreeId);
      } catch {
        // Non-JSON output: if command succeeded (exit 0), treat as "unknown" (neutral) rather
        // than "unhealthy" — the script may not emit JSON but still indicates a live resource.
        // Only mark "unhealthy" when the command itself failed (non-zero exit).
        statusMonitor.setResourceStatus({
          lastStatus: result.success ? "unknown" : "unhealthy",
          lastOutput: result.output,
          lastCheckedAt: Date.now(),
        });
      }

      // Re-substitute connect command with endpoint from status
      const statusEndpoint = statusMonitor.resourceStatus?.endpoint;
      if (statusEndpoint && resourceConfig.connect) {
        const varsWithEndpoint = this.ctx.lifecycleService.buildVariables(
          statusMonitor.path,
          projectRootPath,
          statusMonitor.name,
          statusMonitor.branch,
          statusEndpoint
        );
        statusMonitor.setResourceConnectCommand(
          this.ctx.lifecycleService.substituteVariables(resourceConfig.connect, varsWithEndpoint)
        );
      }

      if (statusEndpoint && statusMonitor.resourceStatus?.lastStatus === "ready") {
        const resolvedConnect = statusMonitor.resourceConnectCommand;
        if (resolvedConnect) {
          await generateRemoteWrapper(statusMonitor.path, resolvedConnect, statusEndpoint);
        }
      }

      if (monitorInEnvironment() === statusMonitor) {
        statusMonitor.setLifecycleStatus({
          phase: "resource-status",
          state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
          totalCommands: 1,
          output: result.output,
          error: result.error,
          startedAt: statusMonitor.lifecycleStatus?.startedAt ?? Date.now(),
          completedAt: Date.now(),
        });
        this.ctx.emitUpdate(statusMonitor);
      }

      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: result.success,
        output: result.output,
        error: result.error,
      });
      return { success: result.success, output: result.output, error: result.error };
    }

    const commands = (
      resourceConfig[effectiveAction as "provision" | "teardown" | "resume" | "pause"] as
        string[] | undefined
    )?.map(sub);
    if (!commands?.length) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: `No ${effectiveAction} commands configured`,
      });
      return { success: false, error: `No ${effectiveAction} commands configured` };
    }

    const phase = `resource-${effectiveAction}` as const;
    const configTimeoutSec =
      resourceConfig.timeouts?.[effectiveAction as keyof typeof resourceConfig.timeouts];
    const timeoutMs =
      configTimeoutSec != null
        ? configTimeoutSec * 1000
        : (DEFAULT_TIMEOUT_MS[effectiveAction] ?? 120_000);
    if (idleGuard) this.idlePauseTimeouts.set(worktreeId, timeoutMs);

    const startedAt = Date.now();
    // This run's own, so a status poll that takes the slot between commands
    // can't take what the run has printed with it.
    let liveOutput: string | undefined;
    monitor.setLifecycleStatus({
      phase,
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt,
      commandStartedAt: startedAt,
    });
    this.ctx.emitUpdate(monitor);

    const result = await this.ctx.lifecycleService.runCommands(commands, {
      cwd: monitor.path,
      env,
      timeoutMs,
      signal,
      onProgress: (commandIndex, totalCommands, command) => {
        const m = monitorInEnvironment();
        if (m) {
          m.setLifecycleStatus({
            phase,
            state: "running",
            commandIndex,
            totalCommands,
            currentCommand: command,
            startedAt,
            commandStartedAt: Date.now(),
            ...(liveOutput !== undefined ? { output: liveOutput } : {}),
          });
          this.ctx.emitUpdate(m);
        }
      },
      onOutput: (output) => {
        liveOutput = output;
        const m = monitorInEnvironment();
        if (m && publishRunningOutput(m, phase, startedAt, output)) this.ctx.emitUpdate(m);
      },
    });

    if (result.aborted) return { success: false, error: "Aborted" };

    const finalMonitor = monitorInEnvironment();
    if (finalMonitor) {
      finalMonitor.setLifecycleStatus({
        phase,
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: commands.length,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: Date.now(),
      });

      if (result.success && (effectiveAction === "resume" || effectiveAction === "pause")) {
        const prevStatus = finalMonitor.resourceStatus;
        const timestampUpdate: Partial<WorktreeResourceStatus> =
          effectiveAction === "resume"
            ? { resumedAt: Date.now() }
            : // A paused box isn't one to open: the next ready status names it again.
              { pausedAt: Date.now(), ssh: undefined };
        finalMonitor.setResourceStatus({
          ...prevStatus,
          ...timestampUpdate,
        });
      }

      // The box is gone; nothing it reported can be opened any more.
      if (
        result.success &&
        effectiveAction === "teardown" &&
        finalMonitor.resourceStatus?.ssh !== undefined
      ) {
        finalMonitor.setResourceStatus({ ...finalMonitor.resourceStatus, ssh: undefined });
      }

      this.ctx.emitUpdate(finalMonitor);
    }

    if (!result.success) {
      console.warn(
        `[WorktreeLifecycle] Resource ${action} failed for worktree ${worktreeId}:`,
        result.error
      );
    }

    this.ctx.sendEvent({
      type: "resource-action-result",
      requestId,
      success: result.success,
      output: result.output,
      error: result.error,
    });
    return { success: result.success, output: result.output, error: result.error };
  }

  private getResourceActionQueue(worktreeId: string): PQueue {
    let queue = this.resourceActionQueues.get(worktreeId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.resourceActionQueues.set(worktreeId, queue);
    }
    return queue;
  }

  private getResourceActionAbortController(worktreeId: string): AbortController {
    let controller = this.resourceActionAbortControllers.get(worktreeId);
    if (!controller) {
      controller = new AbortController();
      this.resourceActionAbortControllers.set(worktreeId, controller);
    }
    return controller;
  }

  private generationOf(worktreeId: string): number {
    return this.mutationGenerations.get(worktreeId) ?? 0;
  }

  /**
   * Whether an idle pause of this worktree may run now, asked before main
   * claims the host's idle time so a pause that would be refused spends none.
   */
  async checkIdlePause(worktreeId: string): Promise<ExecutorIdlePauseCheck> {
    const monitor = this.ctx.getMonitor(worktreeId);
    const projectRootPath = this.ctx.getProjectRootPath();
    if (this.disposed || !monitor || !projectRootPath) {
      return { ok: false, reason: "Worktree not found" };
    }
    const queue = this.resourceActionQueues.get(worktreeId);
    if (queue && (queue.pending > 0 || queue.size > 0)) {
      return { ok: false, reason: "Another resource action is queued or running" };
    }
    if (this.idlePauseHolds.has(worktreeId)) {
      return { ok: false, reason: "The worktree is being deleted" };
    }
    const generation = this.generationOf(worktreeId);
    const environmentEpoch = monitor.resourceEnvironmentEpoch;
    const { selection } = await this.ctx.lifecycleService.resolveResourceSelection(
      monitor.path,
      projectRootPath,
      undefined,
      () => monitor.worktreeMode
    );
    if (
      this.ctx.getMonitor(worktreeId) !== monitor ||
      monitor.resourceEnvironmentEpoch !== environmentEpoch
    ) {
      return { ok: false, reason: "The environment changed while it was checked" };
    }
    const check = await this.idlePauseCheck(monitor, selection, projectRootPath);
    if (!check.ok) return check;
    // Filled in as `execute` fills them, from the monitor as it is now.
    const vars = this.ctx.lifecycleService.buildVariables(
      monitor.path,
      projectRootPath,
      monitor.name,
      monitor.branch
    );
    const commandsDigest = digestPause(
      (selection!.resource.pause ?? []).map((command) =>
        this.ctx.lifecycleService.substituteVariables(command, vars)
      ),
      { path: monitor.path, name: monitor.name, branch: monitor.branch }
    );
    return {
      ok: true,
      guard: {
        selector: check.selector,
        fingerprint: check.fingerprint,
        sshTarget: check.sshTarget,
        commandsDigest,
        generation,
        environmentEpoch,
        monitorGeneration: monitor.generation,
      },
    };
  }

  /** Why an idle pause checked with `guard` may not start now, or null. */
  private admissionRefusal(
    worktreeId: string,
    monitor: WorktreeMonitor,
    guard: IdlePauseGuard,
    generation: number
  ): string | null {
    if (this.idlePauseHolds.has(worktreeId)) return "The worktree is being deleted";
    if (generation !== guard.generation) {
      return "Another resource action ran since the pause was checked";
    }
    if (
      monitor.generation !== guard.monitorGeneration ||
      monitor.resourceEnvironmentEpoch !== guard.environmentEpoch
    ) {
      return "The environment changed since the pause was checked";
    }
    return null;
  }

  /**
   * Keeps idle pauses off a worktree while a delete tears it down, which
   * runs outside the queue. Release once the delete has ended either way.
   */
  holdAgainstIdlePause(worktreeId: string): () => void {
    this.idlePauseHolds.set(worktreeId, (this.idlePauseHolds.get(worktreeId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.idlePauseHolds.get(worktreeId) ?? 1) - 1;
      if (count > 0) this.idlePauseHolds.set(worktreeId, count);
      else this.idlePauseHolds.delete(worktreeId);
    };
  }

  /**
   * Resolves once an idle pause already admitted for this worktree has ended,
   * or a margin past its own command timeout: by then its commands were
   * killed, and one that never lets go of its output must not hold a delete
   * forever.
   */
  whenIdlePauseSettled(worktreeId: string): Promise<void> {
    const running = this.idlePausesRunning.get(worktreeId);
    if (!running) return Promise.resolve();
    const maxWaitMs = Math.min(
      IDLE_PAUSE_DELETE_WAIT_CEILING_MS,
      Math.max(
        IDLE_PAUSE_DELETE_WAIT_MS,
        (this.idlePauseTimeouts.get(worktreeId) ?? 0) + IDLE_PAUSE_KILL_MARGIN_MS
      )
    );
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxWaitMs);
      void running.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async idlePauseCheck(
    monitor: WorktreeMonitor,
    selection: ResolvedResourceSelection | null,
    projectRootPath: string
  ): Promise<
    | { ok: true; selector: string; fingerprint: string; sshTarget: string }
    | { ok: false; reason: string }
  > {
    const confirmed = await this.ctx.idlePause.confirmed(selection, projectRootPath);
    if (!confirmed.ok) return confirmed;
    // Setup, or a delete's teardown, runs outside the queue but holds this slot.
    if (monitor.lifecycleStatus?.state === "running") {
      return { ok: false, reason: "Another lifecycle command is running" };
    }
    // Reported only for a ready box and dropped once one is paused or torn
    // down: the box main's host must be, or this worktree has none to pause.
    const sshTarget = monitor.resourceStatus?.ssh;
    if (!sshTarget) return { ok: false, reason: "The environment reports no ready machine" };
    const values = { path: monitor.path, name: monitor.name, branch: monitor.branch };
    if (!sameValues(this.statusReadings.get(monitor.id), values)) {
      return {
        ok: false,
        reason: "The worktree changed since its environment last reported its machine",
      };
    }
    return {
      ok: true,
      selector: selection!.selector,
      fingerprint: confirmed.fingerprint,
      sshTarget,
    };
  }

  /** Resolves once no resource action for this worktree is queued or running. */
  whenIdle(worktreeId: string): Promise<void> {
    return this.resourceActionQueues.get(worktreeId)?.onIdle() ?? Promise.resolve();
  }

  cleanupResourceActionState(worktreeId: string): void {
    this.statusReadings.delete(worktreeId);
    this.idlePauseTimeouts.delete(worktreeId);
    const controller = this.resourceActionAbortControllers.get(worktreeId);
    if (controller) {
      controller.abort();
      this.resourceActionAbortControllers.delete(worktreeId);
    }
    const queue = this.resourceActionQueues.get(worktreeId);
    if (queue) {
      queue.clear();
      this.resourceActionQueues.delete(worktreeId);
    }
  }

  async runResourceAction(
    requestId: string,
    worktreeId: string,
    action: "provision" | "teardown" | "resume" | "pause" | "status",
    environmentId?: string,
    options?: ResourceActionOptions
  ): Promise<ResourceActionResult> {
    if (this.disposed) {
      return { success: false, error: "Aborted" };
    }
    const idleGuard = options?.origin === "idle-pause" ? options.guard : undefined;

    const monitor = this.ctx.getMonitor(worktreeId);
    if (!monitor) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "Worktree not found",
      });
      return { success: false, error: "Worktree not found" };
    }

    if (!this.ctx.getProjectRootPath()) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "No project root path",
      });
      return { success: false, error: "No project root path" };
    }

    const queue = this.getResourceActionQueue(worktreeId);

    if (options?.origin === "auto-poll" && (queue.pending > 0 || queue.size > 0)) {
      return { success: true };
    }
    // Never queued behind another action, and never one queued behind it:
    // the claim it acts on is the host's decision at one moment, not later.
    if (idleGuard) {
      const refusal =
        action !== "pause"
          ? "Only a pause runs on an idle claim"
          : queue.pending > 0 || queue.size > 0
            ? "Another resource action is queued or running"
            : this.admissionRefusal(worktreeId, monitor, idleGuard, this.generationOf(worktreeId));
      if (refusal !== null) return { success: false, error: refusal, skipped: true };
    }

    const controller = this.getResourceActionAbortController(worktreeId);
    // Taken at request time: an action queued for one environment must not run
    // against another the worktree switched to while it waited.
    const environmentEpoch = monitor.resourceEnvironmentEpoch;

    // An abort settles the queue's promise before the commands have exited.
    let executing: Promise<unknown> | undefined;
    const run = queue
      .add(
        () =>
          (executing = this.execute(
            requestId,
            worktreeId,
            action,
            environmentId,
            environmentEpoch,
            controller.signal,
            idleGuard
          )),
        { signal: controller.signal }
      )
      .catch(() => undefined);
    if (idleGuard) {
      const ended = run.then(() => executing?.catch(() => undefined));
      this.idlePausesRunning.set(worktreeId, ended);
      void ended.finally(() => {
        if (this.idlePausesRunning.get(worktreeId) === ended) {
          this.idlePausesRunning.delete(worktreeId);
          this.idlePauseTimeouts.delete(worktreeId);
        }
      });
    }
    const queued = await run;

    return queued ?? { success: false, error: "Aborted" };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const keys = new Set([
      ...this.resourceActionAbortControllers.keys(),
      ...this.resourceActionQueues.keys(),
    ]);
    for (const key of keys) {
      this.cleanupResourceActionState(key);
    }
  }
}

/**
 * Drop a `daintree-remote` shell wrapper into the worktree's `.daintree/`
 * directory. The wrapper forwards arguments to the resolved connect command,
 * giving agents a stable invocation path that survives endpoint changes.
 */
async function generateRemoteWrapper(
  worktreePath: string,
  connectCommand: string,
  endpoint: string
): Promise<void> {
  try {
    const wrapperPath = pathJoin(worktreePath, ".daintree", "daintree-remote");
    await mkdir(pathJoin(worktreePath, ".daintree"), { recursive: true });

    // The endpoint comes from a status command's output, so it is JSON-encoded:
    // a newline in it would otherwise end the comment and run as its own line.
    const scriptContent = `#!/usr/bin/env bash
# Auto-generated by Daintree - wraps remote compute access
# Endpoint: ${JSON.stringify(endpoint)}
set -euo pipefail
if [ $# -eq 0 ]; then
  echo "Usage: daintree-remote <command>" >&2
  exit 1
fi
${connectCommand} "$@"
`;

    await writeFile(wrapperPath, scriptContent, { mode: 0o755 });
  } catch (error) {
    const msg = formatErrorMessage(error, "Failed to generate daintree-remote wrapper");
    console.warn("[WorkspaceService] Failed to generate daintree-remote wrapper:", msg);
  }
}
