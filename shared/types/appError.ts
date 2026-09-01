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
  | "NOT_A_GIT_REPO"
  // Folder-open failures classified by a pre-flight stat rather than by
  // pattern-matching library error text after the fact (#11409). `NOT_FOUND`
  // and `PERMISSION` cover the rest of that set.
  | "NOT_A_DIRECTORY"
  | "GIT_NOT_INSTALLED"
  | "DUBIOUS_OWNERSHIP"
  | "PROJECT_OPEN_FAILED"
  | "CLIPBOARD_EMPTY"
  | "CLIPBOARD_INVALID"
  | "UNSUPPORTED"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "VALIDATION"
  | "PERMISSION"
  | "ARG_COUNT_EXCEEDED"
  | "PAYLOAD_TOO_LARGE"
  | "RECIPE_STALE_CONFLICT"
  | "PLUGIN_ACTIVATION_FAILED"
  // A project-bound plugin host call had no live renderer for its own project.
  // Deliberately not a fallback to the focused view: delivering it elsewhere is
  // the confused-deputy bug this code exists to make visible.
  | "PROJECT_VIEW_UNAVAILABLE"
  // Session-bookmark capture/persistence outcomes (#11288). Stable codes so the
  // UI (and MCP/automation callers) surface copy from the code, not exception text.
  | "NOT_BOOKMARKABLE"
  | "SESSION_CAPTURE_FAILED"
  | "STALE_GENERATION"
  | "PERSIST_FAILED"
  | "SESSION_NOT_FOUND"
  | "INTERNAL";
