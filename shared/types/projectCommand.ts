/**
 * Contract for `project.runCommand` (#13495) — one non-interactive shell
 * command run on the host, in a project root or one of its worktrees, standing
 * in for the shell a hub assistant has no access to over a relay.
 *
 * `project.runCheck` stays the tool for a project's own declared runners. This
 * one takes a command, so it is held to Daintree's own full-tier assistants;
 * the restriction lives where the call is answered, not in this type.
 */

import {
  PROJECT_CHECK_DEFAULT_TIMEOUT_MS,
  PROJECT_CHECK_MAX_OUTPUT_BYTES,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
} from "./projectCheck.js";

/** Same bounds as a check: a test suite is the longest thing either runs. */
export const PROJECT_COMMAND_DEFAULT_TIMEOUT_MS = PROJECT_CHECK_DEFAULT_TIMEOUT_MS;
export const PROJECT_COMMAND_MIN_TIMEOUT_MS = PROJECT_CHECK_MIN_TIMEOUT_MS;
export const PROJECT_COMMAND_MAX_TIMEOUT_MS = PROJECT_CHECK_MAX_TIMEOUT_MS;
export const PROJECT_COMMAND_MAX_OUTPUT_BYTES = PROJECT_CHECK_MAX_OUTPUT_BYTES;

/** Longest command text accepted, in characters. A script belongs in a file. */
export const PROJECT_COMMAND_MAX_LENGTH = 8_192;

/**
 * Commands running at once across the whole host. Several may share a
 * directory — `git status` while `npm test` runs is the ordinary loop — so the
 * bound is on the host, and an excess call is refused rather than queued.
 */
export const PROJECT_COMMAND_MAX_CONCURRENT = 4;

export interface ProjectCommandRunArgs {
  projectId: string;
  command: string;
  /** The project root or one of its registered worktrees. Defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Outcome of a command that started. A non-zero exit, a timeout and a
 * cancellation are results; a command that could not start throws instead.
 * There is deliberately no `passed`: an exit code says how a command ended,
 * not whether the work it checked is right.
 */
export interface ProjectCommandRunResult {
  projectId: string;
  /** Canonicalized absolute path the command started in. */
  cwd: string;
  exitCode: number | null;
  signalName: string | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Combined stdout and stderr, secrets scrubbed, tail kept when capped. */
  output: string;
  outputTruncated: boolean;
}
