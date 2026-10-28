import type {
  WorkspaceHostRequest,
  WorktreeSetupStepDescriptor,
  WorktreeSetupStepRunOutcome,
  WorktreeSetupStepTarget,
} from "../../shared/types/workspace-host.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  getWorktreeSetupStepHandler,
  getWorktreeSetupSteps,
  type RegisteredWorktreeSetupStep,
} from "./worktreeSetupStepRegistry.js";

type Sender = (request: WorkspaceHostRequest) => boolean;

export interface WorktreeSetupRpcDeps {
  /** The project id of the host's project root, or `null` when none is recorded. */
  resolveProjectId(projectPath: string): Promise<string | null>;
  /**
   * Settles once the startup plugin scan has, and the project's own plugins
   * have loaded or stopped being waited for, so a list is never a cold-start
   * blank.
   */
  whenPluginsLoaded(projectId: string | null): Promise<void>;
  /** Never rejects: a failed activation is read back with `isPluginActivated`. */
  activatePlugin(pluginId: string): Promise<void>;
  isPluginActivated(pluginId: string): boolean;
  /** The steps whose plugin a view of `projectId` would see. */
  filterForProject(
    steps: RegisteredWorktreeSetupStep[],
    projectId: string | null
  ): Promise<RegisteredWorktreeSetupStep[]>;
}

const PROJECT_PLUGINS_WAIT_MS = 10_000;

// Loaded lazily so importing this module from `WorkspaceHostProcess` does not
// construct the PluginService and ProjectStore singletons at module load.
let loadedPluginService: { isPluginActivated(pluginId: string): boolean } | null = null;
const defaultDeps: WorktreeSetupRpcDeps = {
  async resolveProjectId(projectPath) {
    const { projectStore } = await import("./ProjectStore.js");
    return (await projectStore.getProjectByPath(projectPath))?.id ?? null;
  },
  async whenPluginsLoaded(projectId) {
    const { pluginService } = await import("./PluginService.js");
    await pluginService.waitForCatalog();
    // Project plugins load on their own queue from the project switch. A
    // timeout goes ahead with what has loaded, as a terminal launch does.
    if (projectId !== null) {
      const settled = await pluginService.waitForProjectPlugins(projectId, PROJECT_PLUGINS_WAIT_MS);
      if (!settled) {
        console.warn(
          `[WorktreeSetup] Project plugins not settled after ${PROJECT_PLUGINS_WAIT_MS}ms; listing the setup steps loaded so far`
        );
      }
    }
  },
  async activatePlugin(pluginId) {
    const { pluginService } = await import("./PluginService.js");
    loadedPluginService = pluginService;
    await pluginService.activatePlugin(pluginId);
  },
  isPluginActivated(pluginId) {
    return loadedPluginService?.isPluginActivated(pluginId) ?? false;
  },
  async filterForProject(steps, projectId) {
    const { selectContributionsForProject } =
      await import("./plugin/PluginContributionBroadcaster.js");
    return selectContributionsForProject(steps, (step) => step.pluginId, projectId);
  },
};

function sameDeclaration(
  current: RegisteredWorktreeSetupStep,
  requested: WorktreeSetupStepDescriptor
): boolean {
  return (
    current.pluginVersion === requested.pluginVersion &&
    current.label === requested.label &&
    current.timeoutMs === requested.timeoutMs
  );
}

function describe(step: RegisteredWorktreeSetupStep): WorktreeSetupStepDescriptor {
  return {
    pluginId: step.pluginId,
    pluginName: step.pluginName,
    pluginVersion: step.pluginVersion,
    stepId: step.stepId,
    label: step.label,
    timeoutMs: step.timeoutMs,
  };
}

/**
 * Main's side of the plugin worktree setup step RPC (#13807), one per
 * workspace host process. The host owns the sequence and the worktree's
 * status; this owns finding the plugin and running its handler under the
 * step's own timeout.
 *
 * The project is the host's, read from the `projectPath` this server was made
 * for — never from the event and never from whichever project is focused.
 */
export class WorktreeSetupRpcServer {
  private readonly runs = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private readonly projectPath: string,
    private readonly send: Sender,
    private readonly deps: WorktreeSetupRpcDeps = defaultDeps
  ) {}

  handleList(setupRequestId: string): void {
    void this.answer(setupRequestId, () => this.listSteps());
  }

  handleRun(
    setupRequestId: string,
    step: WorktreeSetupStepDescriptor,
    target: WorktreeSetupStepTarget
  ): void {
    const controller = new AbortController();
    this.runs.set(setupRequestId, controller);
    void this.answer(
      setupRequestId,
      () => this.runStep(step, target, controller.signal),
      controller.signal
    ).finally(() => {
      if (this.runs.get(setupRequestId) === controller) this.runs.delete(setupRequestId);
    });
  }

  handleCancel(setupRequestId: string): void {
    const controller = this.runs.get(setupRequestId);
    this.runs.delete(setupRequestId);
    controller?.abort();
  }

  /** The host is gone: abort every step it was waiting on. */
  abortAll(): void {
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.abortAll();
  }

  private async answer(
    setupRequestId: string,
    work: () => Promise<unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    let reply: WorkspaceHostRequest;
    try {
      reply = { type: "worktree-setup:result", setupRequestId, ok: true, value: await work() };
    } catch (err) {
      reply = {
        type: "worktree-setup:result",
        setupRequestId,
        ok: false,
        error: formatErrorMessage(err, "Plugin setup step request failed"),
      };
    }
    // A cancelled run's host stopped waiting, and may not be the host now listening.
    if (this.disposed || signal?.aborted) return;
    this.send(reply);
  }

  private async visibleSteps(): Promise<{
    projectId: string | null;
    steps: RegisteredWorktreeSetupStep[];
  }> {
    const projectId = await this.deps.resolveProjectId(this.projectPath);
    await this.deps.whenPluginsLoaded(projectId);
    const steps = await this.deps.filterForProject(getWorktreeSetupSteps(), projectId);
    return { projectId, steps };
  }

  private async listSteps(): Promise<WorktreeSetupStepDescriptor[]> {
    return (await this.visibleSteps()).steps.map(describe);
  }

  /**
   * The step the host asked for, as the project's plugins declare it now, or
   * the outcome that says why it can't run.
   */
  private async resolveStep(
    requested: WorktreeSetupStepDescriptor
  ): Promise<
    | { projectId: string; current: RegisteredWorktreeSetupStep }
    | { outcome: WorktreeSetupStepRunOutcome }
  > {
    const { projectId, steps } = await this.visibleSteps();
    const current = steps.find(
      (step) => step.pluginId === requested.pluginId && step.stepId === requested.stepId
    );
    if (!current || projectId === null) {
      return { outcome: { state: "skipped", error: "the plugin isn't loaded for this project" } };
    }
    // What the user allowed is what runs: an upgrade or an edited declaration
    // between listing and running is not this step any more.
    if (!sameDeclaration(current, requested)) {
      return { outcome: { state: "failed", error: "the plugin changed while setup was running" } };
    }
    return { projectId, current };
  }

  private async runStep(
    requested: WorktreeSetupStepDescriptor,
    target: WorktreeSetupStepTarget,
    signal: AbortSignal
  ): Promise<WorktreeSetupStepRunOutcome> {
    const declared = await this.resolveStep(requested);
    if ("outcome" in declared) return declared.outcome;

    await this.deps.activatePlugin(declared.current.pluginId);
    if (signal.aborted) return { state: "failed", error: "cancelled" };
    // A failed activation can leave a dev worker running with its handler
    // bound; that is not a plugin that started.
    if (!this.deps.isPluginActivated(declared.current.pluginId)) {
      return { state: "skipped", error: "the plugin didn't start" };
    }
    // Visibility is checked again now that it is active, since activating can
    // reload it. Everything after that await is read in one synchronous turn —
    // the declaration, the activation and the handler — so all three belong
    // to the same plugin, and the handler starts in that turn too.
    const resolved = await this.resolveStep(requested);
    if ("outcome" in resolved) return resolved.outcome;
    const { projectId } = resolved;
    if (signal.aborted) return { state: "failed", error: "cancelled" };
    const current = getWorktreeSetupSteps().find(
      (step) => step.pluginId === requested.pluginId && step.stepId === requested.stepId
    );
    if (!current || !sameDeclaration(current, requested)) {
      return { state: "failed", error: "the plugin changed while setup was running" };
    }
    if (!this.deps.isPluginActivated(current.pluginId)) {
      return { state: "skipped", error: "the plugin didn't start" };
    }
    const handler = getWorktreeSetupStepHandler(current.pluginId, current.stepId);
    if (!handler) {
      return { state: "skipped", error: "the plugin never registered this step" };
    }

    const step = new AbortController();
    const onCancel = (): void => step.abort(signal.reason);
    signal.addEventListener("abort", onCancel, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => {
        step.abort(new Error("timed out"));
        resolve("timed-out");
      }, current.timeoutMs);
    });
    try {
      let ran: Promise<void>;
      try {
        ran = Promise.resolve(
          handler({
            projectId,
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            branch: target.branch,
            signal: step.signal,
          })
        );
      } catch (err) {
        ran = Promise.reject(err);
      }
      // A handler that ignores its signal is not waited for past its timeout.
      ran.catch(() => undefined);
      if ((await Promise.race([ran.then(() => "done" as const), timedOut])) === "timed-out") {
        return {
          state: "timed-out",
          error: `timed out after ${Math.round(current.timeoutMs / 1000)}s`,
        };
      }
      return { state: "succeeded" };
    } catch (err) {
      return { state: "failed", error: formatErrorMessage(err, "the step failed") };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onCancel);
    }
  }
}
