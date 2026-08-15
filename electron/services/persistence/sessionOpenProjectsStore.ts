/**
 * Write side of the session-open checkpoint (#11794).
 *
 * Split from sessionOpenProjects.ts so the shape and its validation stay free
 * of the DB — the sync reader on the pre-`whenReady()` boot path imports the
 * pure half, and only this module pulls in drizzle.
 *
 * The tracker takes this as an injected writer rather than importing it, which
 * is what keeps the tracker itself loadable (and inert) in the node-environment
 * unit suites that never open a database.
 */

import { getSharedDb } from "./db.js";
import { appState as appStateTable } from "./schema.js";
import { SESSION_OPEN_PROJECTS_KEY, serializeSessionOpenProjects } from "./sessionOpenProjects.js";

/**
 * Persist the checkpoint. Synchronous — better-sqlite3 writes inline, so a
 * close or a switch leaves no unawaited promise behind for a force-quit to
 * drop. Callers own the decision to write at all; this just performs it.
 */
export function writeSessionOpenProjects(projectIds: ReadonlySet<string>): void {
  const value = serializeSessionOpenProjects(projectIds);
  getSharedDb()
    .insert(appStateTable)
    .values({ key: SESSION_OPEN_PROJECTS_KEY, value })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
    .run();
}
