/**
 * Synchronous, standalone reader for the last-active projectId.
 *
 * Called BEFORE app.whenReady() to determine the correct session partition
 * for the initial WebContentsView. Uses its own read-only better-sqlite3
 * connection — does not depend on getSharedDb() or ProjectStore.initialize().
 *
 * Returns null on first launch, corrupt DB, or any error (safe fallback).
 */

import Database from "better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "path";

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
