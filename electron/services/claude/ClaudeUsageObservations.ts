import { realpath } from "node:fs/promises";
import {
  CLAUDE_USAGE_WINDOWS,
  type ClaudeUsageObservation,
  type ClaudeUsageWindow,
} from "../../../shared/types/ipc/agentQuota.js";
import {
  getShellEnvironmentObservation,
  subscribeShellEnvironment,
  type ShellEnvironmentObservation,
} from "../../setup/shellEnvironmentObservation.js";
import { logError } from "../../utils/logger.js";
import {
  isCurrentClaudeUsageReading,
  isRestorableClaudeUsageReading,
  parseClaudeUsageDocument,
  serializeClaudeUsageDocument,
  type SavedClaudeUsageReading,
} from "./claudeUsageDocument.js";
import {
  placeClaudeUsageRecord,
  readClaudeUsageProfile,
  type ClaudeUsageProfile,
} from "./claudeUsagePlacement.js";

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
  /**
   * Only on a reading an earlier launch saved (#17610): the folder that launch
   * decided it was for, or null when it couldn't tell. Present means settled,
   * so it is checked with `!== undefined`, never `??`.
   */
  savedIdentity?: string | null;
}

/** Where the readings are kept between launches: one document, read and written whole. */
export interface ClaudeUsageStorage {
  read(): string | null;
  write(value: string): void;
}

/**
 * The latest Claude Code usage message seen per config folder, shell and limit
 * on this machine (#15727, #16370), from every pane on every pty host. The
 * shell is part of the key because it decides whether the folder is certain:
 * a reading that is couldn't be replaced by one that isn't. An earlier
 * launch's readings sit under keys of their own, by the folder that launch
 * settled on, so a sighting this launch can't place never replaces one it
 * could. A reading whose reset has passed is still what a pane showed, and its
 * own times say how old it is; one that named no reset goes stale after a
 * week. Keys keep the order they were first seen in.
 */
const latest = new Map<string, Map<ClaudeUsageWindow, ClaudeUsageRecord>>();

function sourceKey(record: ClaudeUsageRecord): string {
  return record.savedIdentity !== undefined
    ? JSON.stringify(["saved", record.savedIdentity])
    : JSON.stringify(["live", record.configDir, record.shell]);
}
let generation = 0;

interface Persistence {
  storage: ClaudeUsageStorage;
  now: () => number;
  readProfile: () => Promise<ClaudeUsageProfile>;
  unsubscribe: () => void;
}

/** Null until {@link restoreClaudeUsageObservations}: until then nothing is saved. */
let persistence: Persistence | null = null;
let saveQueued = false;
let saves: Promise<void> = Promise.resolve();

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

/** Keeps `record` unless its source already holds a newer sighting of the limit. */
function keep(record: ClaudeUsageRecord): boolean {
  const key = sourceKey(record);
  let byWindow = latest.get(key);
  if (byWindow === undefined) {
    byWindow = new Map();
    latest.set(key, byWindow);
  }
  const current = byWindow.get(record.window);
  // Shards report independently, so an older sighting can arrive second.
  if (current !== undefined && current.observedAt > record.observedAt) return false;
  byWindow.set(record.window, { ...record });
  return true;
}

export function recordClaudeUsageObservation(record: ClaudeUsageRecord): void {
  if (keep(record)) queueSave();
}

function hasLiveRecords(): boolean {
  for (const byWindow of latest.values()) {
    for (const record of byWindow.values()) {
      if (record.savedIdentity === undefined) return true;
    }
  }
  return false;
}

/**
 * Each folder's newest current reading per limit, with this launch's own
 * readings placed by the probe as it is now: what Settings would show.
 */
function snapshot(profile: ClaudeUsageProfile, now: number): SavedClaudeUsageReading[] {
  const newest = new Map<string, SavedClaudeUsageReading>();
  for (const byWindow of latest.values()) {
    for (const record of byWindow.values()) {
      if (!isCurrentClaudeUsageReading(record, now)) continue;
      const identity =
        record.savedIdentity !== undefined
          ? record.savedIdentity
          : placeClaudeUsageRecord(record, profile);
      const key = JSON.stringify([identity, record.window]);
      const kept = newest.get(key);
      if (kept === undefined || record.observedAt > kept.observedAt) {
        const { window, statement, usedPercent, resetsAt, terminalId, observedAt } = record;
        newest.set(key, {
          window,
          statement,
          usedPercent,
          resetsAt,
          terminalId,
          observedAt,
          identity,
        });
      }
    }
  }
  return [...newest.values()].filter((reading) => isRestorableClaudeUsageReading(reading, now));
}

async function save(target: Persistence): Promise<void> {
  if (persistence !== target) return;
  // A change from here on queues the next save, which reads it afresh.
  saveQueued = false;
  const profile = await target.readProfile();
  // A clear while the profile resolved stops saving altogether.
  if (persistence !== target) return;
  target.storage.write(serializeClaudeUsageDocument(snapshot(profile, target.now())));
}

/**
 * One save at a time, each of the whole store: a burst of readings queues one
 * write, and a reading that lands during a write queues the next.
 */
function queueSave(): void {
  const target = persistence;
  if (target === null || saveQueued) return;
  saveQueued = true;
  saves = saves
    .then(() => save(target))
    .catch((error: unknown) => {
      logError("Couldn't save the Claude usage readings", error);
    });
}

export interface RestoreClaudeUsageOptions {
  now?: () => number;
  readShellObservation?: () => ShellEnvironmentObservation | undefined;
  canonicalKey?: (dir: string) => Promise<string>;
}

/**
 * Bring back the readings an earlier launch saved, minus those whose reset
 * has passed or that named none and are over a week old, then save on every
 * change from here on (#17610). Once per launch, before panes report or
 * anything reads.
 */
export function restoreClaudeUsageObservations(
  storage: ClaudeUsageStorage,
  options: RestoreClaudeUsageOptions = {}
): void {
  if (persistence !== null) return;
  const now = options.now ?? Date.now;
  let saved: SavedClaudeUsageReading[];
  try {
    saved = parseClaudeUsageDocument(storage.read(), now());
  } catch (error) {
    // Never written either: a save would replace what couldn't be read.
    logError("Couldn't read the saved Claude usage readings", error);
    return;
  }
  for (const { identity, ...observation } of saved) {
    keep({ ...observation, configDir: identity, shell: null, savedIdentity: identity });
  }
  const readShellObservation = options.readShellObservation ?? getShellEnvironmentObservation;
  const canonicalKey = options.canonicalKey ?? canonicalClaudeConfigDir;
  persistence = {
    storage,
    now,
    readProfile: () => readClaudeUsageProfile(readShellObservation(), canonicalKey),
    // A probe answering late can move this launch's readings; the saved copy follows.
    unsubscribe: subscribeShellEnvironment(() => {
      if (hasLiveRecords()) queueSave();
    }),
  };
  // Readings that showed before the store opened.
  if (hasLiveRecords()) queueSave();
}

/**
 * The latest current reading per config folder, shell and limit: sources in
 * the order first seen, limits in {@link CLAUDE_USAGE_WINDOWS} order within each.
 */
export function readClaudeUsageRecords(): ClaudeUsageRecord[] {
  const now = Date.now();
  return [...latest.values()].flatMap((byWindow) =>
    CLAUDE_USAGE_WINDOWS.flatMap((window) => {
      const record = byWindow.get(window);
      return record === undefined || !isCurrentClaudeUsageReading(record, now)
        ? []
        : [{ ...record }];
    })
  );
}

/**
 * The latest current reading per limit across every folder, for
 * `agent.readQuota`: its contract is one reading per limit, and it never
 * carries a folder.
 */
export function readClaudeUsageObservations(): ClaudeUsageObservation[] {
  const now = Date.now();
  const newest = new Map<ClaudeUsageWindow, ClaudeUsageRecord>();
  for (const byWindow of latest.values()) {
    for (const [window, record] of byWindow) {
      if (!isCurrentClaudeUsageReading(record, now)) continue;
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

/** Forget every reading and stop saving, saved copy untouched: for tests. */
export function clearClaudeUsageObservations(): void {
  generation++;
  latest.clear();
  persistence?.unsubscribe();
  persistence = null;
  saveQueued = false;
}
