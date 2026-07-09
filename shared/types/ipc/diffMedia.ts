export interface DiffMediaReadFileVersionsPayload {
  /** Absolute worktree root the file path is resolved against. */
  cwd: string;
  /** Repo-relative path of the image file. */
  filePath: string;
}

export type DiffMediaSideError = "NOT_FOUND" | "TOO_LARGE" | "UNSUPPORTED" | "ERROR";

export type DiffMediaSide =
  | { ok: true; dataUrl: string; byteSize: number }
  | { ok: false; error: DiffMediaSideError };

export interface DiffMediaFileVersions {
  head: DiffMediaSide;
  working: DiffMediaSide;
}

/** Per-side byte cap for image compare payloads. */
export const DIFF_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
