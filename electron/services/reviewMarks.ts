import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { app } from "electron";
import { z } from "zod";
import { resilientAtomicWriteFile, resilientRename, resilientUnlink } from "../utils/fs.js";
import { logWarn } from "../utils/logger.js";
import { getProjectStateDir, UTF8_BOM } from "./projectStorePaths.js";
import {
  ReviewPointHeadSchema,
  ReviewPointSchema,
  type ReviewPoint,
} from "../../shared/types/reviewPoint.js";
import type {
  ReviewMarkSummary,
  ReviewMarksSnapshot,
} from "../../shared/types/ipc/reviewMarks.js";

/**
 * Each project's review marks (#14584): per worktree, the review point the user
 * acknowledged. Daintree's own state, in the project's state directory on the
 * host, never in the repository.
 *
 * Two kinds of file, both user-editable and validated on every read:
 * - `review-marks.json`, the index: the project's revision and, per worktree,
 *   the revision its mark last changed at and a summary of the mark (null once
 *   cleared or removed). Every view is sent this.
 * - `review-marks/<key>.<revision>.json`, one per mark, holding its review
 *   point. A point can run to megabytes, so it is written once and read only by
 *   the host, never rewritten when another worktree's mark changes.
 *
 * Every read and write of a project's files takes a turn in that project's
 * queue, so a check and the write it allows can't be split by another write. A
 * clear or removal keeps the worktree's revision as a tombstone, so a save that
 * started before it is refused rather than bringing the mark back. Past
 * {@link MAX_TOMBSTONES} the oldest go, and `floor` keeps their newest revision
 * so a save that started before them is still refused.
 */

const INDEX_FILENAME = "review-marks.json";
const POINTS_DIRNAME = "review-marks";
const INDEX_VERSION = 1;
const POINT_FILE_VERSION = 1;
/** Worktree ids are absolute paths; nothing longer is one. */
const MAX_WORKTREE_ID_LENGTH = 4096;
const MAX_TOMBSTONES = 256;
/** A point file this store wrote, or the temp file of one a crash cut short. */
const POINT_FILE_NAME = /^[0-9a-f]{32}\.[1-9][0-9]{0,15}\.json(?:\.[0-9]+-[0-9a-z]+\.tmp)?$/;

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const StoredMarkSchema = z.object({
  markedAt: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
  head: ReviewPointHeadSchema,
  base: z.object({ ref: z.string().min(1).max(1024).nullable(), tip: oid.nullable() }),
  complete: z.boolean(),
  pathCount: z.number().int().nonnegative(),
});

type StoredMark = z.infer<typeof StoredMarkSchema>;

interface WorktreeEntry {
  /** The project revision this worktree's mark last changed at. */
  revision: number;
  /** Null once cleared or removed: a tombstone. */
  mark: StoredMark | null;
}

interface MarksIndex {
  revision: number;
  /** The newest revision of a tombstone that has been trimmed. */
  floor: number;
  worktrees: Map<string, WorktreeEntry>;
}

export interface StoredReviewMark {
  point: ReviewPoint;
  summary: ReviewMarkSummary;
}

export type ReviewMarkSaveResult = "saved" | "stale";
export type ReviewMarkClearResult = "cleared" | "stale";

export interface ReviewMarksWrite<Status> {
  status: Status;
  snapshot: ReviewMarksSnapshot;
  /** Whether anything was written, so every view needs telling. */
  changed: boolean;
}

/** Thrown from a write's guard to refuse it; nothing is written. */
export type ReviewMarkWriteGuard = () => void;

export function isReviewMarkWorktreeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_WORKTREE_ID_LENGTH &&
    !id.includes("\0") &&
    path.isAbsolute(id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function emptyIndex(): MarksIndex {
  return { revision: 0, floor: 0, worktrees: new Map() };
}

/**
 * The index as written, or null when it isn't one this build can trust. An
 * entry whose mark doesn't parse is kept as a tombstone, and one whose revision
 * doesn't is taken as changed at the newest revision: either way a save that
 * started earlier is refused rather than guessed through.
 */
function parseIndex(raw: unknown): MarksIndex | { futureVersion: number } | null {
  if (!isRecord(raw)) return null;
  const version = nonNegativeInt(raw.version);
  if (version !== null && version > INDEX_VERSION) return { futureVersion: version };
  if (version !== INDEX_VERSION) return null;
  const revision = nonNegativeInt(raw.revision);
  if (revision === null) return null;
  const floor = Math.min(nonNegativeInt(raw.floor) ?? revision, revision);
  const worktrees = new Map<string, WorktreeEntry>();
  if (isRecord(raw.worktrees)) {
    for (const [id, value] of Object.entries(raw.worktrees)) {
      if (!isReviewMarkWorktreeId(id)) continue;
      const entry = isRecord(value) ? value : {};
      const entryRevision = nonNegativeInt(entry.revision);
      const parsed = StoredMarkSchema.safeParse(entry.mark);
      worktrees.set(id, {
        revision:
          entryRevision !== null && entryRevision > 0 && entryRevision <= revision
            ? entryRevision
            : revision,
        mark: parsed.success ? parsed.data : null,
      });
    }
  }
  return { revision, floor, worktrees };
}

function serializeIndex(index: MarksIndex): string {
  const worktrees: Record<string, { revision: number; mark: StoredMark | null }> = {};
  for (const [id, entry] of index.worktrees) {
    Object.defineProperty(worktrees, id, {
      value: { revision: entry.revision, mark: entry.mark },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return `${JSON.stringify(
    { version: INDEX_VERSION, revision: index.revision, floor: index.floor, worktrees },
    null,
    2
  )}\n`;
}

function summaryOf(mark: StoredMark, revision: number): ReviewMarkSummary {
  return {
    markedAt: mark.markedAt,
    capturedAt: mark.capturedAt,
    head: mark.head,
    base: { ...mark.base },
    complete: mark.complete,
    pathCount: mark.pathCount,
    revision,
  };
}

function snapshotOf(projectId: string, index: MarksIndex): ReviewMarksSnapshot {
  const marks: Record<string, ReviewMarkSummary> = {};
  for (const [id, entry] of index.worktrees) {
    if (!entry.mark) continue;
    Object.defineProperty(marks, id, {
      value: summaryOf(entry.mark, entry.revision),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { projectId, marks, revision: index.revision };
}

function markOf(point: ReviewPoint, markedAt: number): StoredMark {
  return {
    markedAt,
    capturedAt: point.capturedAt,
    head: point.head,
    base: { ref: point.base.ref, tip: point.base.tip },
    complete: point.incomplete === null,
    pathCount: point.entries.length,
  };
}

/** Whether the worktree's mark changed after the revision a write started from. */
function changedSince(index: MarksIndex, worktreeId: string, basedOn: number): boolean {
  // Newer than anything here: the caller read a store that has since been reset.
  if (basedOn > index.revision) return true;
  const entry = index.worktrees.get(worktreeId);
  return entry ? entry.revision > basedOn : index.floor > basedOn;
}

/** Drop the oldest tombstones past the cap; `floor` keeps what they refused. */
function trimTombstones(index: MarksIndex): void {
  const tombstones = [...index.worktrees].filter(([, entry]) => entry.mark === null);
  if (tombstones.length <= MAX_TOMBSTONES) return;
  tombstones.sort(([, a], [, b]) => a.revision - b.revision);
  for (const [id, entry] of tombstones.slice(0, tombstones.length - MAX_TOMBSTONES)) {
    index.worktrees.delete(id);
    index.floor = Math.max(index.floor, entry.revision);
  }
}

function pointKey(worktreeId: string): string {
  return createHash("sha256").update(worktreeId).digest("hex").slice(0, 32);
}

function pointFileName(worktreeId: string, revision: number): string {
  return `${pointKey(worktreeId)}.${revision}.json`;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

export class ReviewMarkStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pendingSaves = new Map<string, number>();

  constructor(private readonly projectsConfigDir: string) {}

  /** The project's marks as every view holds them. */
  read(projectId: string): Promise<ReviewMarksSnapshot> {
    return this.turn(projectId, async () => snapshotOf(projectId, await this.readIndex(projectId)));
  }

  /**
   * One worktree's mark with its review point, or null when it has none or its
   * point file is missing or doesn't match the index.
   */
  get(projectId: string, worktreeId: string): Promise<StoredReviewMark | null> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      const entry = index.worktrees.get(worktreeId);
      if (!entry?.mark) return null;
      const point = await this.readPoint(projectId, worktreeId, entry.revision);
      return point ? { point, summary: summaryOf(entry.mark, entry.revision) } : null;
    });
  }

  /**
   * Note a save in flight from before its checks run, so a removal landing
   * meanwhile leaves a tombstone even for a worktree with no mark yet. Returns
   * the release.
   */
  beginSave(projectId: string, worktreeId: string): () => void {
    const key = `${projectId}\0${worktreeId}`;
    this.pendingSaves.set(key, (this.pendingSaves.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.pendingSaves.get(key) ?? 1) - 1;
      if (left > 0) this.pendingSaves.set(key, left);
      else this.pendingSaves.delete(key);
    };
  }

  /**
   * Store `point` as the worktree's mark, replacing any. Refused as stale when
   * the worktree's mark was set or cleared after `basedOn`, or the held mark
   * was captured later than `point`. `guard` runs in the same turn as the write
   * and throws to refuse it.
   */
  save(
    projectId: string,
    worktreeId: string,
    point: ReviewPoint,
    basedOn: number,
    guard: ReviewMarkWriteGuard
  ): Promise<ReviewMarksWrite<ReviewMarkSaveResult>> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      const held = index.worktrees.get(worktreeId)?.mark;
      if (changedSince(index, worktreeId, basedOn) || (held && held.capturedAt > point.capturedAt)) {
        return { status: "stale", snapshot: snapshotOf(projectId, index), changed: false };
      }
      guard();
      const revision = index.revision + 1;
      const pointsDir = this.pointsDir(projectId);
      const pointFile = path.join(pointsDir, pointFileName(worktreeId, revision));
      await fs.mkdir(pointsDir, { recursive: true });
      await resilientAtomicWriteFile(
        pointFile,
        JSON.stringify({ version: POINT_FILE_VERSION, worktreeId, revision, point })
      );
      index.revision = revision;
      index.worktrees.set(worktreeId, { revision, mark: markOf(point, Date.now()) });
      try {
        await this.commit(projectId, index);
      } catch (error) {
        await resilientUnlink(pointFile).catch(() => {});
        throw error;
      }
      return { status: "saved", snapshot: snapshotOf(projectId, index), changed: true };
    });
  }

  /**
   * Remove the worktree's mark. Refused as stale when a mark was set after
   * `basedOn`: clearing it would drop a mark the caller never saw. Clearing a
   * worktree with no mark writes nothing.
   */
  clear(
    projectId: string,
    worktreeId: string,
    basedOn: number,
    guard: ReviewMarkWriteGuard
  ): Promise<ReviewMarksWrite<ReviewMarkClearResult>> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      if (!index.worktrees.get(worktreeId)?.mark) {
        return { status: "cleared", snapshot: snapshotOf(projectId, index), changed: false };
      }
      if (changedSince(index, worktreeId, basedOn)) {
        return { status: "stale", snapshot: snapshotOf(projectId, index), changed: false };
      }
      guard();
      index.revision += 1;
      index.worktrees.set(worktreeId, { revision: index.revision, mark: null });
      await this.commit(projectId, index);
      return { status: "cleared", snapshot: snapshotOf(projectId, index), changed: true };
    });
  }

  /**
   * Remove the marks of worktrees that are gone, with no revision to check:
   * the host confirmed they're gone. A tombstone is left for each that had a
   * mark or has a save in flight.
   */
  remove(
    projectId: string,
    worktreeIds: readonly string[]
  ): Promise<ReviewMarksWrite<"removed">> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      const gone = worktreeIds.filter(
        (id) =>
          isReviewMarkWorktreeId(id) &&
          (!!index.worktrees.get(id)?.mark || this.pendingSaves.has(`${projectId}\0${id}`))
      );
      if (gone.length === 0) {
        return { status: "removed", snapshot: snapshotOf(projectId, index), changed: false };
      }
      index.revision += 1;
      for (const id of gone) index.worktrees.set(id, { revision: index.revision, mark: null });
      await this.commit(projectId, index);
      return { status: "removed", snapshot: snapshotOf(projectId, index), changed: true };
    });
  }

  /** Worktree ids that hold a mark, for checking which are gone. */
  async markedWorktreeIds(projectId: string): Promise<string[]> {
    const snapshot = await this.read(projectId);
    return Object.keys(snapshot.marks);
  }

  private turn<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(projectId) ?? Promise.resolve();
    const next = prior.then(run);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(projectId, settled);
    void settled.then(() => {
      if (this.queues.get(projectId) === settled) this.queues.delete(projectId);
    });
    return next;
  }

  private stateDir(projectId: string): string {
    const dir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!dir) throw new Error("review marks: projectId must be a workspace id");
    return dir;
  }

  private pointsDir(projectId: string): string {
    return path.join(this.stateDir(projectId), POINTS_DIRNAME);
  }

  /**
   * The project's index; empty before anything was stored. A file that can't
   * be parsed or is from a newer build is moved aside and the project starts
   * empty. One that can't be read at all throws: writing over a file we could
   * not read would drop every mark in it.
   */
  private async readIndex(projectId: string): Promise<MarksIndex> {
    const filePath = path.join(this.stateDir(projectId), INDEX_FILENAME);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyIndex();
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text);
    } catch {
      raw = undefined;
    }
    const parsed = parseIndex(raw);
    if (parsed && !("futureVersion" in parsed)) return parsed;
    const aside = parsed
      ? `${filePath}.future-v${parsed.futureVersion}.${Date.now()}`
      : `${filePath}.corrupted.${Date.now()}`;
    logWarn("[reviewMarks] Moved aside an unreadable review marks file", { projectId });
    await resilientRename(filePath, aside);
    return emptyIndex();
  }

  private async readPoint(
    projectId: string,
    worktreeId: string,
    revision: number
  ): Promise<ReviewPoint | null> {
    const filePath = path.join(this.pointsDir(projectId), pointFileName(worktreeId, revision));
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        logWarn("[reviewMarks] Couldn't read a review point", { projectId });
      }
      return null;
    }
    if (
      !isRecord(raw) ||
      raw.version !== POINT_FILE_VERSION ||
      raw.worktreeId !== worktreeId ||
      raw.revision !== revision
    ) {
      return null;
    }
    const point = ReviewPointSchema.safeParse(raw.point);
    return point.success ? point.data : null;
  }

  /** Write the index, then drop every point file it no longer names. */
  private async commit(projectId: string, index: MarksIndex): Promise<void> {
    trimTombstones(index);
    const stateDir = this.stateDir(projectId);
    await fs.mkdir(stateDir, { recursive: true });
    await resilientAtomicWriteFile(path.join(stateDir, INDEX_FILENAME), serializeIndex(index));
    await this.sweepPoints(projectId, index);
  }

  private async sweepPoints(projectId: string, index: MarksIndex): Promise<void> {
    const keep = new Set<string>();
    for (const [id, entry] of index.worktrees) {
      if (entry.mark) keep.add(pointFileName(id, entry.revision));
    }
    const dir = this.pointsDir(projectId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      logWarn("[reviewMarks] Couldn't list review points to tidy", { projectId });
      return;
    }
    await Promise.all(
      names
        .filter((name) => POINT_FILE_NAME.test(name) && !keep.has(name))
        .map((name) =>
          resilientUnlink(path.join(dir, name)).catch((error: unknown) => {
            if (!isErrno(error, "ENOENT")) {
              logWarn("[reviewMarks] Couldn't remove an old review point", { projectId });
            }
          })
        )
    );
  }
}

let instance: ReviewMarkStore | null = null;

export function getReviewMarkStore(): ReviewMarkStore {
  instance ??= new ReviewMarkStore(path.join(app.getPath("userData"), "projects"));
  return instance;
}

/** @internal Tests only. */
export function _setReviewMarkStoreForTesting(next: ReviewMarkStore | null): void {
  instance = next;
}
