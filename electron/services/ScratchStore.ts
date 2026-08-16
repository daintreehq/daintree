import fs from "fs/promises";
import { randomUUID } from "crypto";
import { eq, desc, and, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
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

/**
 * Drop the scratch's persisted panel state, which lives under the shared
 * `projects/<id>/` state layout (#11484). Imported lazily: `ProjectStore` is a
 * heavyweight singleton that constructs itself at module eval, and statically
 * importing it here would drag it into every suite that touches a scratch.
 */
export async function removeScratchStateDir(scratchId: string): Promise<void> {
  try {
    const { projectStore } = await import("./ProjectStore.js");
    await projectStore.removeWorkspaceStateDir(scratchId);
  } catch (error) {
    logError(`[ScratchStore] Failed to remove scratch state directory for ${scratchId}`, error);
  }
}

/**
 * A count only counts when it could have come from counting panels. A negative
 * or fractional cell is corruption, not a claim, so it reads back as unknown —
 * the same rule `ProjectStore` applies to its own persisted counts. Duplicated
 * rather than imported: `ProjectStore` is a heavyweight singleton that builds
 * itself at module eval, and this file keeps that import lazy on purpose.
 */
function readPersistedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function rowToScratch(row: ScratchRow): Scratch {
  const resumableAgentCount = readPersistedCount(row.resumableAgentCount);
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.createdAt,
    lastOpened: row.lastOpened,
    ...(typeof row.lastCompletionSeenAt === "number"
      ? { lastCompletionSeenAt: row.lastCompletionSeenAt }
      : {}),
    ...(resumableAgentCount !== null ? { resumableAgentCount } : {}),
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
   * tombstoned set is included so `ScratchCleanupService` can reap them once
   * their grace window has elapsed, and so a `removeScratch` that crashed
   * between tombstone and `fs.rm` is retried on a later sweep. The sweep
   * partitions these rows by `deleted_at`; this query stays age-agnostic.
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

  /**
   * Stamps the completed-agent acknowledgement watermark, mirroring
   * `ProjectStore.updateProject({ lastCompletionSeenAt })`.
   *
   * Deliberately not folded into `updateScratch`: that signature is reachable
   * from the renderer's scratch-update IPC, and the watermark is main's to set
   * from observed dwell, never something a renderer may assert. Throws when the
   * row is gone so the acknowledger's existing catch treats a scratch deleted
   * mid-dwell exactly as it treats a deleted project.
   */
  markCompletionSeen(scratchId: string, seenUpTo: number): void {
    if (!isValidScratchId(scratchId)) {
      throw new Error(`Invalid scratch ID: ${scratchId}`);
    }
    if (!Number.isFinite(seenUpTo) || seenUpTo <= 0) {
      throw new Error(`Invalid completion watermark for ${scratchId}: ${seenUpTo}`);
    }
    const db = getSharedDb();
    const result = db
      .update(scratchesTable)
      .set({ lastCompletionSeenAt: seenUpTo })
      .where(and(eq(scratchesTable.id, scratchId), isNull(scratchesTable.deletedAt)))
      .run();
    if (result.changes === 0) {
      throw new Error(`Scratch not found: ${scratchId}`);
    }
  }

  /**
   * Bring a scratch row's resume count in line with a state read taken outside
   * the write path — the deferred maintenance pass, which is how scratches that
   * predate the field ever get one (#11821). Mirrors
   * `ProjectStore.reconcileResumableAgentCount` against the other table.
   *
   * Compare-and-swap against the value read before that state load, because the
   * two race: a save landing mid-scan is newer than anything the scan holds, and
   * an unconditional write would replace a fresh count with a stale one.
   *
   * Passing `count: null` retracts the row's claim rather than replacing it —
   * for a scratch whose state could not be read, where the honest answer is
   * "unknown" and holding the old number would keep promising panels nothing
   * can enumerate any more.
   *
   * Returns the updated scratch when the row actually changed, so the caller can
   * broadcast exactly the rows a palette would need to redraw, and `null`
   * otherwise. Tombstoned rows are excluded like every other write here: a
   * scratch mid-deletion is already gone from every renderer-facing query.
   */
  reconcileResumableAgentCount(
    scratchId: string,
    previousCount: number | null,
    count: number | null
  ): Scratch | null {
    if (previousCount === count) return null;
    if (!isValidScratchId(scratchId)) return null;
    const db = getSharedDb();
    const result = db
      .update(scratchesTable)
      .set({ resumableAgentCount: count })
      .where(
        and(
          eq(scratchesTable.id, scratchId),
          isNull(scratchesTable.deletedAt),
          previousCount === null
            ? // "Unknown" is wider than SQL NULL. `readPersistedCount` also
              // reports a negative or fractional cell as unknown, so matching
              // NULL alone would leave a corrupt row permanently unrepairable:
              // the reader keeps answering unknown, and the swap keeps missing
              // the very value that made it answer that way.
              sql`(${scratchesTable.resumableAgentCount} IS NULL OR ${scratchesTable.resumableAgentCount} < 0 OR ${scratchesTable.resumableAgentCount} <> CAST(${scratchesTable.resumableAgentCount} AS INTEGER))`
            : eq(scratchesTable.resumableAgentCount, previousCount)
        )
      )
      .run();
    if (result.changes === 0) return null;
    return this.getScratchById(scratchId);
  }

  /** Acknowledgement watermarks for live scratches, keyed by id. */
  getLastCompletionSeenMap(): Map<string, number> {
    const db = getSharedDb();
    const rows = db
      .select({
        id: scratchesTable.id,
        lastCompletionSeenAt: scratchesTable.lastCompletionSeenAt,
      })
      .from(scratchesTable)
      .where(isNull(scratchesTable.deletedAt))
      .all();
    const map = new Map<string, number>();
    for (const row of rows) {
      if (typeof row.lastCompletionSeenAt === "number" && row.lastCompletionSeenAt > 0) {
        map.set(row.id, row.lastCompletionSeenAt);
      }
    }
    return map;
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

    await removeScratchStateDir(scratchId);
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
