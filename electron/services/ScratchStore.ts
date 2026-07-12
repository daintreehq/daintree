import fs from "fs/promises";
import { randomUUID } from "crypto";
import { eq, desc, and, isNull, isNotNull, lt, or } from "drizzle-orm";
import type { Scratch } from "../../shared/types/scratch.js";
import { getSharedDb } from "./persistence/db.js";
import {
  scratches as scratchesTable,
  appState as appStateTable,
  type ScratchRow,
} from "./persistence/schema.js";
import { getScratchDir, getScratchesRoot, isValidScratchId } from "./scratchStorePaths.js";
import { defaultScratchName } from "../../shared/utils/scratchName.js";
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
    await fs.mkdir(root, { recursive: true });
  }

  async createScratch(name?: string): Promise<Scratch> {
    const root = this.rootDir();
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

    try {
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
    } catch (error) {
      await fs
        .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        .catch((cleanupErr) =>
          logError(`[ScratchStore] rollback cleanup failed for ${id}`, cleanupErr)
        );
      throw error;
    }

    return scratch;
  }

  getAllScratches(): Scratch[] {
    const db = getSharedDb();
    const rows = db
      .select()
      .from(scratchesTable)
      .where(isNull(scratchesTable.deletedAt))
      .orderBy(desc(scratchesTable.lastOpened))
      .all();
    return rows.map(rowToScratch);
  }

  getScratchById(scratchId: string): Scratch | null {
    if (!isValidScratchId(scratchId)) return null;
    const db = getSharedDb();
    const row = db
      .select()
      .from(scratchesTable)
      .where(and(eq(scratchesTable.id, scratchId), isNull(scratchesTable.deletedAt)))
      .get();
    return row ? rowToScratch(row) : null;
  }

  /**
   * Returns raw rows the cleanup sweep should consider: live rows whose
   * `last_opened` predates the cutoff, plus any already-tombstoned rows. The
   * tombstoned set is included so a `removeScratch` that crashed between
   * tombstone and `fs.rm` is retried on next startup.
   */
  getStaleScratchCandidates(cutoffMs: number): ScratchRow[] {
    const db = getSharedDb();
    return db
      .select()
      .from(scratchesTable)
      .where(
        or(
          and(lt(scratchesTable.lastOpened, cutoffMs), isNull(scratchesTable.deletedAt)),
          isNotNull(scratchesTable.deletedAt)
        )
      )
      .all();
  }

  /**
   * Marks a scratch as tombstoned (sets `deleted_at`). The DB row is preserved
   * so a partial directory delete can be retried idempotently on next startup.
   */
  tombstoneScratch(scratchId: string, deletedAt: number): void {
    if (!isValidScratchId(scratchId)) {
      throw new Error(`Invalid scratch ID: ${scratchId}`);
    }
    const db = getSharedDb();
    db.update(scratchesTable).set({ deletedAt }).where(eq(scratchesTable.id, scratchId)).run();
  }

  /**
   * Removes a scratch row outright. Called only after the on-disk directory
   * has been confirmed gone — the tombstone is the recovery anchor between
   * those two steps.
   */
  hardDeleteScratch(scratchId: string): void {
    if (!isValidScratchId(scratchId)) {
      throw new Error(`Invalid scratch ID: ${scratchId}`);
    }
    const db = getSharedDb();
    db.delete(scratchesTable).where(eq(scratchesTable.id, scratchId)).run();
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
      db.update(scratchesTable)
        .set(set)
        .where(and(eq(scratchesTable.id, scratchId), isNull(scratchesTable.deletedAt)))
        .run();
    }
    const row = db
      .select()
      .from(scratchesTable)
      .where(and(eq(scratchesTable.id, scratchId), isNull(scratchesTable.deletedAt)))
      .get();
    if (!row) throw new Error(`Scratch not found: ${scratchId}`);
    return rowToScratch(row);
  }

  async removeScratch(scratchId: string): Promise<void> {
    if (!isValidScratchId(scratchId)) {
      throw new Error(`Invalid scratch ID: ${scratchId}`);
    }

    this.tombstoneScratch(scratchId, Date.now());
    if (this.getCurrentScratchId() === scratchId) {
      this.clearCurrentScratch();
    }

    const dir = getScratchDir(this.rootDir(), scratchId);
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        logError(`[ScratchStore] Failed to remove scratch directory for ${scratchId}`, error);
        return;
      }
    }

    this.hardDeleteScratch(scratchId);
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
    db.transaction(
      (tx) => {
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
      },
      { behavior: "immediate" }
    );
    return { ...scratch, lastOpened: now };
  }

  clearCurrentScratch(): void {
    const db = getSharedDb();
    db.delete(appStateTable).where(eq(appStateTable.key, CURRENT_SCRATCH_KEY)).run();
  }
}

export const scratchStore = new ScratchStore();
