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
  exportedClaudeConfigDir,
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
 * settled on and the pane's own, so a sighting this launch can't place never
 * replaces one it could. A reading whose reset has passed is still what a pane showed, and its
 * own times say how old it is; one that named no reset goes stale after a
 * week. Keys keep the order they were first seen in.
 */
const latest = new Map<string, Map<ClaudeUsageWindow, ClaudeUsageRecord>>();

function sourceKey(record: ClaudeUsageRecord): string {
  return record.savedIdentity !== undefined
    ? JSON.stringify(["saved", record.savedIdentity, record.configDir])
    : JSON.stringify(["live", record.configDir, record.shell]);
}
let generation = 0;

interface Persistence {
  storage: ClaudeUsageStorage;
  now: () => number;
  readProfile: () => Promise<ClaudeUsageProfile>;
  /** The profile with no filesystem call, for quit; see {@link sealClaudeUsageObservations}. */
  readProfileNow: () => ClaudeUsageProfile;
  unsubscribe: () => void;
  /** Counts every change to what a save would write. */
  changes: number;
  /** {@link changes} as of the last save that landed. */
  saved: number;
}

/** Null until {@link restoreClaudeUsageObservations}: until then nothing is saved. */
let persistence: Persistence | null = null;
/** Set at quit: from then on nothing is restored or saved. */
let sealed = false;
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
  if (keep(record)) markChanged();
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
 * The newest current reading per placed folder, pane folder and limit, with
 * this launch's own readings placed by the probe as it is now. A placed
 * folder's pane folder is the same folder; readings no launch could place
 * stay apart by theirs, since one may outlive another's reset.
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
      const key = JSON.stringify([identity, record.configDir, record.window]);
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
          configDir: record.configDir,
        });
      }
    }
  }
  return [...newest.values()].filter((reading) => isRestorableClaudeUsageReading(reading, now));
}

/** Saves the whole store, crediting only the changes made by `through`. */
function write(target: Persistence, profile: ClaudeUsageProfile, through: number): void {
  target.storage.write(serializeClaudeUsageDocument(snapshot(profile, target.now())));
  target.saved = through;
}

async function save(target: Persistence): Promise<void> {
  if (persistence !== target) return;
  // A change from here on queues the next save, which reads it afresh.
  saveQueued = false;
  // Counted before the profile resolves: a probe change while it does is one
  // this save didn't place by, so it stays owed.
  const through = target.changes;
  const profile = await target.readProfile();
  // A clear or seal while the profile resolved stops this save.
  if (persistence !== target) return;
  write(target, profile, through);
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

function markChanged(): void {
  if (persistence === null) return;
  persistence.changes++;
  queueSave();
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
  if (sealed || persistence !== null) return;
  const now = options.now ?? Date.now;
  let saved: SavedClaudeUsageReading[];
  try {
    saved = parseClaudeUsageDocument(storage.read(), now());
  } catch (error) {
    // Never written either: a save would replace what couldn't be read.
    logError("Couldn't read the saved Claude usage readings", error);
    return;
  }
  for (const { identity, ...rest } of saved) {
    keep({ ...rest, shell: null, savedIdentity: identity });
  }
  const readShellObservation = options.readShellObservation ?? getShellEnvironmentObservation;
  const canonicalKey = options.canonicalKey ?? canonicalClaudeConfigDir;
  let resolved: ClaudeUsageProfile | null = null;
  persistence = {
    storage,
    now,
    readProfile: async () => {
      resolved = await readClaudeUsageProfile(readShellObservation(), canonicalKey);
      return resolved;
    },
    readProfileNow: () => {
      const observation = readShellObservation();
      const dir = exportedClaudeConfigDir(observation);
      const shell = observation?.shell;
      // No export, or one that can't be resolved: nothing to look up.
      if (!dir) return { dir, identity: dir, shell };
      // The export the last save resolved, however often the probe repeats it.
      if (resolved !== null && resolved.dir === dir && resolved.shell === shell) return resolved;
      // An export not yet resolved: no pane in the probed shell is certain to
      // be on its folder, as with one that can't be resolved at all.
      return { dir, identity: null, shell };
    },
    // A probe answering late can move this launch's readings; the saved copy follows.
    unsubscribe: subscribeShellEnvironment(() => {
      if (hasLiveRecords()) markChanged();
    }),
    changes: 0,
    saved: 0,
  };
  // Readings that showed before the store opened.
  if (hasLiveRecords()) markChanged();
}

/**
 * For quit, before the database closes: stop saving, then write once more,
 * synchronously and with no filesystem call, if anything changed since the
 * last save that landed, so a save still resolving the profile, or one that
 * failed, isn't lost. Nothing is restored or saved after.
 */
export function sealClaudeUsageObservations(): void {
  sealed = true;
  const target = persistence;
  if (target === null) return;
  target.unsubscribe();
  persistence = null;
  saveQueued = false;
  if (target.changes === target.saved) return;
  try {
    write(target, target.readProfileNow(), target.changes);
  } catch (error) {
    logError("Couldn't save the Claude usage readings at quit", error);
  }
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
  sealed = false;
  saveQueued = false;
}
