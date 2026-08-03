/**
 * Contract for `project.runCheck` (#11548) — running one of a project's
 * detected runners as a real child process and reporting its authoritative
 * exit code.
 *
 * This exists because the only pre-existing signal an agent could read was
 * `TerminalCheckResult`, a best-effort parse of PTY scrollback. A parsed
 * "looks like it passed" string is not an exit code, so it cannot gate a
 * merge, a handoff, or a retry. Everything here is derived from the child's
 * `close` event instead.
 */

/** Wall-clock ceiling applied when the caller passes no `timeoutMs`. */
export const PROJECT_CHECK_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Lower bound for a caller-supplied `timeoutMs`. */
export const PROJECT_CHECK_MIN_TIMEOUT_MS = 1_000;

/**
 * Upper bound for a caller-supplied `timeoutMs`. One hour comfortably covers a
 * full test suite or a release build while still guaranteeing that a runner
 * pointed at a dev server (the detector surfaces those too) eventually settles
 * instead of pinning a tool call open forever.
 */
export const PROJECT_CHECK_MAX_TIMEOUT_MS = 60 * 60_000;

/**
 * Byte cap on the captured output tail. Mirrors `RESOURCE_TEXT_MAX_BYTES` in
 * the MCP server so a check result and an MCP resource truncate at the same
 * size, and keeps the payload far below the point where clients start
 * truncating tool responses themselves.
 */
export const PROJECT_CHECK_MAX_OUTPUT_BYTES = 50 * 1024;

/** Resolved input for a single check run. */
export interface ProjectCheckRunArgs {
  /** Project whose detected runners are eligible. From `project.getAll`. */
  projectId: string;
  /** `RunCommand.id` from `project.detectRunners`. */
  runnerId: string;
  /**
   * Working directory. Defaults to the project root; when supplied it must be
   * the project root or one of the repo's registered worktrees. Never an
   * arbitrary caller-chosen path.
   */
  cwd?: string;
  /** Wall-clock ceiling in ms. Clamped to the MIN/MAX bounds above. */
  timeoutMs?: number;
}

/**
 * Outcome of a check that actually started. A non-zero exit, a timeout, and a
 * cancellation are all *results* — the run happened and we know how it ended.
 * Failures to start at all (unknown project/runner, unusable cwd, spawn error)
 * throw instead, so an agent can never mistake "could not run" for "failed".
 */
export interface ProjectCheckRunResult {
  projectId: string;
  /** Canonicalized absolute path the command ran in. */
  cwd: string;
  runnerId: string;
  /** Human-readable runner name, e.g. "test" or "lint". */
  runnerName: string;
  /**
   * The shell command that ran. Echoed back so a caller can reproduce the run
   * in a visible terminal when the captured tail isn't enough to diagnose it.
   * Not a disclosure: `project.detectRunners` already returns these verbatim.
   */
  command: string;
  /** True only on a clean exit code 0 that neither timed out nor was aborted. */
  passed: boolean;
  /**
   * Exit code as reported by the child's `close` event — or by `exit` when a
   * descendant held the pipe open past the drain window. Null when the process
   * died on a signal, or when a failed kill forced settlement with no event.
   */
  exitCode: number | null;
  /** OS signal name when killed, else null. */
  signalName: string | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /**
   * Tail of the combined stdout/stderr, secret-scrubbed. The tail is kept
   * rather than the head because runners put the summary — failure counts,
   * the first failing assertion's context, the totals line — at the end.
   */
  output: string;
  /** True when output exceeded the cap and earlier bytes were dropped. */
  outputTruncated: boolean;
}
