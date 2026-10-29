import type {
  LifecycleCommandReview,
  WorktreeSetupPluginStep,
  WorktreeSetupStage,
  WorktreeSetupStatus,
} from "../../shared/types/worktree.js";
import type {
  WorktreeSetupStepDescriptor,
  WorktreeSetupStepRunOutcome,
} from "../../shared/types/workspace-host.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { getWorktreeSetupBridge } from "./worktreeSetupBridge.js";
import { fingerprintPluginSetupStep } from "./lifecycleCommandTrust.js";
import {
  LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
  type WorktreeLifecycleService,
  type WorkspaceHostContext,
} from "./WorktreeLifecycleService.js";
import type { WorktreeMonitor } from "./WorktreeMonitor.js";

/**
 * What {@link WorktreeSetupCoordinator.runLifecycleSetup} learned, as a value rather
 * than as mutable state a later phase can overwrite.
 */
export type LifecycleSetupOutcome =
  | { ok: true }
  | { ok: false; timedOut: boolean; error: string; stage?: WorktreeSetupStage }
  // The repository's commands, or a plugin's setup steps, have not been
  // approved, so they did not run. Only the user can change that, from the
  // worktree card.
  | { ok: false; needsApproval: true; stage?: WorktreeSetupStage };

/** What {@link WorktreeSetupCoordinator.runPluginSetupSteps} learned, and the record it kept. */
export interface PluginSetupOutcome {
  outcome: LifecycleSetupOutcome;
  pluginSteps?: WorktreeSetupPluginStep[];
}

function pluginStepKey(step: { pluginId: string; stepId: string }): string {
  return `${step.pluginId}\0${step.stepId}`;
}

/**
 * One line naming each plugin step that did not succeed, by plugin — the card
 * shows it as the setup error, so it has to say whose step it was.
 */
function describePluginStepFailures(steps: readonly WorktreeSetupPluginStep[]): string {
  const [first, ...rest] = steps.map((step) => {
    const name = `${step.pluginName} "${step.label}"`;
    if (step.state === "skipped") return `${name} was skipped: ${step.error ?? "not run"}`;
    if (step.state === "timed-out") return `${name} ${step.error ?? "timed out"}`;
    return `${name} failed: ${step.error ?? "unknown error"}`;
  });
  return rest.length > 0 ? `${first} (and ${rest.length} more)` : first;
}

/** What a setup that stopped for approval was asked to do, so approving can finish it. */
interface SetupAwaitingApproval {
  provisionResource: boolean;
  environmentId?: string;
}

/** The setup status a finished setup run settles on. */
export function setupStatusForOutcome(
  outcome: LifecycleSetupOutcome,
  startedAt: number,
  completedAt: number,
  pluginSteps?: WorktreeSetupPluginStep[]
): WorktreeSetupStatus {
  const steps = pluginSteps ? { pluginSteps } : {};
  if (outcome.ok) return { state: "ready", startedAt, completedAt, ...steps };
  const stage = outcome.stage ?? "setup-script";
  if ("needsApproval" in outcome) {
    return { state: "needs-approval", stage, startedAt, completedAt, ...steps };
  }
  return {
    state: outcome.timedOut ? "timed-out" : "failed",
    stage,
    startedAt,
    completedAt,
    error: outcome.error,
    ...steps,
  };
}

/**
 * What the coordinator reads from and asks of WorkspaceService, which keeps the
 * canonical monitor map, the project context and resource execution. Every
 * member is read live: the project and the monitors change underneath a setup.
 */
export interface WorktreeSetupCoordinatorHost {
  readonly lifecycleService: WorktreeLifecycleService;
  getProjectRootPath(): string | null;
  getProjectEnvVars(): Record<string, string>;
  getMonitor(worktreeId: string): WorktreeMonitor | undefined;
  getMonitors(): Iterable<WorktreeMonitor>;
  getLifecycleContext(): WorkspaceHostContext | null;
  emitUpdate(monitor: WorktreeMonitor): void;
  runResourceAction(
    requestId: string,
    worktreeId: string,
    action: "provision"
  ): Promise<{ success: boolean; error?: string }>;
  whenResourceActionsIdle(worktreeId: string): Promise<void>;
  initResourceConfig(monitor: WorktreeMonitor, worktreePath: string): Promise<void>;
}

/**
 * Owns worktree setup after git has created the worktree: the setup script and
 * auto-provision outcome, the project's plugin setup steps, retries, and the
 * approval that resumes a setup held for it. State is keyed by monitor, so it
 * belongs to one incarnation of a worktree path.
 */
export class WorktreeSetupCoordinator {
  // Keyed by monitor, not id, so a setup intent dies with the incarnation it
  // was recorded for: delete-then-recreate at the same path must not inherit it.
  private setupAwaitingApproval = new WeakMap<WorktreeMonitor, SetupAwaitingApproval>();
  // Monitors whose approved setup is already being resumed, so a second
  // approval arriving meanwhile does not run it again once the first settles.
  private resumingApprovedSetup = new WeakSet<WorktreeMonitor>();
  // The plugin setup steps main last listed for this project (#13807), so a
  // card's approval flag can count them without a round trip per worktree.
  private pluginSetupSteps: WorktreeSetupStepDescriptor[] = [];
  // Plugin setup steps in flight, by the incarnation they run for, so removing
  // the worktree cancels the step instead of letting it run on unobserved.
  private pluginSetupRuns = new Map<WorktreeMonitor, AbortController>();
  // Which plugin step declarations succeeded for an incarnation, so a resumed
  // setup skips them only while the declaration is the one that succeeded.
  private pluginStepSuccesses = new WeakMap<WorktreeMonitor, Set<string>>();

  constructor(private readonly host: WorktreeSetupCoordinatorHost) {}

  /** A different project lists different plugin steps. */
  forgetPluginSetupSteps(): void {
    this.pluginSetupSteps = [];
  }

  /** Cancel every plugin setup step in flight; the host is going away. */
  dispose(): void {
    for (const controller of this.pluginSetupRuns.values()) controller.abort();
    this.pluginSetupRuns.clear();
  }

  /**
   * Write a setup status onto a worktree's monitor and emit it.
   *
   * Silently does nothing when the monitor is gone — the create tail runs after
   * the result has been returned, so the worktree can be deleted mid-tail and
   * that is not an error.
   *
   * `expectedGeneration` guards the case that IS an error. Worktree ids are
   * paths, and delete-then-recreate at the same path is a supported workflow,
   * so an id alone does not identify an incarnation. Without the check, a tail
   * still running for a deleted worktree would stamp its `running`, `failed` or
   * `ready` onto the fresh monitor that replaced it — reporting the old
   * worktree's setup outcome as the new one's. `generation` exists to tell the
   * two apart.
   */
  setWorktreeSetupStatus(
    worktreeId: string,
    status: WorktreeSetupStatus,
    expectedGeneration?: number
  ): void {
    const monitor = this.host.getMonitor(worktreeId);
    if (!monitor) return;
    if (expectedGeneration !== undefined && monitor.generation !== expectedGeneration) return;
    monitor.setSetupStatus(status);
    this.host.emitUpdate(monitor);
  }

  /**
   * Run the setup script and, when configured, the auto-provision that follows
   * it, and REPORT the outcome.
   *
   * The verdict is composed from what each step returns, never from reading
   * `lifecycleStatus` back afterwards. That read is unsound as a completion
   * signal in two ways this method exists to avoid: the field is one generic
   * slot that a later phase overwrites (auto-provision writes
   * `phase: "resource-provision"` over the setup result), and it is never
   * written at all when the project declares no setup commands. Inferring
   * "ready" from it therefore reported success both for a provision that failed
   * and for a setup that never ran.
   *
   * Neither failure throws — a non-zero setup script and a failed provision both
   * RESOLVE — so a caller that only catches learns nothing.
   */
  async runLifecycleSetup(
    worktreeId: string,
    worktreePath: string,
    projectRootPath: string,
    provisionResource?: boolean,
    environmentId?: string
  ): Promise<LifecycleSetupOutcome> {
    const hostCtx: WorkspaceHostContext = this.host.getLifecycleContext() ?? {
      projectRootPath,
      projectEnvVars: this.host.getProjectEnvVars(),
      getMonitor: (id) => this.host.getMonitor(id),
      emitUpdate: (m) => this.host.emitUpdate(m),
    };

    // Ids are paths, so the monitor is pinned before the first await: only the
    // incarnation this run started against may record or clear what it was
    // asked to do. The same goes for its resource environment: once the
    // worktree switches, a run started for the old one publishes nothing, or
    // it would put back the config the switch just cleared (#15005).
    const monitorAtStart = this.host.getMonitor(worktreeId);
    const environmentEpoch = monitorAtStart?.resourceEnvironmentEpoch;
    const environmentChanged = (): boolean => {
      const live = this.host.getMonitor(worktreeId);
      return (
        live !== undefined &&
        environmentEpoch !== undefined &&
        live.resourceEnvironmentEpoch !== environmentEpoch
      );
    };
    const ctx: WorkspaceHostContext = {
      ...hostCtx,
      getMonitor: (id) => {
        const live = hostCtx.getMonitor(id);
        return id === worktreeId && environmentChanged() ? undefined : live;
      },
    };
    const recordAwaitingApproval = (awaiting: boolean): void => {
      const live = this.host.getMonitor(worktreeId);
      if (!live || live !== monitorAtStart || environmentChanged()) return;
      if (!awaiting) {
        this.setupAwaitingApproval.delete(live);
        return;
      }
      this.setupAwaitingApproval.set(live, {
        provisionResource: provisionResource ?? false,
        ...(environmentId !== undefined ? { environmentId } : {}),
      });
    };

    const { shouldProvision, needsApproval } = await this.host.lifecycleService.runLifecycleSetup(
      worktreeId,
      worktreePath,
      ctx,
      provisionResource,
      environmentId
    );

    if (needsApproval) {
      recordAwaitingApproval(true);
      return { ok: false, needsApproval: true };
    }

    // Read immediately, before auto-provision can overwrite the slot.
    const settled = this.host.getMonitor(worktreeId)?.lifecycleStatus;
    if (settled?.phase === "setup" && settled.state !== "success") {
      if (settled.state === "failed" || settled.state === "timed-out") {
        recordAwaitingApproval(false);
        return {
          ok: false,
          timedOut: settled.state === "timed-out",
          error: settled.error ?? "Setup script failed",
        };
      }
    }

    if (shouldProvision && !environmentChanged() && this.host.getProjectRootPath()) {
      const provision = await this.host.runResourceAction(
        `auto-provision-${worktreeId}`,
        worktreeId,
        "provision"
      );
      if (!provision.success) {
        // Provisioning re-checks approval against the config as it is now, so
        // commands that changed after setup read them are waiting for approval
        // rather than failed — and approving them should finish the job.
        if (provision.error === LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR) {
          recordAwaitingApproval(true);
          return { ok: false, needsApproval: true };
        }
        recordAwaitingApproval(false);
        return {
          ok: false,
          timedOut: false,
          error: provision.error ?? "Resource provisioning failed",
        };
      }
    }

    recordAwaitingApproval(false);
    return { ok: true };
  }

  /**
   * The plugin setup steps main lists for this project, remembered for the
   * approval flag. Rejects when main does not answer: an unanswered list is
   * not an empty one.
   */
  private async listPluginSetupSteps(): Promise<WorktreeSetupStepDescriptor[]> {
    const bridge = getWorktreeSetupBridge();
    if (!bridge) return [];
    const projectRootPath = this.host.getProjectRootPath();
    const steps = await bridge.listSteps();
    if (this.host.getProjectRootPath() === projectRootPath) this.pluginSetupSteps = steps;
    return steps;
  }

  /**
   * The plugin steps a review covers: every one the project declares that the
   * user has not allowed, listed fresh. The same set whether the review is
   * being shown or approved, whatever the worktree's setup does in between, so
   * the fingerprint a dialog showed is the one its approval is checked against.
   */
  private async pluginStepsForReview(): Promise<WorktreeSetupStepDescriptor[]> {
    try {
      return await this.listPluginSetupSteps();
    } catch (err) {
      console.warn("[WorkspaceService] Couldn't list plugin setup steps:", err);
      return this.pluginSetupSteps;
    }
  }

  /**
   * The plugin steps a card's approval flag counts: the last listed, and only
   * while that worktree's setup is waiting for approval. Plugin steps run only
   * when a worktree is set up, so a card with nothing waiting has nothing of
   * theirs to ask about.
   */
  private pluginStepsForFlag(monitor: WorktreeMonitor): WorktreeSetupStepDescriptor[] {
    return monitor.setupStatus?.state === "needs-approval" ? this.pluginSetupSteps : [];
  }

  /** Cancel the plugin setup steps running for this incarnation, if any. */
  cancelPluginSetup(monitor: WorktreeMonitor): void {
    this.pluginSetupRuns.get(monitor)?.abort();
    this.pluginSetupRuns.delete(monitor);
  }

  /**
   * A setup that stopped for approval of plugin steps leaves the card a review
   * to offer, which only the approval flag tells it about.
   */
  async refreshApprovalAfterPluginSteps(
    monitor: WorktreeMonitor,
    outcome: LifecycleSetupOutcome
  ): Promise<void> {
    if (outcome.ok || !("needsApproval" in outcome) || outcome.stage !== "plugin-steps") return;
    if (this.host.getMonitor(monitor.id) !== monitor) return;
    await this.refreshLifecycleCommandApproval(monitor).catch((err) => {
      console.warn("[WorkspaceHost] Command approval check failed:", err);
    });
  }

  /**
   * Run the project's plugin setup steps (#13807) for one worktree incarnation
   * and REPORT the outcome, like {@link runLifecycleSetup}. Called only once the
   * setup script succeeded.
   *
   * Steps run one at a time, in the order main lists them. Each one's failure
   * is recorded and passed over rather than ending the run — one plugin must
   * not hold another's setup hostage — and the verdict waits for all of them.
   * A step the user has not allowed for the project does not run, and is what
   * the verdict asks approval for; approval is read at each step, so one that
   * lands while earlier steps run counts.
   *
   * `previous` is the record a retry resumes from. A step that succeeded is not
   * run again while its declaration is the one that succeeded, and a step the
   * record expected whose plugin is no longer there to run it is recorded as
   * skipped rather than forgotten.
   *
   * Progress is written to `lifecycleStatus` as well as `setupStatus`: it is
   * where the worktree card reads what setup is doing, its error and its retry
   * guard, and the plugin steps are part of setup.
   */
  async runPluginSetupSteps(
    monitor: WorktreeMonitor,
    startedAt: number,
    previous?: readonly WorktreeSetupPluginStep[]
  ): Promise<PluginSetupOutcome> {
    const bridge = getWorktreeSetupBridge();
    const projectRootPath = this.host.getProjectRootPath();
    if (!bridge || !projectRootPath) return { outcome: { ok: true } };
    const isLive = (): boolean => this.host.getMonitor(monitor.id) === monitor;
    const cancelledOutcome: LifecycleSetupOutcome = {
      ok: false,
      timedOut: false,
      stage: "plugin-steps",
      error: "Setup was cancelled",
    };
    if (!isLive()) return { outcome: cancelledOutcome };

    // Registered before the first await, so a delete that starts while the
    // steps are still being listed cancels them too.
    const controller = new AbortController();
    this.pluginSetupRuns.set(monitor, controller);
    const cancelled = (): boolean => controller.signal.aborted || !isLive();
    if (!previous) this.pluginStepSuccesses.delete(monitor);
    const successes = this.pluginStepSuccesses.get(monitor) ?? new Set<string>();
    this.pluginStepSuccesses.set(monitor, successes);

    let steps: WorktreeSetupPluginStep[] = [];
    let ranAny = false;
    const publish = (): void => {
      if (!isLive()) return;
      monitor.setSetupStatus({
        state: "running",
        stage: "plugin-steps",
        startedAt,
        pluginSteps: steps,
      });
      this.host.emitUpdate(monitor);
    };

    const run = async (): Promise<LifecycleSetupOutcome> => {
      let declared: WorktreeSetupStepDescriptor[];
      try {
        declared = await this.listPluginSetupSteps();
      } catch (err) {
        return {
          ok: false,
          timedOut: false,
          stage: "plugin-steps",
          error: `Couldn't read the plugin setup steps: ${formatErrorMessage(err, "no answer")}`,
        };
      }
      if (cancelled()) return cancelledOutcome;

      const listed = new Set(declared.map(pluginStepKey));
      steps = [
        ...declared.map((step): WorktreeSetupPluginStep => ({
          pluginId: step.pluginId,
          pluginName: step.pluginName,
          stepId: step.stepId,
          label: step.label,
          state: successes.has(fingerprintPluginSetupStep(step)) ? "succeeded" : "pending",
        })),
        ...(previous ?? [])
          .filter((step) => !listed.has(pluginStepKey(step)))
          .map((step): WorktreeSetupPluginStep =>
            step.state === "succeeded"
              ? step
              : { ...step, state: "skipped", error: "the plugin isn't loaded for this project" }
          ),
      ];
      if (steps.length === 0) return { ok: true };
      publish();

      const target = {
        worktreeId: monitor.id,
        worktreePath: monitor.path,
        branch: monitor.branch ?? null,
      };
      // Passes repeat while an approval lands for a step already passed over:
      // the approval's own resume can't start while this run holds setup, so
      // this run is what has to pick it up. Each pass settles at least one
      // step for good, which bounds them.
      for (let pass = 0; pass <= declared.length; pass++) {
        for (const [index, step] of declared.entries()) {
          if (steps[index].state !== "pending") continue;
          const unapproved =
            (await this.host.lifecycleService.pendingPluginSteps([step], projectRootPath)).length >
            0;
          if (cancelled()) return cancelledOutcome;
          if (unapproved) {
            steps[index] = { ...steps[index], state: "needs-approval" };
            publish();
            continue;
          }
          ranAny = true;
          steps[index] = { ...steps[index], state: "running" };
          monitor.setLifecycleStatus({
            phase: "setup",
            state: "running",
            currentCommand: `${step.label} (${step.pluginName})`,
            startedAt: Date.now(),
          });
          publish();
          let result: WorktreeSetupStepRunOutcome;
          try {
            result = await bridge.runStep(step, target, controller.signal);
          } catch (err) {
            if (cancelled()) return cancelledOutcome;
            result = { state: "failed", error: formatErrorMessage(err, "no answer") };
          }
          if (cancelled()) return cancelledOutcome;
          if (result.state === "succeeded") {
            successes.add(fingerprintPluginSetupStep(step));
            steps[index] = { ...steps[index], state: "succeeded" };
          } else {
            steps[index] = { ...steps[index], state: result.state, error: result.error };
          }
          publish();
        }

        const waiting = declared.filter((_, index) => steps[index].state === "needs-approval");
        if (waiting.length === 0) break;
        const stillWaiting = new Set(
          (await this.host.lifecycleService.pendingPluginSteps(waiting, projectRootPath)).map(
            pluginStepKey
          )
        );
        if (cancelled()) return cancelledOutcome;
        let reopened = false;
        for (const [index, step] of declared.entries()) {
          if (steps[index].state !== "needs-approval" || stillWaiting.has(pluginStepKey(step))) {
            continue;
          }
          steps[index] = { ...steps[index], state: "pending" };
          reopened = true;
        }
        if (!reopened) break;
      }
      // Reopened on the last pass the bound allows: still waiting, as far as
      // this run got to see.
      steps = steps.map((step) =>
        step.state === "pending" ? { ...step, state: "needs-approval" } : step
      );

      const unfinished = steps.filter((step) => step.state !== "succeeded");
      if (unfinished.length === 0) return { ok: true };
      if (unfinished.some((step) => step.state === "needs-approval")) {
        return { ok: false, needsApproval: true, stage: "plugin-steps" };
      }
      return {
        ok: false,
        timedOut: unfinished[0].state === "timed-out",
        stage: "plugin-steps",
        error: describePluginStepFailures(unfinished),
      };
    };

    let outcome: LifecycleSetupOutcome;
    try {
      outcome = await run();
    } catch (err) {
      outcome = {
        ok: false,
        timedOut: false,
        stage: "plugin-steps",
        error: formatErrorMessage(err, "Plugin setup steps failed"),
      };
    } finally {
      if (this.pluginSetupRuns.get(monitor) === controller) this.pluginSetupRuns.delete(monitor);
    }
    // A cancel that lands after the steps settled still wins: the worktree is
    // going, and nothing should be left waiting to resume it.
    const wasCancelled = controller.signal.aborted || outcome === cancelledOutcome;
    if (wasCancelled) {
      outcome = cancelledOutcome;
      steps = steps.map((step) =>
        step.state === "running"
          ? { ...step, state: "failed", error: "setup was cancelled" }
          : step.state === "pending"
            ? { ...step, state: "skipped", error: "setup was cancelled" }
            : step
      );
    }
    if (!isLive()) return { outcome, ...(steps.length > 0 ? { pluginSteps: steps } : {}) };

    // Approving resumes here, through the same path as unapproved commands.
    if (!outcome.ok && "needsApproval" in outcome) {
      this.setupAwaitingApproval.set(monitor, { provisionResource: false });
    } else {
      this.setupAwaitingApproval.delete(monitor);
    }

    // Settle the slot the card reads. Always when this run left it running —
    // a slot left running wedges every later retry — and otherwise only when
    // there is something to report and no other lifecycle phase holds it.
    const slot = monitor.lifecycleStatus;
    const ownsSlot = slot?.phase === "setup" && slot.state === "running";
    const reports = !wasCancelled && (!outcome.ok || ranAny);
    if (ownsSlot || (slot?.state !== "running" && reports)) {
      monitor.setLifecycleStatus({
        phase: "setup",
        state: outcome.ok
          ? "success"
          : "needsApproval" in outcome
            ? "needs-approval"
            : outcome.timedOut
              ? "timed-out"
              : "failed",
        startedAt,
        completedAt: Date.now(),
        ...(!outcome.ok && "error" in outcome ? { error: outcome.error } : {}),
      });
      this.host.emitUpdate(monitor);
    }
    return { outcome, ...(steps.length > 0 ? { pluginSteps: steps } : {}) };
  }

  /**
   * Re-run the lifecycle setup script for an existing worktree without
   * recreating it. Surfaced via the `run-lifecycle-setup` port action so the
   * worktree card can offer a "Retry setup" affordance after a failed/timed-out
   * setup. Same idempotence assumption as resource provisioning — the user
   * authors setup scripts knowing they may be re-run in place.
   *
   * A setup that got as far as its plugin steps resumes there: the script
   * already succeeded, and only the plugin steps that did not are run again.
   */
  async retryLifecycleSetup(worktreeId: string): Promise<void> {
    const monitor = this.host.getMonitor(worktreeId);
    if (!monitor) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    const projectRootPath = this.host.getProjectRootPath();
    if (!projectRootPath) {
      throw new Error("Cannot retry setup before a project is loaded");
    }
    if (monitor.lifecycleStatus?.state === "running" || monitor.setupStatus?.state === "running") {
      throw new Error("Setup is already running");
    }
    const previous = monitor.setupStatus;
    const resumePluginSteps =
      previous?.stage === "plugin-steps" &&
      (previous.state === "failed" ||
        previous.state === "timed-out" ||
        previous.state === "needs-approval");

    // Set running synchronously *before* the first await so a second concurrent
    // request (rapid clicks, multi-window, retry-after-error) sees the in-flight
    // state and is rejected by the guard above. `runLifecycleSetup` re-sets the
    // same state with full command-progress metadata once config loads.
    const startedAt = Date.now();
    monitor.setLifecycleStatus({
      phase: "setup",
      state: "running",
      startedAt,
    });
    // Kept in lockstep with the create tail's own transitions: a retry that
    // left `setupStatus` reading `failed` while the script was demonstrably
    // running again would make the readiness contract a lie the moment anyone
    // used the retry affordance.
    monitor.setSetupStatus(
      resumePluginSteps
        ? {
            state: "running",
            stage: "plugin-steps",
            startedAt,
            ...(previous.pluginSteps ? { pluginSteps: previous.pluginSteps } : {}),
          }
        : { state: "running", stage: "setup-script", startedAt }
    );
    this.host.emitUpdate(monitor);

    // A setup that stopped for approval resumes with what it was originally
    // asked to do; a plain retry never provisions.
    const intent = this.setupAwaitingApproval.get(monitor);
    let outcome: LifecycleSetupOutcome;
    let pluginSteps: WorktreeSetupPluginStep[] | undefined;
    try {
      const setup: LifecycleSetupOutcome = resumePluginSteps
        ? { ok: true }
        : await this.runLifecycleSetup(
            worktreeId,
            monitor.path,
            projectRootPath,
            intent?.provisionResource ?? false,
            intent?.environmentId
          );
      ({ outcome, pluginSteps } = setup.ok
        ? await this.runPluginSetupSteps(
            monitor,
            startedAt,
            resumePluginSteps ? (previous.pluginSteps ?? []) : undefined
          )
        : { outcome: setup });
    } catch (err) {
      const message = formatErrorMessage(err, "Setup retry failed");
      // BOTH statuses have to settle here. `runLifecycleSetup` writes the
      // terminal `lifecycleStatus` itself on the paths it completes, but a
      // throw skips that — and the guard above rejects a retry while
      // `lifecycleStatus.state === "running"`, so leaving it running would make
      // the FIRST failed retry the last one this worktree ever accepts.
      // Only this retry's incarnation: a replacement at the same path is not
      // the worktree that failed.
      if (this.host.getMonitor(worktreeId) === monitor) {
        monitor.setLifecycleStatus({
          phase: "setup",
          state: "failed",
          startedAt,
          completedAt: Date.now(),
          error: message,
        });
      }
      this.setWorktreeSetupStatus(
        worktreeId,
        {
          state: "failed",
          stage: monitor.setupStatus?.stage ?? "setup-script",
          startedAt,
          completedAt: Date.now(),
          error: message,
        },
        monitor.generation
      );
      throw err;
    }

    // Settle `lifecycleStatus` when the run left it running.
    //
    // The guard at the top of this method rejects a retry while that field
    // reads `running`, and `lifecycleService.runLifecycleSetup` returns early
    // WITHOUT writing any status when the project declares no setup commands —
    // so the `running` stamped above was never replaced, and the first retry on
    // such a project was the last one it would ever accept. The status is
    // written here rather than by removing the pre-set, because the pre-set is
    // what makes the guard reject a concurrent second request.
    const live = this.host.getMonitor(worktreeId) === monitor ? monitor : undefined;
    if (live?.lifecycleStatus?.phase === "setup" && live.lifecycleStatus.state === "running") {
      const settledState = outcome.ok
        ? "success"
        : "needsApproval" in outcome
          ? "needs-approval"
          : outcome.timedOut
            ? "timed-out"
            : "failed";
      live.setLifecycleStatus({
        ...live.lifecycleStatus,
        state: settledState,
        completedAt: Date.now(),
        ...(!outcome.ok && "error" in outcome ? { error: outcome.error } : {}),
      });
      this.host.emitUpdate(live);
    }

    this.setWorktreeSetupStatus(
      worktreeId,
      setupStatusForOutcome(outcome, startedAt, Date.now(), pluginSteps),
      monitor.generation
    );
    await this.refreshApprovalAfterPluginSteps(monitor, outcome);
  }

  /**
   * The repository commands this worktree would run that still need the
   * user's approval, or `null`. Also brings the worktree's approval flag up to
   * date, since whoever asks is about to act on the answer.
   *
   * Reached only through the worktree port from the renderer's review dialog.
   * Deliberately not an action: approval is the user's decision, and nothing
   * on the action surface — which is also the MCP tool surface — can grant it.
   */
  async getLifecycleCommandReview(worktreeId: string): Promise<LifecycleCommandReview | null> {
    const monitor = this.host.getMonitor(worktreeId);
    if (!monitor) throw new Error(`Worktree not found: ${worktreeId}`);
    const projectRootPath = this.host.getProjectRootPath();
    if (!projectRootPath) throw new Error("Cannot review commands before a project is loaded");
    const review = await this.host.lifecycleService.getCommandReview(
      monitor.path,
      projectRootPath,
      await this.pluginStepsForReview()
    );
    // The flag counts plugin steps only while this worktree's setup waits on
    // them, as `refreshLifecycleCommandApproval` does.
    this.applyCommandApprovalFlag(
      monitor,
      projectRootPath,
      review !== null &&
        (review.sources.length > 0 || monitor.setupStatus?.state === "needs-approval")
    );
    // What approving sets running straight away is part of what is approved.
    const intent = this.setupAwaitingApproval.get(monitor);
    if (review && intent?.provisionResource) {
      const label = await this.host.lifecycleService.setupProvisionLabel(
        monitor.path,
        projectRootPath,
        intent.environmentId,
        monitor.worktreeMode
      );
      if (label) return { ...review, provisionAfterSetup: label };
    }
    return review;
  }

  /**
   * Approve the commands a review showed, identified by its fingerprint.
   *
   * Approval is by content, so every worktree in the project that carries the
   * same commands is cleared by it: their flags and published connect commands
   * are refreshed. A setup this worktree skipped for approval is then resumed —
   * that is what the user just approved it for. Other worktrees' skipped setups
   * are left for their own cards.
   */
  async approveLifecycleCommands(worktreeId: string, fingerprint: string): Promise<void> {
    const monitor = this.host.getMonitor(worktreeId);
    if (!monitor) throw new Error(`Worktree not found: ${worktreeId}`);
    const projectRootPath = this.host.getProjectRootPath();
    if (!projectRootPath) throw new Error("Cannot approve commands before a project is loaded");

    await this.host.lifecycleService.approveCommandReview(
      monitor.path,
      projectRootPath,
      fingerprint,
      await this.pluginStepsForReview()
    );

    await Promise.all(
      [...this.host.getMonitors()].map(async (m) => {
        try {
          // Only a monitor that was (or may have been) waiting, or that has no
          // connect command published, can have had one withheld. Re-deriving
          // an approved sibling's would drop the endpoint its last status check
          // substituted in.
          if (m.lifecycleCommandsNeedApproval !== false || m.resourceConnectCommand === undefined) {
            await this.host.initResourceConfig(m, m.path);
          }
          await this.refreshLifecycleCommandApproval(m);
        } catch (err) {
          console.warn("[WorkspaceService] Failed to refresh command approval:", err);
        }
      })
    );

    const live = this.host.getMonitor(worktreeId);
    if (
      live === monitor &&
      this.setupAwaitingApproval.has(live) &&
      !this.resumingApprovedSetup.has(live)
    ) {
      this.resumingApprovedSetup.add(live);
      void (async () => {
        // A resource action in flight — an automatic status check, say — holds
        // the lifecycle slot, and a retry started under it would be refused as
        // "already running", losing the setup the user just approved.
        await this.host.whenResourceActionsIdle(worktreeId);
        if (this.host.getMonitor(worktreeId) !== monitor) return;
        if (!this.setupAwaitingApproval.has(monitor)) return;
        await this.retryLifecycleSetup(worktreeId);
      })()
        .catch((err) => {
          console.warn("[WorkspaceService] Setup after approval failed to start:", err);
        })
        .finally(() => {
          this.resumingApprovedSetup.delete(monitor);
        });
    }
  }

  /** Re-derive a worktree's "commands need approval" flag from disk. */
  async refreshLifecycleCommandApproval(monitor: WorktreeMonitor): Promise<void> {
    const projectRootPath = this.host.getProjectRootPath();
    if (!projectRootPath) return;
    const review = await this.host.lifecycleService.getCommandReview(
      monitor.path,
      projectRootPath,
      this.pluginStepsForFlag(monitor)
    );
    this.applyCommandApprovalFlag(monitor, projectRootPath, review !== null);
  }

  private applyCommandApprovalFlag(
    monitor: WorktreeMonitor,
    projectRootPath: string,
    needsApproval: boolean
  ): void {
    // The answer was read for this incarnation in this project; a monitor that
    // has since been replaced, or a project that has since switched, gets none.
    if (
      this.host.getMonitor(monitor.id) !== monitor ||
      this.host.getProjectRootPath() !== projectRootPath
    ) {
      return;
    }
    if (monitor.lifecycleCommandsNeedApproval === needsApproval) return;
    monitor.setLifecycleCommandsNeedApproval(needsApproval);
    if (monitor.isRunning && monitor.hasInitialStatus) {
      this.host.emitUpdate(monitor);
    }
  }
}
