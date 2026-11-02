import {
  CLAUDE_USAGE_WINDOWS,
  type ClaudeUsageObservation,
  type ClaudeUsageWindow,
} from "../../../shared/types/ipc/agentQuota.js";

/**
 * The latest Claude Code usage message seen per limit on this machine
 * (#15727), from every pane on every pty host. Kept for the app's life and
 * never aged out: a reading whose reset has passed is still what a pane
 * showed, and its own times say how old it is.
 */
const latest = new Map<ClaudeUsageWindow, ClaudeUsageObservation>();

export function recordClaudeUsageObservation(observation: ClaudeUsageObservation): void {
  const current = latest.get(observation.window);
  // Shards report independently, so an older sighting can arrive second.
  if (current !== undefined && current.observedAt > observation.observedAt) return;
  latest.set(observation.window, { ...observation });
}

/** The latest reading per limit, in {@link CLAUDE_USAGE_WINDOWS} order. */
export function readClaudeUsageObservations(): ClaudeUsageObservation[] {
  return CLAUDE_USAGE_WINDOWS.flatMap((window) => {
    const observation = latest.get(window);
    return observation === undefined ? [] : [{ ...observation }];
  });
}

export function clearClaudeUsageObservations(): void {
  latest.clear();
}
