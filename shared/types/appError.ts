import type { PluginHostError } from "./remoteHosts.js";

/**
 * Structured, allowlisted error details that survive IPC serialization and
 * the packaged-build sanitiser (unlike `context`, which is stripped). Keep
 * every member small and free of paths, secrets and user content.
 */
export type AppErrorDetails = PluginHostError;

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
  // The path resolved to a directory where a file was required. A submodule
  // gitlink is the case that surfaces it: its path is the submodule's own
  // checkout, so reading it as a file gets EISDIR (#12309).
  | "NOT_A_FILE"
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
  // A write into `.daintree/recipes/` would delete content this build cannot
  // represent — unknown fields, or terminals of an unrecognized type — that a
  // newer build (or a plugin) put in the tracked file (#12261).
  | "RECIPE_FORWARD_COMPAT_CONFLICT"
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
  // Remote Hosts. A plugin is missing on, or can't run on, the window's host;
  // the details travel as `AppErrorDetails`.
  | "PLUGIN_NOT_ON_HOST"
  | "PLUGIN_INCOMPATIBLE"
  // The link to the window's host is down. For a mutation this is an unknown
  // outcome, not a failure: resolve it through the operation id.
  | "HOST_DISCONNECTED"
  | "OUTCOME_UNKNOWN"
  | "HOST_VERSION_MISMATCH"
  // An action that is inherently UI (focus a panel, open a dialog) was
  // dispatched with no frontend attached to the host.
  | "NO_FRONTEND_ATTACHED"
  // A channel reached a host over the link that has no host-side meaning.
  | "CHANNEL_NOT_REMOTABLE"
  // Another frontend holds the drive lease for this project.
  | "DRIVEN_ELSEWHERE"
  | "INTERNAL";
