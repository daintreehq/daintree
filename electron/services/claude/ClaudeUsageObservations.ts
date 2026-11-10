import { realpath } from "node:fs/promises";
import {
  CLAUDE_USAGE_WINDOWS,
  type ClaudeUsageObservation,
  type ClaudeUsageWindow,
} from "../../../shared/types/ipc/agentQuota.js";

/**
 * A reading with the Claude Code config folder of the pane that showed it:
 * which account it is for (#16370), in {@link canonicalClaudeConfigDir}'s
 * form as of when it showed. Null when the pane's launch env named a folder
 * that can't be resolved, which is never taken for any account's. Main's
 * alone: the folder never reaches a renderer or an MCP caller.
 */
export interface ClaudeUsageRecord extends ClaudeUsageObservation {
  configDir: string | null;
  /** The shell the pane started, as the pty host named it; null when unknown. */
  shell: string | null;
}

/**
 * The latest Claude Code usage message seen per config folder, shell and limit
 * on this machine (#15727, #16370), from every pane on every pty host. The
 * shell is part of the key because it decides whether the folder is certain:
 * a reading that is couldn't be replaced by one that isn't. Kept for the app's
 * life and never aged out: a reading whose reset has passed is still what a
 * pane showed, and its own times say how old it is. Keys keep the order they
 * were first seen in.
 */
const latest = new Map<string, Map<ClaudeUsageWindow, ClaudeUsageRecord>>();

function sourceKey(record: ClaudeUsageRecord): string {
  return JSON.stringify([record.configDir, record.shell]);
}
let generation = 0;

// Windows paths are case-insensitive, so two spellings of one folder share a key.
function folderIdentity(dir: string): string {
  return process.platform === "win32" ? dir.toLowerCase() : dir;
}

/**
 * One key per folder however it's spelled. The promise `realpath` resolves
 * symlinks and returns the on-disk case on a case-insensitive volume; a folder
 * it can't resolve keeps its spelling. Never rejects.
 */
export async function canonicalClaudeConfigDir(dir: string): Promise<string> {
  try {
    return folderIdentity(await realpath(dir));
  } catch {
    return folderIdentity(dir);
  }
}

/**
 * Record a pane's reading under its folder as the folder is now, so a link
 * later pointed elsewhere doesn't carry this reading to another login.
 */
export async function observeClaudeUsage(
  record: ClaudeUsageRecord,
  canonical: (dir: string) => Promise<string> = canonicalClaudeConfigDir
): Promise<void> {
  const startedIn = generation;
  const configDir = record.configDir === null ? null : await canonical(record.configDir);
  // A clear while the folder resolved drops this reading with the rest.
  if (startedIn !== generation) return;
  recordClaudeUsageObservation({ ...record, configDir });
}

export function recordClaudeUsageObservation(record: ClaudeUsageRecord): void {
  const key = sourceKey(record);
  let byWindow = latest.get(key);
  if (byWindow === undefined) {
    byWindow = new Map();
    latest.set(key, byWindow);
  }
  const current = byWindow.get(record.window);
  // Shards report independently, so an older sighting can arrive second.
  if (current !== undefined && current.observedAt > record.observedAt) return;
  byWindow.set(record.window, { ...record });
}

/**
 * The latest reading per config folder, shell and limit: sources in the order
 * first seen, limits in {@link CLAUDE_USAGE_WINDOWS} order within each.
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
  generation++;
  latest.clear();
}
