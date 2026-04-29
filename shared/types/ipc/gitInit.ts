/**
 * Git initialization workflow types
 */

export interface GitInitOptions {
  /** Directory path to initialize */
  directoryPath: string;
  /** Create an initial commit after initialization (default: true) */
  createInitialCommit?: boolean;
  /** Initial commit message (default: "Initial commit") */
  initialCommitMessage?: string;
  /** Create a .gitignore file (default: true) */
  createGitignore?: boolean;
  /** Gitignore template to use (default: "node") */
  gitignoreTemplate?: "node" | "python" | "minimal" | "none";
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
  /** Steps completed during a successful init */
  completedSteps: GitInitStepType[];
}
