import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { Migration } from "../StoreMigrations.js";

/**
 * The Notes panel feature was removed in #5616. Before the code deletion lands,
 * any previously-created note files live under `userData/notes/`. This migration
 * preserves them by renaming the directory to `userData/notes_archived/` so a
 * determined user can still recover them from disk. Non-destructive and idempotent.
 */
export const migration018: Migration = {
  version: 18,
  description: "Archive legacy notes directory after Notes panel removal",
  up: () => {
    let userDataPath: string;
    try {
      userDataPath = app.getPath("userData");
    } catch (error) {
      console.warn("[Migration 018] app.getPath('userData') unavailable, skipping:", error);
      return;
    }

    const notesDir = path.join(userDataPath, "notes");
    const archivedDir = path.join(userDataPath, "notes_archived");

    if (!fs.existsSync(notesDir)) {
      console.log("[Migration 018] No legacy notes directory found, skipping");
      return;
    }

    if (fs.existsSync(archivedDir)) {
      console.log("[Migration 018] notes_archived already exists, skipping");
      return;
    }

    try {
      fs.renameSync(notesDir, archivedDir);
      console.log(`[Migration 018] Archived legacy notes directory to ${archivedDir}`);
    } catch (error) {
      console.warn("[Migration 018] Failed to archive notes directory:", error);
    }
  },
};
