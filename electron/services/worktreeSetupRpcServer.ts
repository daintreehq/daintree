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
  /** Settles once the startup plugin scan has, so a list is never a cold-start blank. */
  whenPluginsLoaded(): Promise<void>;
  /** Never rejects: a failed activation leaves the step with no handler. */
  activatePlugin(pluginId: string): Promise<void>;
  /** The steps whose plugin a view of `projectId` would see. */
  filterForProject(
    steps: RegisteredWorktreeSetupStep[],
    projectId: string | null
  ): Promise<RegisteredWorktreeSetupStep[]>;
}

// Loaded lazily so importing this module from `WorkspaceHostProcess` does not
// construct the PluginService and ProjectStore singletons at module load.
const defaultDeps: WorktreeSetupRpcDeps = {
  async resolveProjectId(projectPath) {
    const { projectStore } = await import("./ProjectStore.js");
    return (await projectStore.getProjectByPath(projectPath))?.id ?? null;
  },
  async whenPluginsLoaded() {
    const { pluginService } = await import("./PluginService.js");
    await pluginService.waitForInit();
  },
  async activatePlugin(pluginId) {
    const { pluginService } = await import("./PluginService.js");
    await pluginService.activatePlugin(pluginId);
  },
  async filterForProject(steps, projectId) {
    const { selectContributionsForProject } =
      await import("./plugin/PluginContributionBroadcaster.js");
    return selectContributionsForProject(steps, (step) => step.pluginId, projectId);
  },
};

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
    await this.deps.whenPluginsLoaded();
    const projectId = await this.deps.resolveProjectId(this.projectPath);
    const steps = await this.deps.filterForProject(getWorktreeSetupSteps(), projectId);
    return { projectId, steps };
  }

  private async listSteps(): Promise<WorktreeSetupStepDescriptor[]> {
    return (await this.visibleSteps()).steps.map(describe);
  }

  private async runStep(
    requested: WorktreeSetupStepDescriptor,
    target: WorktreeSetupStepTarget,
    signal: AbortSignal
  ): Promise<WorktreeSetupStepRunOutcome> {
    const { projectId, steps } = await this.visibleSteps();
    const current = steps.find(
      (step) => step.pluginId === requested.pluginId && step.stepId === requested.stepId
    );
    if (!current) {
      return { state: "skipped", error: "the plugin isn't loaded for this project" };
    }
    // What the user allowed is what runs: an upgrade or an edited declaration
    // between listing and running is not this step any more.
    if (
      current.pluginVersion !== requested.pluginVersion ||
      current.label !== requested.label ||
      current.timeoutMs !== requested.timeoutMs
    ) {
      return { state: "failed", error: "the plugin changed while setup was running" };
    }
    if (projectId === null) {
      return {
        state: "skipped",
        error: "the project isn't recorded, so no plugin is loaded for it",
      };
    }

    await this.deps.activatePlugin(current.pluginId);
    if (signal.aborted) return { state: "failed", error: "cancelled" };
    const handler = getWorktreeSetupStepHandler(current.pluginId, current.stepId);
    if (!handler) {
      return { state: "skipped", error: "the plugin didn't start, or never registered this step" };
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
      const ran = Promise.resolve().then(() =>
        handler({
          projectId,
          worktreeId: target.worktreeId,
          worktreePath: target.worktreePath,
          branch: target.branch,
          signal: step.signal,
        })
      );
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
