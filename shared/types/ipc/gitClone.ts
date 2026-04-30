export interface CloneRepoOptions {
  url: string;
  parentPath: string;
  folderName: string;
  shallowClone?: boolean;
}

export interface CloneRepoProgressEvent {
  stage: string;
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
