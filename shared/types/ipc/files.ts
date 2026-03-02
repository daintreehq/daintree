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

export type FileReadErrorCode =
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "NOT_FOUND"
  | "OUTSIDE_ROOT"
  | "INVALID_PATH";

export type FileReadResult = { ok: true; content: string } | { ok: false; code: FileReadErrorCode };
