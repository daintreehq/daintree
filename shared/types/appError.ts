/**
 * Discriminated codes carried by `AppError` (main process) and
 * `ClientAppError` (renderer) so callers can `e.code === "BINARY_FILE"`
 * pattern-match instead of substring-matching `e.message`. These survive the
 * IPC envelope and packaged-build serialization strip.
 */
export type AppErrorCode =
  | "INVALID_PATH"
  | "OUTSIDE_ROOT"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "LFS_POINTER"
  | "NOT_FOUND"
  | "CLIPBOARD_EMPTY"
  | "CLIPBOARD_INVALID"
  | "UNSUPPORTED"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "VALIDATION"
  | "PERMISSION"
  | "INTERNAL";
