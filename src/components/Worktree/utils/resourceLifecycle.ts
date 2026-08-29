/**
 * How to read a worktree's reported remote-resource status.
 *
 * Shared by the card's inline resource controls and the worktree menu's
 * Runtime → Environment section so the two can't disagree about whether an
 * environment is resumable or pausable.
 *
 * `lastStatus` is free-form text captured from the project's own status
 * command, so the token set below is a best-effort reading of it, never an
 * authority. `isRecognized` is what says so: a project whose status command
 * prints `healthy` or `up` matches nothing here, and a caller that would
 * otherwise hide a configured command has to fail open on it rather than
 * leave the user with no way to run something they configured.
 */
export interface ResourceLifecycleVisibility {
  showResume: boolean;
  showPause: boolean;
  showConnect: boolean;
  /** False when the status was absent or matched no known token. */
  isRecognized: boolean;
}

const PAUSED_LIKE = new Set(["paused", "stopped", "unknown", "terminated", "down"]);
const RUNNING_LIKE = new Set(["running", "starting"]);

export function resourceLifecycleVisibility(
  resourceStatus: string | undefined
): ResourceLifecycleVisibility {
  const status = resourceStatus?.toLowerCase();
  const isPausedLike = status !== undefined && PAUSED_LIKE.has(status);
  const isRunningLike = status !== undefined && RUNNING_LIKE.has(status);
  return {
    // No status yet reads as "not up", which is what the inline controls have
    // always assumed — the first thing you do to an unprovisioned environment
    // is resume it.
    showResume: !status || isPausedLike,
    showPause: isRunningLike,
    showConnect: status === "running",
    isRecognized: isPausedLike || isRunningLike,
  };
}
