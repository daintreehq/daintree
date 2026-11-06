import os from "node:os";
import path from "node:path";
import { buildCommandLaunchShell } from "../../ipc/handlers/terminal/commandLaunch.js";
import { runBoundedProcess, type BoundedProcessSlot } from "../boundedProcess.js";
import { getDefaultShell, waitForWindowsShell } from "../pty/terminalShell.js";
import type { ScheduledRunSkipReason } from "../../../shared/types/scheduledRuns.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pluralize } from "../../../shared/utils/pluralize.js";

/**
 * How long a schedule's precondition may run. Past it the occurrence is
 * skipped and the command's process tree killed, so a check that hangs never
 * holds up the schedule's later occurrences.
 */
export const SCHEDULE_PRECONDITION_TIMEOUT_MS = 60_000;

const WINDOWS_SHELL_WAIT_MS = 2_000;

export type PreconditionSkipReason = Extract<ScheduledRunSkipReason, { kind: "precondition" }>;

export interface PreconditionRequest {
  readonly command: string;
  /** The schedule's worktree, or the project's folder; never a fallback. */
  readonly cwd: string;
  readonly env: () => Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const active = new Set<BoundedProcessSlot>();
let disposed = false;

/**
 * The user's shell running `command` and exiting with its status. On POSIX
 * zsh and bash run it as a login shell, so what the profile sets up (PATH,
 * version managers) is there, but never an interactive one: nobody is at a
 * prompt to answer what an rc file asks, and an interactive shell ignores the
 * SIGTERM a timeout sends. Any other shell takes the command with `-c`. On
 * Windows it runs as a terminal's command launch runs one, in PowerShell or
 * cmd.
 */
export function preconditionInvocation(
  command: string,
  shell: string = getDefaultShell()
): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const built = buildCommandLaunchShell(command, shell, "exit");
    if (built) return { file: built.shell, args: built.args };
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const name = path.basename(shell).toLowerCase();
  const login = name === "zsh" || name === "bash";
  return { file: shell, args: login ? ["-l", "-c", command] : ["-c", command] };
}

function signalNumber(name: string | null): number | null {
  if (!name) return null;
  const value: unknown = Reflect.get(os.constants.signals, name);
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * Runs a schedule's precondition in its worktree (#15980). Resolves null when
 * it exited 0, so the run goes ahead; otherwise with the skip the history
 * records: the exit code, the signal that ended it, or why it didn't finish.
 * Its output is discarded, and neither the command nor its output is logged:
 * either can hold a secret.
 */
export async function runSchedulePrecondition(
  request: PreconditionRequest
): Promise<PreconditionSkipReason | null> {
  const skip = (fields: Partial<Omit<PreconditionSkipReason, "kind">>): PreconditionSkipReason => ({
    kind: "precondition",
    exitCode: null,
    signal: null,
    error: null,
    ...fields,
  });
  const timeoutMs = request.timeoutMs ?? SCHEDULE_PRECONDITION_TIMEOUT_MS;
  await waitForWindowsShell(WINDOWS_SHELL_WAIT_MS);
  if (disposed) return skip({ error: "Daintree was quitting." });
  if (request.signal?.aborted) return skip({ error: "Stopped before it finished." });

  const slot: BoundedProcessSlot = { abort: () => {}, abortNow: () => {} };
  active.add(slot);
  try {
    const outcome = await runBoundedProcess({
      command: "precondition",
      executable: preconditionInvocation(request.command),
      cwd: request.cwd,
      env: request.env,
      timeoutMs,
      maxOutputBytes: 0,
      label: "precondition",
      logPrefix: "[ScheduledRuns]",
      signal: request.signal,
      slot,
      createError: (message) => new Error(message),
    });
    if (outcome.timedOut) {
      return skip({
        error: `Timed out after ${pluralize(Math.round(timeoutMs / 1000), "second")}.`,
      });
    }
    if (outcome.aborted) return skip({ error: "Stopped before it finished." });
    const signal = signalNumber(outcome.signalName);
    if (signal !== null) return skip({ exitCode: outcome.exitCode, signal });
    if (outcome.exitCode === 0) return null;
    if (outcome.exitCode === null) return skip({ error: "It ended without an exit code." });
    return skip({ exitCode: outcome.exitCode });
  } catch (error) {
    return skip({ error: formatErrorMessage(error, "The precondition couldn't run.") });
  } finally {
    active.delete(slot);
  }
}

/**
 * Kills every precondition still running, at once, for quit: they run
 * detached in their own process groups, so nothing else would reap them.
 * Synchronous, like the project command and check services' dispose.
 */
export function disposeSchedulePreconditions(): void {
  disposed = true;
  for (const slot of active) {
    try {
      slot.abortNow();
    } catch (error) {
      console.warn("[ScheduledRuns] Couldn't stop a precondition at quit:", error);
    }
  }
  active.clear();
}

/** @internal Tests only. */
export function _resetSchedulePreconditionsForTest(): void {
  disposed = false;
  active.clear();
}
