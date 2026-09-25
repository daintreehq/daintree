export interface CloneRepoOptions {
  url: string;
  parentPath: string;
  folderName: string;
  shallowClone?: boolean;
  /**
   * Client-minted operation id. A retry with the same id, or a second clone
   * of the same remote into the same destination, joins the running clone
   * instead of starting another; absent means the Host mints its own.
   */
  opId?: string;
}

export interface CloneCancelPayload {
  /** Cancel only this clone. Absent cancels every in-flight clone. */
  opId?: string;
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
  "starting" | "complete" | "cancelled" | "error" | "cleanup-failed" | (string & {});

export interface CloneRepoProgressEvent {
  /** The clone this event belongs to. */
  opId?: string;
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
