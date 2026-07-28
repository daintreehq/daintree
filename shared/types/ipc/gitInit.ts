/**
 * Git initialization workflow types
 */

import type { GitignoreTemplateId } from "../../config/gitignoreTemplates.js";

export interface GitInitOptions {
  /** Directory path to initialize */
  directoryPath: string;
  /** Create an initial commit after initialization (default: true) */
  createInitialCommit?: boolean;
  /** Initial commit message (default: "Initial commit") */
  initialCommitMessage?: string;
  /** Create a .gitignore file (default: true) */
  createGitignore?: boolean;
  /** Gitignore template to use (default: "minimal") */
  gitignoreTemplate?: GitignoreTemplateId;
}

export type GitInitStepType = "init" | "gitignore" | "add" | "commit" | "complete" | "error";

export interface GitInitProgressEvent {
  step: GitInitStepType;
  status: "start" | "success" | "error";
  message: string;
  /** Error message if status is "error" */
  error?: string;
  /** Timestamp of the event */
  timestamp: number;
}

/**
 * Successful result from `project:init-git`. Failures throw `AppError` whose
 * `context.completedSteps` carries the partial progress for diagnostics.
 */
export interface GitInitResult {
  /** "success" when the workflow finished cleanly; "error" when it resolved with a terminal error (e.g. initial commit skipped). Named to avoid the forbidden `ok`/`success` envelope keys. */
  outcome: "success" | "error";
  /** Steps completed during a successful init */
  completedSteps: GitInitStepType[];
}
