import { stat } from "node:fs/promises";
import { resilientRename, resilientUnlink } from "../../utils/fs.js";

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
 *   without it, nothing was deleted but the keys are still set aside. The
 *   next deletion finishes or undoes it, and so does the next start whenever
 *   keys were set aside.
 */
export type LocalEraseOutcome =
  | { result: "deleted" }
  | { result: "failed"; reason: "disk-pressure" | "storage" | "keys" }
  | { result: "incomplete"; erased: boolean };

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

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await resilientUnlink(path);
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
 * Finishes a deletion that stopped partway: quit or a crash mid-way, or a
 * last step that failed. Rows still stored mean their transaction never
 * committed, so nothing was deleted and the keys go back. No rows mean it
 * committed, so the relay record and the keys go too. Keys sealed since (a
 * new setup) mean the set-aside ones were already given up. Run before the
 * store opens, since a row written after the deletion would read as one it
 * never reached.
 */
export async function finishInterruptedErase(deps: LocalEraseDeps): Promise<void> {
  const aside = erasingKeyFilePath(deps.keyFilePath);
  if (!(await exists(aside))) return;
  if (await exists(deps.keyFilePath)) {
    await unlinkIfPresent(aside);
    return;
  }
  const rows = await deps.openRows();
  if (rows.exist()) {
    await resilientRename(aside, deps.keyFilePath);
    return;
  }
  deps.forgetIdentity();
  await unlinkIfPresent(aside);
}

/**
 * Deletes this computer's Decisions data (#16025): every stored row, the key
 * file and the relay's origin and ids in the setting. Run with the store and
 * the key store closed, so nothing queued writes a row back or reads the
 * keys meanwhile. Never asks the keychain, and sends nothing anywhere.
 *
 * The keys are moved aside first, then the rows deleted in one transaction:
 * a failure before that commits puts the keys back, so nothing changed. Once
 * it has committed, the relay record and the set-aside keys follow, and a
 * failure there leaves the rest to `finishInterruptedErase`.
 */
export async function eraseLocalDecisionsData(deps: LocalEraseDeps): Promise<LocalEraseOutcome> {
  try {
    await finishInterruptedErase(deps);
  } catch {
    return { result: "failed", reason: "keys" };
  }
  const aside = erasingKeyFilePath(deps.keyFilePath);
  let setAside = true;
  try {
    await resilientRename(deps.keyFilePath, aside);
  } catch (error) {
    if (!isMissing(error)) return { result: "failed", reason: "keys" };
    setAside = false;
  }
  try {
    (await deps.openRows()).erase();
  } catch (error) {
    const reason = eraseRefusal(error);
    if (!setAside) return { result: "failed", reason };
    try {
      await resilientRename(aside, deps.keyFilePath);
    } catch {
      return { result: "incomplete", erased: false };
    }
    return { result: "failed", reason };
  }
  try {
    deps.forgetIdentity();
    if (setAside) await unlinkIfPresent(aside);
  } catch {
    return { result: "incomplete", erased: true };
  }
  return { result: "deleted" };
}
