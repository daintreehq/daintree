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
 * none (or keys a later setup superseded), `restored` when it never
 * committed and what was set aside went back, `finished` when it had
 * committed and the set-aside files and the relay record went too.
 */
export type EraseRecovery = "none" | "restored" | "finished";

/**
 * Finishes a deletion that stopped partway: quit or a crash mid-way, or a
 * last step that failed. Rows still stored mean their transaction never
 * committed, so nothing was deleted and what was set aside goes back. No rows
 * mean it committed, so the relay record and the set-aside files go too, and
 * so does any of the decision model's files a crash stopped short of moving:
 * nothing can have written one since, because nothing opens them until this
 * has run. Keys sealed since (a new setup) mean the deletion was given up:
 * the relay record is the new one's and stays, and the outcome is `none`, so
 * a deletion asked for now deletes what is there. Run before the store opens,
 * since a row written after the deletion would read as one it never reached;
 * a failure here must leave the store closed for that reason.
 */
export async function finishInterruptedErase(deps: LocalEraseDeps): Promise<EraseRecovery> {
  const pending: string[] = [];
  // The keys' marker, when new keys were sealed beside it: kept until the rest
  // is done, since it is the only record that the relay record is the new one's.
  let superseded: string | null = null;
  for (const file of erasedFiles(deps)) {
    const aside = erasingKeyFilePath(file);
    if (!(await exists(aside))) continue;
    if (!(await exists(file))) pending.push(file);
    else if (file === deps.keyFilePath) superseded = aside;
    else await durableUnlinkIfPresent(aside);
  }
  if (pending.length === 0) {
    if (superseded !== null) await durableUnlinkIfPresent(superseded);
    else await syncKeyDirectory(deps.keyFilePath);
    return "none";
  }
  // The keys' marker goes last, so the model's markers left without it come
  // from a deletion that had no keys: keys there now were sealed since.
  const sealedSince =
    superseded !== null ||
    (!pending.includes(deps.keyFilePath) && (await exists(deps.keyFilePath)));
  const rows = await deps.openRows();
  if (rows.exist()) {
    // Not synced: a move back lost to a crash is made again, since the rows are still there.
    for (const file of pending) await resilientRename(erasingKeyFilePath(file), file);
    if (superseded !== null) await durableUnlinkIfPresent(superseded);
    return "restored";
  }
  if (!sealedSince) deps.forgetIdentity();
  // Before any marker goes: a model file left without one would be opened again.
  for (const file of deps.modelFiles ?? []) await durableUnlinkIfPresent(file);
  // The keys' marker last, so a crash partway still finds this deletion to finish.
  for (const file of [...pending].reverse()) await durableUnlinkIfPresent(erasingKeyFilePath(file));
  if (superseded !== null) await durableUnlinkIfPresent(superseded);
  return sealedSince ? "none" : "finished";
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
    // The keys' marker last, so one left by a failure here still names this deletion.
    for (const file of [...setAside].reverse()) {
      await durableUnlinkIfPresent(erasingKeyFilePath(file));
    }
  } catch {
    return { result: "incomplete", erased: true };
  }
  return { result: "deleted" };
}
