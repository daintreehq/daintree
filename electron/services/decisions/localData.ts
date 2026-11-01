import { stat } from "node:fs/promises";
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
  /** Opened only when there are rows to erase or to look for. */
  openRows: () => Promise<DecisionsRows>;
  /** Saves the setting without the relay's origin and ids; throws when it can't. */
  forgetIdentity: () => void;
}

/**
 * - `deleted`: the rows, the keys and the relay record are gone.
 * - `failed`: nothing was deleted.
 * - `incomplete`: a step didn't finish. With `erased`, the rows are gone;
 *   with it false, nothing was deleted but the keys are still set aside; null
 *   when the rows couldn't be read to tell. The next deletion finishes or
 *   undoes it, and so does the next start whenever keys were set aside.
 */
export type LocalEraseOutcome =
  | { result: "deleted" }
  | { result: "failed"; reason: "disk-pressure" | "storage" | "keys" }
  | { result: "incomplete"; erased: boolean | null };

/**
 * Where the keys wait while their rows are deleted. Its presence is the
 * record that a deletion began, and whether any row is left says how far it
 * got: the rows go in one transaction, so none left means it committed.
 */
export function erasingKeyFilePath(keyFilePath: string): string {
  return `${keyFilePath}.erasing`;
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
 * committed, so nothing was deleted and the keys go back. No rows mean it
 * committed, so the relay record and the keys go too. Keys sealed since (a
 * new setup) mean the set-aside ones were already given up. Run before the
 * store opens, since a row written after the deletion would read as one it
 * never reached; a failure here must leave the store closed for that reason.
 */
export async function finishInterruptedErase(deps: LocalEraseDeps): Promise<EraseRecovery> {
  const aside = erasingKeyFilePath(deps.keyFilePath);
  if (!(await exists(aside))) {
    await syncKeyDirectory(deps.keyFilePath);
    return "none";
  }
  if (await exists(deps.keyFilePath)) {
    await durableUnlinkIfPresent(aside);
    return "none";
  }
  const rows = await deps.openRows();
  if (rows.exist()) {
    // Not synced: a move back lost to a crash is made again, since the rows are still there.
    await resilientRename(aside, deps.keyFilePath);
    return "restored";
  }
  deps.forgetIdentity();
  await durableUnlinkIfPresent(aside);
  return "finished";
}

/**
 * Deletes this computer's Decisions data (#16025): every stored row, the key
 * file and the relay's origin and ids in the setting. Run with the store and
 * the key store closed, so nothing queued writes a row back or reads the
 * keys meanwhile. Never asks the keychain, and sends nothing anywhere.
 *
 * The keys are moved aside first, durably, then the rows deleted in one
 * transaction: a failure before that commits puts the keys back, so nothing
 * changed. Once it has committed, the relay record and the set-aside keys
 * follow, and a failure there leaves the rest to `finishInterruptedErase`.
 * An earlier deletion still unresolved comes first, and while it can't be
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
  const aside = erasingKeyFilePath(deps.keyFilePath);
  let setAside = true;
  try {
    await resilientRename(deps.keyFilePath, aside);
  } catch (error) {
    if (!isMissing(error)) return { result: "failed", reason: "keys" };
    setAside = false;
  }
  const putBack = async (
    reason: "disk-pressure" | "storage" | "keys"
  ): Promise<LocalEraseOutcome> => {
    if (!setAside) return { result: "failed", reason };
    try {
      await resilientRename(aside, deps.keyFilePath);
    } catch {
      return { result: "incomplete", erased: false };
    }
    return { result: "failed", reason };
  };
  // Durable before the rows go: a crash must never keep their deletion and lose its marker.
  if (setAside) {
    try {
      await syncParentDirectory(aside);
    } catch {
      return putBack("keys");
    }
  }
  try {
    (await deps.openRows()).erase();
  } catch (error) {
    return putBack(eraseRefusal(error));
  }
  try {
    deps.forgetIdentity();
    if (setAside) await durableUnlinkIfPresent(aside);
  } catch {
    return { result: "incomplete", erased: true };
  }
  return { result: "deleted" };
}
