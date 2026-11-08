import {
  CLAUDE_USAGE_WINDOWS,
  type ClaudeUsageObservation,
  type ClaudeUsageWindow,
} from "../../../shared/types/ipc/agentQuota.js";

/**
 * A reading with the Claude Code config folder of the pane that showed it:
 * which account it is for (#16370). Null when the pane's launch env named a
 * folder that can't be resolved, which is never taken for any account's.
 * Main's alone: the folder never reaches a renderer or an MCP caller.
 */
export interface ClaudeUsageRecord extends ClaudeUsageObservation {
  configDir: string | null;
}

/**
 * The latest Claude Code usage message seen per config folder and limit on
 * this machine (#15727, #16370), from every pane on every pty host. Kept for
 * the app's life and never aged out: a reading whose reset has passed is still
 * what a pane showed, and its own times say how old it is. Folders keep the
 * order they were first seen in.
 */
const latest = new Map<string | null, Map<ClaudeUsageWindow, ClaudeUsageRecord>>();

export function recordClaudeUsageObservation(record: ClaudeUsageRecord): void {
  let byWindow = latest.get(record.configDir);
  if (byWindow === undefined) {
    byWindow = new Map();
    latest.set(record.configDir, byWindow);
  }
  const current = byWindow.get(record.window);
  // Shards report independently, so an older sighting can arrive second.
  if (current !== undefined && current.observedAt > record.observedAt) return;
  byWindow.set(record.window, { ...record });
}

/**
 * The latest reading per config folder and limit: folders in the order first
 * seen, limits in {@link CLAUDE_USAGE_WINDOWS} order within each.
 */
export function readClaudeUsageRecords(): ClaudeUsageRecord[] {
  return [...latest.values()].flatMap((byWindow) =>
    CLAUDE_USAGE_WINDOWS.flatMap((window) => {
      const record = byWindow.get(window);
      return record === undefined ? [] : [{ ...record }];
    })
  );
}

/**
 * The latest reading per limit across every folder, for `agent.readQuota`:
 * its contract is one reading per limit, and it never carries a folder.
 */
export function readClaudeUsageObservations(): ClaudeUsageObservation[] {
  const newest = new Map<ClaudeUsageWindow, ClaudeUsageRecord>();
  for (const byWindow of latest.values()) {
    for (const [window, record] of byWindow) {
      const current = newest.get(window);
      if (current === undefined || record.observedAt > current.observedAt) {
        newest.set(window, record);
      }
    }
  }
  return CLAUDE_USAGE_WINDOWS.flatMap((window) => {
    const record = newest.get(window);
    if (record === undefined) return [];
    const { terminalId, statement, usedPercent, resetsAt, observedAt } = record;
    return [{ window, statement, usedPercent, resetsAt, terminalId, observedAt }];
  });
}

export function clearClaudeUsageObservations(): void {
  latest.clear();
}
