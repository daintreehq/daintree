/**
 * The shared-DB side of the open-window manifest (#11492): the tracker's write,
 * and the scratch-cleanup sweep's read.
 *
 * Split from windowManifest.ts so the shape and its validation stay free of the
 * DB — the sync reader on the pre-`whenReady()` boot path imports the pure half,
 * and only callers that run after the shared DB is open pull in drizzle.
 */

import { eq } from "drizzle-orm";
import { getSharedDb } from "./db.js";
import { appState as appStateTable } from "./schema.js";
import {
  OPEN_WINDOWS_KEY,
  isReadableOpenWindowsManifest,
  parseOpenWindowsManifest,
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

/**
 * Every workspace the stored manifest names, foreground and background, for the
 * scratch-cleanup sweep's held set (#15614). Throws on a manifest it cannot
 * read, which the sweep treats as not knowing what is open: the boot reader
 * may fall back to one window, but the sweep must not guess "nothing".
 */
export function readManifestWorkspaceIds(): string[] {
  const row = getSharedDb()
    .select({ value: appStateTable.value })
    .from(appStateTable)
    .where(eq(appStateTable.key, OPEN_WINDOWS_KEY))
    .get();
  if (!row) return [];
  if (!isReadableOpenWindowsManifest(row.value)) {
    throw new Error("Open-window manifest is unreadable");
  }
  return parseOpenWindowsManifest(row.value).flatMap((record) =>
    [record.projectId, ...(record.backgroundProjectIds ?? [])].filter(
      (id): id is string => id !== null
    )
  );
}
