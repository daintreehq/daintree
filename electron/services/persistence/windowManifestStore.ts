/**
 * Write side of the open-window manifest (#11492).
 *
 * Split from windowManifest.ts so the shape and its validation stay free of the
 * DB — the sync reader on the pre-`whenReady()` boot path imports the pure half,
 * and only the tracker (which runs well after global init) pulls in drizzle.
 */

import { getSharedDb } from "./db.js";
import { appState as appStateTable } from "./schema.js";
import {
  OPEN_WINDOWS_KEY,
  serializeOpenWindowsManifest,
  type OpenWindowRecord,
} from "./windowManifest.js";

/**
 * Persist the manifest. Synchronous — better-sqlite3 writes inline, which is
 * what lets the window-`closed` and shutdown-snapshot paths save without
 * leaving an unawaited promise in flight during teardown.
 *
 * Callers own the decision to write at all (see openWindowsTracker's shutdown
 * freeze — note `getSharedDb()` silently REOPENS a closed database rather than
 * throwing, so a late write here would resurrect a connection mid-shutdown
 * instead of failing loudly). This function just performs the write.
 */
export function writeOpenWindowsManifest(records: OpenWindowRecord[]): void {
  const value = serializeOpenWindowsManifest(records);
  getSharedDb()
    .insert(appStateTable)
    .values({ key: OPEN_WINDOWS_KEY, value })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
    .run();
}
