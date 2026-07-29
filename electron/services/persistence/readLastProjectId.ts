// eager-import-allow: reads last-active project state from SQLite synchronously before the window opens
/**
 * Synchronous, standalone readers for the last-active project.
 *
 * Called BEFORE app.whenReady() / on the early-renderer boot path. Each uses its
 * own read-only better-sqlite3 connection — they do not depend on getSharedDb()
 * or ProjectStore.initialize() (the shared DB is not open yet at this point in
 * boot, and opening it would run migrations on the loadURL-dispatch path).
 *
 * Returns null on first launch, corrupt DB, or any error (safe fallback).
 */

import Database from "better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "path";
import type { Project } from "../../../shared/types/project.js";
import {
  OPEN_WINDOWS_KEY,
  filterRestorableWindows,
  isReadableOpenWindowsManifest,
  parseOpenWindowsManifest,
  type OpenWindowRecord,
} from "./windowManifest.js";

export function readLastActiveProjectIdSync(): string | null {
  try {
    const dbPath = path.join(app.getPath("userData"), "daintree.db");

    if (!fs.existsSync(dbPath)) {
      return null; // First launch — no database yet
    }

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const row = sqlite
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .get("currentProjectId") as { value: string } | undefined;
      return row?.value ?? null;
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
 * Project existence is validated here, in one batched `IN (...)` query rather
 * than a query per record, so a deleted project is dropped before any window is
 * constructed around it. Records for the project picker (`projectId: null`)
 * always survive.
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

      const projectIds = [...new Set(records.map((r) => r.projectId).filter((id) => id !== null))];
      if (projectIds.length === 0) return { hadManifest: true, records };

      const placeholders = projectIds.map(() => "?").join(",");
      const rows = sqlite
        .prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`)
        .all(...projectIds) as { id: string }[];

      return {
        hadManifest: true,
        records: filterRestorableWindows(records, new Set(rows.map((r) => r.id))),
      };
    } finally {
      sqlite.close();
    }
  } catch {
    // Any error (corrupt DB, missing table, etc.) — restore a single window.
    return NO_MANIFEST;
  }
}
