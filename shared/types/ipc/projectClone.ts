import type { Project, ProjectCreationIdentity } from "../project.js";
import type { GitOperationReason } from "./errors.js";

/**
 * A clone that runs in the background as a project of its own (#16352). The
 * dialog collects these and hands off; the project exists, in its cloning
 * state, as soon as the request is accepted.
 */
export interface ProjectCloneStartRequest {
  url: string;
  /** Existing directory the clone is created in. */
  parentPath: string;
  folderName: string;
  shallowClone?: boolean;
  identity?: ProjectCreationIdentity;
  groupId?: string;
}

export interface ProjectCloneStartResult {
  project: Project;
}

/** One git phase, in the order git first reported it. */
export interface ProjectCloneStage {
  /** Git's own lowercase stage key, e.g. `receiving objects`. */
  key: string;
  label: string;
  /** Through this phase alone, 0-100; each phase counts from zero. */
  percent: number;
}

export type ProjectCloneJobStatus = "running" | "failed" | "cancelled" | "succeeded";

/**
 * Everything a view needs to draw a project's clone. Main owns it; every view
 * of the project reads it on mount and follows its updates, so switching away
 * and back shows the clone where it is now.
 */
export interface ProjectCloneJobSnapshot {
  projectId: string;
  /** Bumped on every change, so a reply older than an update never wins. */
  sequence: number;
  status: ProjectCloneJobStatus;
  /** A stop was asked for and git is still being torn down. */
  stopping: boolean;
  /** The repository being cloned, scrubbed of any credentials. */
  source: string;
  targetPath: string;
  stages: ProjectCloneStage[];
  /** The live phase; null before git reports one (connecting). */
  currentStageKey: string | null;
  /** Git's output, last lines only, scrubbed of credentials. */
  output: string[];
  /** Git's scrubbed error when the clone failed. */
  error: string | null;
  gitReason?: GitOperationReason;
  /** The partial checkout couldn't be removed and needs removing by hand. */
  cleanupError: string | null;
  /** A retry can run: the request is known and nothing is left at the target. */
  canRetry: boolean;
}
