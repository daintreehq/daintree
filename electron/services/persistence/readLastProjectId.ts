// eager-import-allow: reads last-active project state from SQLite synchronously before the window opens
/**
 * Synchronous, standalone readers for the last-active project.
 *
 * Called BEFORE app.whenReady() / on the early-renderer boot path. Each uses its
 * own better-sqlite3 connection — they do not depend on getSharedDb() or
 * ProjectStore.initialize() (the shared DB is not open yet at this point in
 * boot, and opening it would run migrations on the loadURL-dispatch path).
 *
 * Read-only throughout.
 *
 * Returns null on first launch, corrupt DB, or any error (safe fallback).
 */

import Database from "better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "path";
import type { Project } from "../../../shared/types/project.js";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  OPEN_WINDOWS_KEY,
  filterRestorableWindows,
  isReadableOpenWindowsManifest,
  parseOpenWindowsManifest,
  type OpenWindowRecord,
} from "./windowManifest.js";

/**
 * Which of `scratchIds` name a scratch that still exists.
 *
 * The schema is probed rather than assumed, because these readers run BEFORE
 * migrations: `scratches` arrives in 0001 and its `deleted_at` column in 0002,
 * so an upgrading install can present either partial shape. A missing table
 * means no scratch exists; a table without the tombstone column cannot hold a
 * tombstone, so every row in it is live.
 *
 * Probing rather than catching is deliberate. A blanket `catch` here would read
 * a corrupt or locked database as "the user has no scratches", quietly drop
 * their windows, and let the successful boot rewrite the manifest without them.
 * Anything other than a shape the probe explains has to surface to the caller's
 * own handler, exactly as a failure of the `projects` query does.
 */
function readExistingScratchIds(
  sqlite: InstanceType<typeof Database>,
  scratchIds: string[]
): Set<string> {
  const existing = new Set<string>();
  if (scratchIds.length === 0) return existing;

  // `PRAGMA table_info` on a table that does not exist returns no rows rather
  // than throwing, which is what makes it usable as the presence check.
  const columns = sqlite.prepare("PRAGMA table_info(scratches)").all() as { name: string }[];
  if (columns.length === 0) return existing;

  const tombstoneFilter = columns.some((column) => column.name === "deleted_at")
    ? " AND deleted_at IS NULL"
    : "";
  const placeholders = scratchIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(`SELECT id FROM scratches WHERE id IN (${placeholders})${tombstoneFilter}`)
    .all(...scratchIds) as { id: string }[];
  for (const row of rows) existing.add(row.id);

  return existing;
}

/**
 * The workspace to fall back to when there is no manifest to restore — the last
 * project switched to, or the current scratch when the user was in one.
 *
 * Both pointers have to be consulted because they are mutually exclusive:
 * `scratch:switch` deletes `currentProjectId` outright, so a session that ended
 * inside a scratch leaves only `currentScratchId` behind. Reading the project
 * pointer alone answered "nothing" for that session, and closing the last
 * window — the quit gesture on Windows and Linux, which persists a manifest
 * naming zero windows — relaunched onto the project picker with the scratch
 * gone even from the label (#11958).
 */
export function readLastActiveProjectIdSync(): string | null {
  try {
    const dbPath = path.join(app.getPath("userData"), "daintree.db");

    if (!fs.existsSync(dbPath)) {
      return null; // First launch — no database yet
    }

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const readPointer = (key: string): string | null =>
        (
          sqlite.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
            { value: string } | undefined
        )?.value ?? null;

      const projectId = readPointer("currentProjectId");
      if (projectId) return projectId;

      // Only a scratch that still exists: a tombstoned or reaped one would send
      // the launch at a workspace whose directory is gone, and the manifest
      // path already refuses exactly that.
      const scratchId = readPointer("currentScratchId");
      if (scratchId && isScratchWorkspaceId(scratchId)) {
        const live = readExistingScratchIds(sqlite, [scratchId]);
        if (live.has(scratchId)) return scratchId;
      }

      return null;
    } finally {
      sqlite.close();
    }
  } catch {
    // Any error (corrupt DB, missing table, etc.) — fall back to default session.
    // The full DB init in setupWindowServices will handle recovery.
    return null;
  }
}

/**
 * Synchronous, standalone reader for the last-active project's skeleton
 * identity (name, emoji, accent color). Used by the initial host window's boot
 * skeleton so it paints the destination project's accent + name/emoji and
 * matches a cold project switch (#10942). Like readLastActiveProjectIdSync,
 * reads via its own throwaway read-only connection so the shared DB never has
 * to be open — and never gets force-opened — on the boot path.
 *
 * Returns null when the id is missing, the project row is gone (deleted), or
 * anything throws; the anonymous gray skeleton remains the fallback.
 */
export function readLastActiveProjectIdentitySync(
  projectId: string
): Pick<Project, "name" | "emoji" | "color"> | null {
  try {
    const dbPath = path.join(app.getPath("userData"), "daintree.db");

    if (!fs.existsSync(dbPath)) {
      return null; // First launch — no database yet
    }

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const row = sqlite
        .prepare("SELECT name, emoji, color FROM projects WHERE id = ?")
        .get(projectId) as { name: string; emoji: string; color: string | null } | undefined;
      if (!row) return null;
      return { name: row.name, emoji: row.emoji, color: row.color ?? undefined };
    } finally {
      sqlite.close();
    }
  } catch {
    // Corrupt DB, missing column, etc. — anonymous skeleton is the fallback.
    return null;
  }
}

/**
 * Synchronous, standalone reader for the open-window manifest (#11492) — the
 * set of windows to recreate on a cold launch, most-recently-focused first.
 *
 * Reads on the same throwaway read-only connection idiom as its siblings above,
 * because the restore decision runs before `app.whenReady()` resolves and each
 * record's project id chooses that window's session partition — it has to be
 * known before the BrowserWindow is built, not corrected afterwards.
 *
 * Workspace existence is validated here, in batched `IN (...)` queries rather
 * than a query per record, so a deleted workspace is dropped before any window
 * is constructed around it. Records for the project picker (`projectId: null`)
 * always survive.
 *
 * A record's id names a project OR a scratch — the two are disjoint id spaces
 * and each lives in its own table, so the shape routes the id to the one table
 * that could hold it (#11958). Validating scratches against `projects` treated
 * every one of them as a deleted project, which dropped the window and
 * restored it unbound: no panels, no assistant, no file browser.
 *
 * `hadManifest` is reported separately from `records` on purpose: a manifest
 * that named windows whose every project has since been deleted filters down to
 * an empty list, and that is NOT the same as having no manifest at all.
 * Collapsing the two would let the caller fall back to the global last-active
 * project — which is precisely the "silently opened a different project"
 * behaviour the restore is required to avoid.
 *
 * Both fields report nothing on first launch, corrupt DB, corrupt manifest, a
 * manifest that named zero windows, or any error, so the caller opens a single
 * window seeded the old way.
 */
export interface OpenWindowsManifestRead {
  /** A manifest naming at least one window was stored, whatever survived filtering. */
  hadManifest: boolean;
  /** Windows still restorable, most-recently-focused first. */
  records: OpenWindowRecord[];
}

const NO_MANIFEST: OpenWindowsManifestRead = { hadManifest: false, records: [] };

export function readOpenWindowsManifestSync(): OpenWindowsManifestRead {
  try {
    const dbPath = path.join(app.getPath("userData"), "daintree.db");

    if (!fs.existsSync(dbPath)) {
      return NO_MANIFEST; // First launch — no database yet
    }

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const row = sqlite
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .get(OPEN_WINDOWS_KEY) as { value: string } | undefined;

      // Two ways to have nothing to restore, both of which fall back to the
      // global last-active project. Unreadable is corruption. Empty is the
      // Windows/Linux quit gesture: closing the last window fires its `closed`
      // save before `window-all-closed` reaches `app.quit()`, so the stored
      // manifest names zero windows even though the user never asked for a
      // picker. `hadManifest: true` below therefore means exactly one thing —
      // the manifest named windows, and project deletion emptied it.
      if (!isReadableOpenWindowsManifest(row?.value ?? null)) return NO_MANIFEST;

      const records = parseOpenWindowsManifest(row?.value ?? null);
      if (records.length === 0) return NO_MANIFEST;

      const workspaceIds = [
        ...new Set(records.map((r) => r.projectId).filter((id) => id !== null)),
      ];
      if (workspaceIds.length === 0) return { hadManifest: true, records };

      // Positively shaped on both sides, so an id that is neither reaches no
      // query at all. Sending it to `projects` would find nothing today, but it
      // would also be the one route by which a hand-edited or corrupt manifest
      // could put an unvalidated string on the project side of the boot.
      const scratchIds = workspaceIds.filter((id) => isScratchWorkspaceId(id));
      const projectIds = workspaceIds.filter((id) => isProjectWorkspaceId(id));
      const existingWorkspaceIds = readExistingScratchIds(sqlite, scratchIds);

      if (projectIds.length > 0) {
        const placeholders = projectIds.map(() => "?").join(",");
        const rows = sqlite
          .prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`)
          .all(...projectIds) as { id: string }[];
        for (const row of rows) existingWorkspaceIds.add(row.id);
      }

      return {
        hadManifest: true,
        records: filterRestorableWindows(records, existingWorkspaceIds),
      };
    } finally {
      sqlite.close();
    }
  } catch {
    // Any error (corrupt DB, missing table, etc.) — restore a single window.
    return NO_MANIFEST;
  }
}
