import path from "path";
import fs from "fs/promises";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers, broadcastToRenderer } from "../../ipc/utils.js";
import {
  assertCloneDestination,
  executeClone,
  resolveCloneTarget,
} from "../../ipc/handlers/projectCrud/gitClone.js";
import { projectStore, type PersistedCloneJob } from "../ProjectStore.js";
import { AppError, GitOperationError } from "../../utils/errorTypes.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { Project, ProjectCreationIdentity } from "../../../shared/types/project.js";
import type { GitOperationReason } from "../../../shared/types/ipc/errors.js";
import type {
  ProjectCloneJobSnapshot,
  ProjectCloneJobStatus,
  ProjectCloneStage,
  ProjectCloneStartRequest,
} from "../../../shared/types/ipc/projectClone.js";
import { CloneOutputLog } from "./cloneOutputLog.js";
import { clearCheckoutPending, markCheckoutPending } from "./checkoutGate.js";

/** Percent ticks and output lines coalesce to this; stage changes go at once. */
const PUBLISH_INTERVAL_MS = 100;

const INTERRUPTED_MESSAGE = "The clone stopped when Daintree closed.";

/** Engine stages the promise reports; they never become a progress row. */
const TERMINAL_STAGES = new Set(["complete", "error", "cancelled"]);

/** Git's own stage keys the user reads better under another name. */
const STAGE_LABELS: Record<string, string> = {
  "updating files": "Checking out files",
  submodules: "Updating submodules",
};

function stageLabel(stage: string, message: string): string {
  const known = STAGE_LABELS[stage];
  if (known) return known;
  const label = message
    .replace(/\s*:\s*\d+%\s*$/, "")
    .replace(/:+$/, "")
    .trim();
  if (label) return label;
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

interface CloneJob {
  projectId: string;
  targetPath: string;
  request: PersistedCloneJob;
  status: ProjectCloneJobStatus;
  stopping: boolean;
  /** Quit, not the user, stopped it: it ends as failed, not as stopped. */
  interruptedByQuit: boolean;
  stages: ProjectCloneStage[];
  currentStageKey: string | null;
  output: CloneOutputLog;
  /** Git's stderr reached the log, so progress messages stay out of it. */
  sawRawOutput: boolean;
  error: string | null;
  gitReason?: GitOperationReason;
  cleanupError: string | null;
  sequence: number;
  controller: AbortController | null;
  run: Promise<void> | null;
  publishTimer: ReturnType<typeof setTimeout> | null;
}

export interface ProjectCloneServiceHooks {
  /**
   * The checkout is in place and the row says so. Runs before any view hears
   * about it, so a window showing the project has its workspace loaded by the
   * time that view reloads into a normal project.
   */
  onCheckoutReady?: (project: Project) => Promise<void>;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof AppError && error.code === "CANCELLED";
}

/**
 * Runs each project's clone in main, independent of the view that asked for it
 * (#16352). The project is registered the moment a clone is accepted, in its
 * cloning state; its views follow the job through snapshots, and every clone
 * has its own controller, so a Stop reaches exactly one (#15012).
 */
export class ProjectCloneService {
  private readonly jobs = new Map<string, CloneJob>();
  private sealed = false;
  private hooks: ProjectCloneServiceHooks = {};

  setHooks(hooks: ProjectCloneServiceHooks): void {
    this.hooks = hooks;
  }

  async start(
    request: ProjectCloneStartRequest,
    creation: { identity?: ProjectCreationIdentity; groupId?: string } = {}
  ): Promise<{ project: Project }> {
    if (this.sealed) {
      throw new AppError({ code: "CANCELLED", message: "Daintree is quitting" });
    }
    const target = resolveCloneTarget(request);
    await assertCloneDestination(target.parentPath, target.targetPath, target.folderName);

    // The row's path is the git root the finished clone will resolve to, which
    // is realpath'd: a symlinked parent must not leave the two disagreeing.
    const canonicalParent = await fs.realpath(target.parentPath);
    const projectPath = path.normalize(path.join(canonicalParent, target.folderName)).normalize("NFC");
    if (await projectStore.getProjectByPath(projectPath)) {
      throw new Error(`A project is already registered at ${projectPath}`);
    }
    // Synchronous with the insert below: two clones into one folder would
    // each delete the other's checkout when theirs failed.
    for (const job of this.jobs.values()) {
      if (job.targetPath === projectPath) {
        throw new Error(`Folder "${target.folderName}" already exists in this location`);
      }
    }

    const persisted: PersistedCloneJob = { url: target.url, shallow: request.shallowClone === true };
    const project = projectStore.insertCloningProject(projectPath, {
      ...(creation.identity ? { identity: creation.identity } : {}),
      ...(creation.groupId ? { groupId: creation.groupId } : {}),
      job: persisted,
    });
    markCheckoutPending(project.id, project.path);

    const job = this.createJob(project.id, project.path, persisted);
    this.jobs.set(project.id, job);
    this.launch(job);
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
    return { project };
  }

  getSnapshot(projectId: string): ProjectCloneJobSnapshot | null {
    const job = this.jobs.get(projectId) ?? this.restoreJob(projectId);
    return job ? this.toSnapshot(job) : null;
  }

  /** Stop one project's clone. Git's teardown and the partial's removal follow. */
  cancel(projectId: string): void {
    const job = this.jobs.get(projectId);
    if (!job || job.status !== "running" || !job.controller) return;
    job.stopping = true;
    this.publish(job, true);
    job.controller.abort();
  }

  async retry(projectId: string): Promise<void> {
    if (this.sealed) {
      throw new AppError({ code: "CANCELLED", message: "Daintree is quitting" });
    }
    const job = this.jobs.get(projectId) ?? this.restoreJob(projectId);
    if (!job) throw new Error("This project has no clone to retry");
    if (job.status === "running") return;
    if (job.request.url.length === 0) {
      throw new Error("The repository address wasn't kept. Remove the project and clone it again.");
    }
    // Only after the previous attempt has finished its own cleanup.
    if (job.run) await job.run;
    const parentPath = path.dirname(job.targetPath);
    const folderName = path.basename(job.targetPath);
    await assertCloneDestination(parentPath, job.targetPath, folderName);

    const project = projectStore.setCloneState(projectId, "cloning", job.request);
    markCheckoutPending(projectId, job.targetPath);
    this.resetAttempt(job);
    this.jobs.set(projectId, job);
    this.launch(job);
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
  }

  /**
   * Stop a project's clone and wait until git and its partial checkout are
   * gone, so removing the row can't leave a clone writing into the folder.
   */
  async releaseForRemoval(projectId: string): Promise<void> {
    const job = this.jobs.get(projectId);
    if (job) {
      if (job.status === "running") {
        job.stopping = true;
        job.controller?.abort();
      }
      if (job.run) await job.run.catch(() => {});
      if (job.publishTimer) clearTimeout(job.publishTimer);
      this.jobs.delete(projectId);
    }
    clearCheckoutPending(projectId);
  }

  /**
   * Boot: every project still awaiting its clone keeps its folder gated, and
   * one the last session left mid-clone (a crash, a forced quit) loses its
   * partial checkout and ends as failed rather than looking like a project.
   */
  async recoverInterrupted(): Promise<void> {
    for (const { project, job } of projectStore.getProjectsAwaitingClone()) {
      markCheckoutPending(project.id, project.path);
      if (project.cloneState !== "cloning") continue;
      const cleanupError = await removeInterruptedCheckout(project.path);
      try {
        projectStore.setCloneState(project.id, "failed", {
          url: job?.url ?? "",
          shallow: job?.shallow ?? false,
          error: INTERRUPTED_MESSAGE,
          ...(cleanupError ? { cleanupError } : {}),
        });
      } catch (error) {
        console.warn("[ProjectClone] Couldn't record an interrupted clone:", error);
      }
    }
  }

  /**
   * Quit: refuse new clones, stop the running ones and wait, up to the
   * deadline, for git to exit and the partial checkouts to go. Whatever is
   * still running when the deadline passes is recovered on the next boot.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.sealed = true;
    const runs: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.interruptedByQuit = true;
      job.controller?.abort();
      if (job.run) runs.push(job.run);
    }
    if (runs.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(runs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private createJob(projectId: string, targetPath: string, request: PersistedCloneJob): CloneJob {
    return {
      projectId,
      targetPath,
      request,
      status: "running",
      stopping: false,
      interruptedByQuit: false,
      stages: [],
      currentStageKey: null,
      output: new CloneOutputLog(),
      sawRawOutput: false,
      error: null,
      cleanupError: null,
      sequence: 0,
      controller: null,
      run: null,
      publishTimer: null,
    };
  }

  private resetAttempt(job: CloneJob): void {
    job.status = "running";
    job.stopping = false;
    job.interruptedByQuit = false;
    job.stages = [];
    job.currentStageKey = null;
    job.output = new CloneOutputLog();
    job.sawRawOutput = false;
    job.error = null;
    delete job.gitReason;
    job.cleanupError = null;
    job.request = { url: job.request.url, shallow: job.request.shallow };
  }

  /** A failed or stopped clone from an earlier session, read back from its row. */
  private restoreJob(projectId: string): CloneJob | null {
    const project = projectStore.getProjectById(projectId);
    if (!project?.cloneState || project.cloneState === "cloning") return null;
    const persisted = projectStore.getCloneJob(projectId) ?? { url: "", shallow: false };
    const job = this.createJob(projectId, project.path, persisted);
    job.status = project.cloneState;
    job.error = persisted.error ?? null;
    if (persisted.gitReason) job.gitReason = persisted.gitReason as GitOperationReason;
    job.cleanupError = persisted.cleanupError ?? null;
    this.jobs.set(projectId, job);
    return job;
  }

  private launch(job: CloneJob): void {
    const controller = new AbortController();
    job.controller = controller;
    const run = this.runAttempt(job, controller).finally(() => {
      if (job.run === run) job.run = null;
    });
    job.run = run;
    this.publish(job, true);
  }

  private async runAttempt(job: CloneJob, controller: AbortController): Promise<void> {
    try {
      await executeClone({
        url: job.request.url,
        parentPath: path.dirname(job.targetPath),
        folderName: path.basename(job.targetPath),
        targetPath: job.targetPath,
        depth: job.request.shallow ? "shallow" : "full",
        signal: controller.signal,
        onProgress: (stage, progress, message) => this.onProgress(job, stage, progress, message),
        onOutput: (chunk) => {
          // Progress can be parsed from a chunk before the chunk itself lands
          // here; git's own text replaces what was drawn from it.
          if (!job.sawRawOutput) {
            job.sawRawOutput = true;
            job.output = new CloneOutputLog();
          }
          job.output.append(chunk);
          this.publish(job);
        },
      });
    } catch (error) {
      if (isCancellation(error, controller.signal) && !job.interruptedByQuit) {
        this.settle(job, "cancelled");
      } else {
        this.settle(job, "failed", job.interruptedByQuit ? INTERRUPTED_MESSAGE : error);
      }
      return;
    }

    // Git is done; a Stop that arrives now is too late to save anything.
    try {
      await this.finalize(job);
    } catch (error) {
      console.error("[ProjectClone] Couldn't open the cloned repository:", error);
      this.settle(job, "failed", error);
    }
  }

  private onProgress(job: CloneJob, stage: string, progress: number, message: string): void {
    if (stage === "cleanup-failed") {
      job.cleanupError = message;
      this.publish(job, true);
      return;
    }
    if (TERMINAL_STAGES.has(stage)) return;

    const percent = Math.min(100, Math.max(0, Math.round(progress)));
    const existing = job.stages.find((entry) => entry.key === stage);
    const stageChanged = job.currentStageKey !== stage;
    if (existing) {
      existing.percent = percent;
    } else {
      job.stages.push({ key: stage, label: stageLabel(stage, message), percent });
    }
    job.currentStageKey = stage;
    // A provider's clone command hands over no stream, so its progress is the
    // output there is to show.
    if (!job.sawRawOutput) {
      const line = scrubSecrets(message);
      if (stageChanged) job.output.appendLine(line);
      else job.output.redrawLine(line);
    }
    this.publish(job, stageChanged);
  }

  private async finalize(job: CloneJob): Promise<void> {
    const classification = await projectStore.classifyGitBacking(job.targetPath);
    if (!classification.gitBacked) {
      throw new Error("The clone finished without a repository");
    }
    const project = await projectStore.completeClone(job.projectId);
    clearCheckoutPending(job.projectId);
    try {
      await this.hooks.onCheckoutReady?.(project);
    } catch (error) {
      console.warn("[ProjectClone] Couldn't load the cloned project's workspace:", error);
    }
    job.controller = null;
    job.status = "succeeded";
    this.publish(job, true);
    this.jobs.delete(job.projectId);
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
  }

  private settle(job: CloneJob, outcome: "failed" | "cancelled", error?: unknown): void {
    job.controller = null;
    job.stopping = false;
    job.status = outcome;
    job.currentStageKey = null;
    if (outcome === "failed") {
      const message =
        typeof error === "string" ? error : formatErrorMessage(error, "Failed to clone repository");
      job.error = scrubSecrets(message);
      if (error instanceof GitOperationError) job.gitReason = error.reason;
    }
    job.request = {
      url: job.request.url,
      shallow: job.request.shallow,
      ...(job.error ? { error: job.error } : {}),
      ...(job.gitReason ? { gitReason: job.gitReason } : {}),
      ...(job.cleanupError ? { cleanupError: job.cleanupError } : {}),
    };
    this.publish(job, true);
    // The project may have been removed while git was being torn down.
    if (!projectStore.getProjectById(job.projectId)) return;
    try {
      const project = projectStore.setCloneState(job.projectId, outcome, job.request);
      broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
    } catch (persistError) {
      console.warn("[ProjectClone] Couldn't record the clone's outcome:", persistError);
    }
  }

  private publish(job: CloneJob, immediate = false): void {
    job.sequence++;
    if (!immediate) {
      if (job.publishTimer) return;
      job.publishTimer = setTimeout(() => {
        job.publishTimer = null;
        this.send(job);
      }, PUBLISH_INTERVAL_MS);
      return;
    }
    if (job.publishTimer) {
      clearTimeout(job.publishTimer);
      job.publishTimer = null;
    }
    this.send(job);
  }

  private send(job: CloneJob): void {
    broadcastToProjectRenderers(
      job.projectId,
      CHANNELS.PROJECT_CLONE_JOB_UPDATED,
      this.toSnapshot(job)
    );
  }

  private toSnapshot(job: CloneJob): ProjectCloneJobSnapshot {
    return {
      projectId: job.projectId,
      sequence: job.sequence,
      status: job.status,
      stopping: job.stopping,
      source: scrubSecrets(job.request.url),
      targetPath: job.targetPath,
      stages: job.stages.map((stage) => ({ ...stage })),
      currentStageKey: job.currentStageKey,
      output: job.output.snapshot(),
      error: job.error,
      ...(job.gitReason ? { gitReason: job.gitReason } : {}),
      cleanupError: job.cleanupError,
      canRetry:
        (job.status === "failed" || job.status === "cancelled") &&
        job.request.url.length > 0 &&
        job.cleanupError === null,
    };
  }
}

/**
 * Remove what a clone the last session never finished left at its target. Only
 * a folder that is empty or holds a `.git` is taken: that is what git leaves,
 * and anything else is not provably the clone's to delete. Returns the message
 * to show when the folder had to be left.
 */
async function removeInterruptedCheckout(targetPath: string): Promise<string | null> {
  const stat = await fs.lstat(targetPath).catch(() => null);
  if (!stat) return null;
  const leftMessage = `Couldn't remove the partial clone at ${targetPath}. Delete the folder manually.`;
  if (!stat.isDirectory()) return leftMessage;
  try {
    const entries = await fs.readdir(targetPath);
    if (entries.length > 0 && !entries.includes(".git")) return leftMessage;
    await fs.rm(targetPath, { recursive: true, force: true });
    return null;
  } catch (error) {
    console.warn("[ProjectClone] Couldn't remove an interrupted clone at", targetPath, error);
    return leftMessage;
  }
}

let instance: ProjectCloneService | null = null;

export function getProjectCloneService(): ProjectCloneService {
  instance ??= new ProjectCloneService();
  return instance;
}

/** The service if anything has used it; quit never creates one. */
export function peekProjectCloneService(): ProjectCloneService | null {
  return instance;
}

/** Test seam. */
export function resetProjectCloneServiceForTests(): void {
  instance = null;
}
