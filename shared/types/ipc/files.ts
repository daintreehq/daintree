import type { AppErrorCode } from "../appError.js";

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
  /**
   * When true and the file is HTML (.html/.htm), the result also carries an
   * `htmlPreviewUrl` for rendering the file in a sandboxed iframe (#11191).
   * Opt-in so a plain read never mints a preview capability.
   */
  htmlPreview?: boolean;
}

/**
 * Subset of `AppErrorCode` thrown by `files:read`. Renderer consumers narrow
 * caught `AppError`s with `if (e.code === "BINARY_FILE") { ... }` style checks.
 */
// `_AssertSubset<T, U>` constrains `U extends T` and returns `U`. Wrapping
// `FileReadErrorCode` in it makes the subset relationship a hard compile-time
// guarantee — if any member is dropped from `AppErrorCode`, this fails to
// typecheck.
type _AssertSubset<T, U extends T> = U;

export type FileReadErrorCode = _AssertSubset<
  AppErrorCode,
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "LFS_POINTER"
  | "NOT_FOUND"
  | "OUTSIDE_ROOT"
  | "INVALID_PATH"
  | "NOT_A_FILE"
  | "PERMISSION"
>;

/**
 * Why a remote window's host refused a preview when the file itself isn't the
 * problem: another window has control of the project, or the file is outside
 * it. Sent as a header, since the refusal a preview probes is a HEAD answer
 * with no body.
 */
export type PreviewRefusal = "driven-elsewhere" | "outside-project";

export const PREVIEW_REFUSAL_HEADER = "X-Daintree-Refusal";

export function isPreviewRefusal(value: unknown): value is PreviewRefusal {
  return value === "driven-elsewhere" || value === "outside-project";
}

/**
 * What the bytes on disk were, observed before decoding. `content` is always
 * decoded as UTF-8, so a BOM survives as U+FEFF and invalid sequences become
 * U+FFFD — neither of which the renderer can tell apart from text that really
 * contains those characters.
 */
export type FileTextEncoding = "utf-8" | "utf-8-bom" | "invalid";

export interface FileReadResult {
  content: string;
  /** Observed from the raw bytes; absent from an older main. */
  encoding?: FileTextEncoding;
  /** The file's length in bytes as read, before decoding; absent from an older main. */
  byteLength?: number;
  /**
   * `daintree-html://<token>/<relpath>` URL for a sandboxed iframe preview,
   * present only when the read was requested with `htmlPreview` and the file is
   * HTML. Absent otherwise (#11191).
   */
  htmlPreviewUrl?: string;
  /**
   * True when the requested path is already its own realpath — no symlinked
   * directory anywhere along it — and the file has no other hard link. The worktree watcher reports writes under the
   * real path, so only a canonical path can be matched against the directories
   * a change tick names; anything else (false, or absent from an older main)
   * has to re-read on every tick.
   */
  pathIsCanonical?: boolean;
}
