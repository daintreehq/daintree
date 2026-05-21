export interface CloneRepoOptions {
  url: string;
  parentPath: string;
  folderName: string;
  shallowClone?: boolean;
}

/**
 * App-owned clone lifecycle stages. `cleanup-failed` is emitted when a partial
 * clone could not be removed after a failure/cancel (e.g. Windows file locks);
 * the renderer surfaces it as a separate inline banner, not a progress row.
 * Git's own progress stages (`receiving objects`, `resolving deltas`, …) pass
 * through as free-form strings — `(string & {})` keeps literal autocomplete
 * for the known stages while still accepting them.
 */
export type CloneRepoStage =
  | "starting"
  | "complete"
  | "cancelled"
  | "error"
  | "cleanup-failed"
  | (string & {});

export interface CloneRepoProgressEvent {
  stage: CloneRepoStage;
  progress: number;
  message: string;
  timestamp: number;
}

/**
 * Successful clone result. Failures throw `AppError`:
 * `code: "CANCELLED"` when the user aborted the clone, otherwise `INTERNAL`.
 */
export interface CloneRepoResult {
  clonedPath: string;
}
