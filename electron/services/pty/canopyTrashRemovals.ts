import type { AgentSessionTerminal } from "../../../shared/types/ipc/agentSessionHistory.js";

/** Long past any close's capture: a graceful quit, the branch lookup and the queued write. */
const REMOVAL_HOLD_MS = 120_000;
const MAX_REMOVALS = 200;

/** Runs removed from Canopy's Trash before their close was journaled, by incarnation, until when. */
const removals = new Map<string, number>();

function keyOf(terminal: AgentSessionTerminal): string {
  return `${terminal.id}#${terminal.spawnedAt}`;
}

function prune(now: number): void {
  for (const [key, until] of removals) {
    if (until <= now) removals.delete(key);
  }
}

/**
 * The user removed a run from Canopy's Trash while its process was still
 * ending: the close that journals it is born removed, so the run never comes
 * back as an ended row, even across a quit that lands its record.
 */
export function noteCanopyTrashRemoval(terminal: AgentSessionTerminal, now = Date.now()): void {
  prune(now);
  removals.delete(keyOf(terminal));
  removals.set(keyOf(terminal), now + REMOVAL_HOLD_MS);
  while (removals.size > MAX_REMOVALS) {
    const oldest = removals.keys().next().value;
    if (oldest === undefined) break;
    removals.delete(oldest);
  }
}

/** Whether the user removed this run from Canopy's Trash while it was ending. */
export function hasCanopyTrashRemoval(terminal: AgentSessionTerminal, now = Date.now()): boolean {
  const until = removals.get(keyOf(terminal));
  return until !== undefined && until > now;
}

export function resetCanopyTrashRemovalsForTests(): void {
  removals.clear();
}
