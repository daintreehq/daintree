import type { DaintreeLocalStore } from "./daintreeLocalStore.js";

/**
 * Opens the Decisions store over the shared app database. Null when the
 * lifetime that asked has ended meanwhile: quitting must never reopen a
 * database shutdown is about to close, or already has.
 */
export async function openDecisionsLocalStore(
  isCancelled: () => boolean
): Promise<DaintreeLocalStore | null> {
  const [{ getSharedDb, getSharedSqlite }, { DaintreeLocalStore }] = await Promise.all([
    import("../persistence/db.js"),
    import("./daintreeLocalStore.js"),
  ]);
  if (isCancelled()) return null;
  getSharedDb();
  const sqlite = getSharedSqlite();
  if (!sqlite) throw new Error("The app database isn't open");
  return new DaintreeLocalStore(sqlite);
}
