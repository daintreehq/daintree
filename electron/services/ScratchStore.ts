import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { app } from "electron";
import { eq, desc } from "drizzle-orm";
import type { Scratch } from "../../shared/types/scratch.js";
import { getSharedDb } from "./persistence/db.js";
import {
  scratches as scratchesTable,
  appState as appStateTable,
  type ScratchRow,
} from "./persistence/schema.js";
import { getScratchDir, getScratchesRoot, isValidScratchId } from "./scratchStorePaths.js";
import { logError } from "../utils/logger.js";

const CURRENT_SCRATCH_KEY = "currentScratchId";

function rowToScratch(row: ScratchRow): Scratch {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.createdAt,
    lastOpened: row.lastOpened,
  };
}

function defaultScratchName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Scratch ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class ScratchStore {
  private scratchesRoot: string | null = null;

  private rootDir(): string {
    if (!this.scratchesRoot) {
      this.scratchesRoot = getScratchesRoot();
    }
    return this.scratchesRoot;
  }

  async initialize(): Promise<void> {
    const root = this.rootDir();
    if (!existsSync(root)) {
      await fs.mkdir(root, { recursive: true });
    }
  }

  async createScratch(name?: string): Promise<Scratch> {
    const root = this.rootDir();
    if (!existsSync(root)) {
      await fs.mkdir(root, { recursive: true });
    }

    const id = randomUUID();
    const dir = getScratchDir(root, id);
    if (!dir) {
      throw new Error("Failed to derive scratch directory");
    }
    await fs.mkdir(dir, { recursive: true });

    const now = Date.now();
    const trimmed = (name ?? "").trim();
    const finalName = trimmed.length > 0 ? trimmed : defaultScratchName(new Date(now));

    const scratch: Scratch = {
      id,
      path: dir,
      name: finalName,
      createdAt: now,
      lastOpened: now,
    };

    const db = getSharedDb();
    db.insert(scratchesTable)
      .values({
        id: scratch.id,
        path: scratch.path,
        name: scratch.name,
        createdAt: scratch.createdAt,
        lastOpened: scratch.lastOpened,
      })
      .run();

    return scratch;
  }

  getAllScratches(): Scratch[] {
    const db = getSharedDb();
    const rows = db.select().from(scratchesTable).orderBy(desc(scratchesTable.lastOpened)).all();
    return rows.map(rowToScratch);
  }

  getScratchById(scratchId: string): Scratch | null {
    if (!isValidScratchId(scratchId)) return null;
    const db = getSharedDb();
    const row = db.select().from(scratchesTable).where(eq(scratchesTable.id, scratchId)).get();
    return row ? rowToScratch(row) : null;
  }

  updateScratch(
    scratchId: string,
    updates: Partial<Pick<Scratch, "name" | "lastOpened">>
  ): Scratch {
    if (!isValidScratchId(scratchId)) {
      throw new Error(`Invalid scratch ID: ${scratchId}`);
    }
    const db = getSharedDb();
    const set: Partial<{ name: string; lastOpened: number }> = {};
    if (typeof updates.name === "string" && updates.name.trim().length > 0) {
      set.name = updates.name.trim();
    }
    if (typeof updates.lastOpened === "number" && Number.isFinite(updates.lastOpened)) {
      set.lastOpened = updates.lastOpened;
    }
    if (Object.keys(set).length > 0) {
      db.update(scratchesTable).set(set).where(eq(scratchesTable.id, scratchId)).run();
    }
    const row = db.select().from(scratchesTable).where(eq(scratchesTable.id, scratchId)).get();
    if (!row) throw new Error(`Scratch not found: ${scratchId}`);
    return rowToScratch(row);
  }

  async removeScratch(scratchId: string): Promise<void> {
    if (!isValidScratchId(scratchId)) {
      throw new Error(`Invalid scratch ID: ${scratchId}`);
    }
    const db = getSharedDb();
    db.delete(scratchesTable).where(eq(scratchesTable.id, scratchId)).run();

    const dir = getScratchDir(this.rootDir(), scratchId);
    if (dir && existsSync(dir)) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        logError(`[ScratchStore] Failed to remove scratch directory for ${scratchId}`, error);
      }
    }

    if (this.getCurrentScratchId() === scratchId) {
      this.clearCurrentScratch();
    }
  }

  getCurrentScratchId(): string | null {
    const db = getSharedDb();
    const row = db
      .select()
      .from(appStateTable)
      .where(eq(appStateTable.key, CURRENT_SCRATCH_KEY))
      .get();
    return row?.value ?? null;
  }

  getCurrentScratch(): Scratch | null {
    const id = this.getCurrentScratchId();
    if (!id) return null;
    return this.getScratchById(id);
  }

  setCurrentScratch(scratchId: string): Scratch {
    const scratch = this.getScratchById(scratchId);
    if (!scratch) {
      throw new Error(`Scratch not found: ${scratchId}`);
    }
    const now = Date.now();
    const db = getSharedDb();
    db.transaction((tx) => {
      tx.insert(appStateTable)
        .values({ key: CURRENT_SCRATCH_KEY, value: scratchId })
        .onConflictDoUpdate({
          target: appStateTable.key,
          set: { value: scratchId },
        })
        .run();
      tx.update(scratchesTable)
        .set({ lastOpened: now })
        .where(eq(scratchesTable.id, scratchId))
        .run();
    });
    return { ...scratch, lastOpened: now };
  }

  clearCurrentScratch(): void {
    const db = getSharedDb();
    db.delete(appStateTable).where(eq(appStateTable.key, CURRENT_SCRATCH_KEY)).run();
  }
}

export const scratchStore = new ScratchStore();

// Test-only helper for asserting the auto-name format. Not part of the public
// surface but exported for unit tests.
export const __test = { defaultScratchName };

// Re-exposed so other electron modules don't need to import the electron
// `app` module in tests.
export function _scratchesRootForTesting(): string {
  return path.join(app.getPath("userData"), "scratches");
}
