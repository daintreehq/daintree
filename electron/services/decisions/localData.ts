import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resilientRename, resilientUnlink, syncParentDirectory } from "../../utils/fs.js";

/** The Decisions rows in the app database, as a deletion needs them. */
export interface DecisionsRows {
  /** Deletes every Decisions row in one transaction, or throws having deleted none. */
  erase(): void;
  /** Whether any Decisions row is stored. */
  exist(): boolean;
}

export interface LocalEraseDeps {
  keyFilePath: string;
  /**
   * The decision model's files (#16026): its history, the only place a
   * question or answer is kept in clear, and its evaluation. They go with the
   * rows, set aside and put back with the keys, whether or not learning is on.
   */
  modelFiles?: readonly string[];
  /** Opened only when there are rows to erase or to look for. */
  openRows: () => Promise<DecisionsRows>;
  /** Saves the setting without the relay's origin and ids; throws when it can't. */
  forgetIdentity: () => void;
}

/**
 * - `deleted`: the rows, the keys, the decision model's files and the relay
 *   record are gone.
 * - `failed`: nothing was deleted.
 * - `incomplete`: a step didn't finish. With `erased`, the rows are gone;
 *   with it false, nothing was deleted but files are still set aside; null
 *   when the rows couldn't be read to tell. The next deletion finishes or
 *   undoes it, and so does the next start whenever files were set aside.
 */
export type LocalEraseOutcome =
  | { result: "deleted" }
  | { result: "failed"; reason: "disk-pressure" | "storage" | "keys" | "model" }
  | { result: "incomplete"; erased: boolean | null };

/**
 * Where the keys, or one of the decision model's files, wait while the rows
 * are deleted. Its presence is the record that a deletion began, and whether
 * any row is left says how far it got: the rows go in one transaction, so
 * none left means it committed.
 */
export function erasingKeyFilePath(filePath: string): string {
  return `${filePath}.erasing`;
}

/** Every file a deletion sets aside: the keys first, then the decision model's. */
function erasedFiles(deps: LocalEraseDeps): string[] {
  return [deps.keyFilePath, ...(deps.modelFiles ?? [])];
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Removes the set-aside keys durably, so a crash can't bring them back after
 * a store has opened and written rows (which would read as a deletion that
 * never committed, and put them back).
 */
async function durableUnlinkIfPresent(path: string): Promise<void> {
  try {
    await resilientUnlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await syncParentDirectory(path);
}

/** Whether the rows are gone; null when they couldn't be read. */
async function rowsGone(deps: LocalEraseDeps): Promise<boolean | null> {
  try {
    return !(await deps.openRows()).exist();
  } catch {
    return null;
  }
}

/**
 * Makes an earlier removal in the keys' directory durable, in case the last
 * deletion's sync after removing its set-aside keys failed. A directory not
 * made yet has nothing to sync.
 */
async function syncKeyDirectory(keyFilePath: string): Promise<void> {
  try {
    await syncParentDirectory(keyFilePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** The store's own refusal while disk space is critical; anything else is the database's. */
function eraseRefusal(error: unknown): "disk-pressure" | "storage" {
  const refusal = error as { name?: unknown; reason?: unknown } | null;
  return refusal?.name === "DecisionsStoreUnavailableError" && refusal.reason === "disk-pressure"
    ? "disk-pressure"
    : "storage";
}

/**
 * What finishing a deletion that stopped partway did: `none` when there was
 * none (or only keys a later setup superseded), `restored` when it never
 * committed and the keys went back, `finished` when it had committed and the
 * keys and the relay record went too.
 */
export type EraseRecovery = "none" | "restored" | "finished";

/**
 * Finishes a deletion that stopped partway: quit or a crash mid-way, or a
 * last step that failed. Rows still stored mean their transaction never
 * committed, so nothing was deleted and the keys and the decision model's
 * files go back. No rows mean it committed, so the relay record and those
 * files go too. A file written since (new keys sealed by a new setup) means
 * the one set aside was already given up. Run before the store opens, since a
 * row written after the deletion would read as one it never reached; a
 * failure here must leave the store closed for that reason.
 */
export async function finishInterruptedErase(deps: LocalEraseDeps): Promise<EraseRecovery> {
  const pending: string[] = [];
  for (const file of erasedFiles(deps)) {
    const aside = erasingKeyFilePath(file);
    if (!(await exists(aside))) continue;
    // Written since (new keys sealed): what was set aside was already given up.
    if (await exists(file)) await durableUnlinkIfPresent(aside);
    else pending.push(file);
  }
  if (pending.length === 0) {
    await syncKeyDirectory(deps.keyFilePath);
    return "none";
  }
  const rows = await deps.openRows();
  if (rows.exist()) {
    // Not synced: a move back lost to a crash is made again, since the rows are still there.
    for (const file of pending) await resilientRename(erasingKeyFilePath(file), file);
    return "restored";
  }
  deps.forgetIdentity();
  for (const file of pending) await durableUnlinkIfPresent(erasingKeyFilePath(file));
  return "finished";
}

/**
 * Deletes this computer's Decisions data (#16025): every stored row, the key
 * file, the decision model's files and the relay's origin and ids in the
 * setting. Run with the store, the key store and the model's history closed,
 * so nothing queued writes a row back or reads the keys meanwhile. Never asks
 * the keychain, and sends nothing anywhere.
 *
 * The keys and the decision model's files are moved aside first, durably,
 * then the rows deleted in one transaction: a failure before that commits
 * puts them back, so nothing changed. Once it has committed, the relay record
 * and the set-aside files follow, and a failure there leaves the rest to
 * `finishInterruptedErase`. An earlier deletion still unresolved comes first, and while it can't be
 * resolved the outcome is `incomplete`, so the store stays closed.
 */
export async function eraseLocalDecisionsData(deps: LocalEraseDeps): Promise<LocalEraseOutcome> {
  let recovery: EraseRecovery;
  try {
    recovery = await finishInterruptedErase(deps);
  } catch {
    // An earlier deletion is still unresolved, so the store stays closed.
    return { result: "incomplete", erased: await rowsGone(deps) };
  }
  // An earlier deletion that had committed is now whole: nothing is left to delete.
  if (recovery === "finished") return { result: "deleted" };
  const setAside: string[] = [];
  const putBack = async (
    reason: "disk-pressure" | "storage" | "keys" | "model"
  ): Promise<LocalEraseOutcome> => {
    try {
      for (const file of setAside) await resilientRename(erasingKeyFilePath(file), file);
    } catch {
      return { result: "incomplete", erased: false };
    }
    return { result: "failed", reason };
  };
  for (const file of erasedFiles(deps)) {
    try {
      await resilientRename(file, erasingKeyFilePath(file));
      setAside.push(file);
    } catch (error) {
      if (!isMissing(error)) return putBack(file === deps.keyFilePath ? "keys" : "model");
    }
  }
  // Durable before the rows go: a crash must never keep their deletion and lose its marker.
  const byDirectory = new Map<string, string>();
  for (const file of setAside) {
    if (!byDirectory.has(dirname(file))) byDirectory.set(dirname(file), erasingKeyFilePath(file));
  }
  try {
    for (const aside of byDirectory.values()) await syncParentDirectory(aside);
  } catch {
    return putBack(setAside.includes(deps.keyFilePath) ? "keys" : "model");
  }
  try {
    (await deps.openRows()).erase();
  } catch (error) {
    return putBack(eraseRefusal(error));
  }
  try {
    deps.forgetIdentity();
    for (const file of setAside) await durableUnlinkIfPresent(erasingKeyFilePath(file));
  } catch {
    return { result: "incomplete", erased: true };
  }
  return { result: "deleted" };
}
