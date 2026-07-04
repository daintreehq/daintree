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
