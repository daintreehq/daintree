/**
 * Canonical list of named loggers used by the UI picker.
 *
 * Loggers self-register at import time via `createLogger(name)`, but that
 * registry lives inside each process and can't be enumerated across process
 * boundaries cheaply. For the "Set Log Level…" UI we need a stable, static
 * catalog — this file is the source of truth.
 *
 * Format: `"<process>:<Module>"`. Process is one of `main`, `pty-host`,
 * `workspace-host`. `"<process>:*"` entries match every logger in that
 * process; `"*"` is the global wildcard (equivalent to the legacy verbose
 * toggle).
 *
 * Add an entry here whenever you introduce a `createLogger(...)` call with a
 * new stable name that should surface in the UI.
 */

export const WILDCARD_ALL = "*" as const;

/**
 * Per-process wildcards. Setting one of these propagates to every logger in
 * that process, which is useful when you don't yet know which module emits
 * the chatter you're trying to silence.
 */
export const WILDCARD_GROUPS = ["main:*", "pty-host:*", "workspace-host:*"] as const;

/**
 * Known specific loggers. Keep alphabetized within each process group.
 * This list can lag the code — the UI also shows any runtime-registered name
 * returned by `logs:get-registry` that isn't in this manifest.
 */
export const KNOWN_LOGGER_NAMES = [
  // Main process
  "main:default",
  "main:Main",
  "main:IPC",
  "main:PtyClient",
  "main:WorkspaceHostProcess",

  // Pty host utility process
  "pty-host:default",
  "pty-host:PtyManager",
  "pty-host:PtyHost",

  // Workspace host utility process
  "workspace-host:default",
  "workspace-host:WorktreeMonitor",
  "workspace-host:WorkspaceService",
] as const;

export const LOGGER_NAMES: readonly string[] = [
  WILDCARD_ALL,
  ...WILDCARD_GROUPS,
  ...KNOWN_LOGGER_NAMES,
];

export type KnownLoggerName = (typeof KNOWN_LOGGER_NAMES)[number];
