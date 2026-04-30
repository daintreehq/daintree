export interface FileSearchPayload {
  cwd: string;
  query: string;
  limit?: number;
}

export interface FileSearchResult {
  files: string[];
}

export interface FileReadPayload {
  path: string;
  rootPath: string;
}

/**
 * Subset of `AppErrorCode` thrown by `files:read`. Renderer consumers narrow
 * caught `AppError`s with `if (e.code === "BINARY_FILE") { ... }` style checks.
 */
export type FileReadErrorCode =
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "LFS_POINTER"
  | "NOT_FOUND"
  | "OUTSIDE_ROOT"
  | "INVALID_PATH"
  | "PERMISSION";

export interface FileReadResult {
  content: string;
}
