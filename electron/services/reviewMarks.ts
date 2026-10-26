import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { app } from "electron";
import { z } from "zod";
import { resilientAtomicWriteFile, resilientRename, resilientUnlink } from "../utils/fs.js";
import { AppError } from "../utils/errorTypes.js";
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
 * queue, so a check and the write it allows can't be split by another write,
 * and nothing outside a turn ever sees a write a turn takes back. A clear or
 * removal keeps the worktree's revision as a tombstone, so a save that started
 * before it is refused rather than bringing the mark back. Past
 * {@link MAX_TOMBSTONES} the oldest go, and `floor` keeps their newest revision
 * so a save that started before them is still refused.
 *
 * Revisions come from the clock, never below the last plus one: a history that
 * starts over (an unreadable file moved aside, or one deleted) still counts past
 * any revision a view holds from before, so the view takes its pushes.
 */

const INDEX_FILENAME = "review-marks.json";
const POINTS_DIRNAME = "review-marks";
const INDEX_VERSION = 1;
const POINT_FILE_VERSION = 1;
/** Worktree ids are absolute paths; nothing longer is one. */
const MAX_WORKTREE_ID_LENGTH = 4096;
const MAX_TOMBSTONES = 256;
/** Past what a Remote Host's link carries in one frame; no capture comes near it. */
const MAX_POINT_FILE_BYTES = 16 * 1024 * 1024;
/** Summaries only: far more than every worktree's mark plus the tombstones. */
const MAX_INDEX_FILE_BYTES = 8 * 1024 * 1024;
/** A point file this store wrote, or the temp file of one a crash cut short. */
const POINT_FILE_NAME = /^[0-9a-f]{64}\.[1-9][0-9]{0,15}\.json(?:\.[0-9]+-[0-9a-z]+\.tmp)?$/;

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

export interface ReviewMarksWrite<Status> {
  status: Status;
  snapshot: ReviewMarksSnapshot;
  /** Whether anything was written, so every view needs telling. */
  changed: boolean;
}

export interface ReviewMarksRemoval extends ReviewMarksWrite<"removed"> {
  /** Candidates whose entry changed since the caller read it: left as they are. */
  changedSince: string[];
}

/** Throws to refuse a write: nothing it would have written stays. */
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

/** Own properties throughout: the keys are paths, and the file is read back as JSON. */
function ownRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

function serializeIndex(index: MarksIndex): string {
  const worktrees = ownRecord(
    [...index.worktrees].map(([id, entry]) => [id, { revision: entry.revision, mark: entry.mark }])
  );
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
  const marks = ownRecord(
    [...index.worktrees].flatMap(([id, entry]) =>
      entry.mark ? [[id, summaryOf(entry.mark, entry.revision)] as const] : []
    )
  );
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

/** Whether the index's summary of a mark is what its point says. */
function describes(mark: StoredMark, point: ReviewPoint): boolean {
  return JSON.stringify(markOf(point, mark.markedAt)) === JSON.stringify(mark);
}

/** Whether the worktree's mark changed after the revision a write started from. */
function changedSince(index: MarksIndex, worktreeId: string, basedOn: number): boolean {
  // Newer than anything here: the caller read a store that has since started over.
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

function pointFileName(worktreeId: string, revision: number): string {
  return `${createHash("sha256").update(worktreeId).digest("hex")}.${revision}.json`;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

export interface ReviewMarkStoreOptions {
  /** Test seam for the clock revisions and `markedAt` are taken from. */
  now?: () => number;
}

export class ReviewMarkStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pendingSaves = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly projectsConfigDir: string,
    options: ReviewMarkStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The project's marks as every view holds them. */
  read(projectId: string): Promise<ReviewMarksSnapshot> {
    return this.turn(projectId, async () => snapshotOf(projectId, await this.readIndex(projectId)));
  }

  /**
   * One worktree's mark with its review point, or null when it has none or its
   * point file is missing or doesn't match the index. Whether it applies to the
   * worktree as it is now is the caller's to check (`reviewMarkApplicability`).
   */
  get(projectId: string, worktreeId: string): Promise<StoredReviewMark | null> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      const entry = index.worktrees.get(worktreeId);
      if (!entry?.mark) return null;
      const point = await this.readPoint(projectId, worktreeId, entry.revision);
      if (!point || !describes(entry.mark, point)) return null;
      return { point, summary: summaryOf(entry.mark, entry.revision) };
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
   * the worktree's mark was set or cleared after `basedOn`. `guard` is asked
   * before anything is written and again once it is, and its throw refuses the
   * save, putting back anything already written.
   */
  save(
    projectId: string,
    worktreeId: string,
    point: ReviewPoint,
    basedOn: number,
    guard: ReviewMarkWriteGuard
  ): Promise<ReviewMarksWrite<"saved" | "stale">> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      if (changedSince(index, worktreeId, basedOn)) {
        return { status: "stale", snapshot: snapshotOf(projectId, index), changed: false };
      }
      guard();
      const revision = this.nextRevision(index);
      const body = JSON.stringify({ version: POINT_FILE_VERSION, worktreeId, revision, point });
      if (Buffer.byteLength(body) > MAX_POINT_FILE_BYTES) {
        throw new AppError({
          code: "PAYLOAD_TOO_LARGE",
          message: "review marks: the review point is too large to keep",
        });
      }
      const pointsDir = this.pointsDir(projectId);
      await fs.mkdir(pointsDir, { recursive: true });
      // Unreferenced until the index names it; the next write tidies it if this one fails.
      await resilientAtomicWriteFile(path.join(pointsDir, pointFileName(worktreeId, revision)), body);
      index.revision = revision;
      index.worktrees.set(worktreeId, { revision, mark: markOf(point, this.now()) });
      await this.commit(projectId, index, guard);
      return { status: "saved", snapshot: snapshotOf(projectId, index), changed: true };
    });
  }

  /**
   * Remove the worktree's mark. Refused as stale when a mark was set after
   * `basedOn`: clearing it would drop a mark the caller never saw. A clear
   * always leaves a tombstone, even where there was no mark, so a save of the
   * same worktree already on its way (a mark undone before it landed) can't
   * bring one back.
   */
  clear(
    projectId: string,
    worktreeId: string,
    basedOn: number,
    guard: ReviewMarkWriteGuard
  ): Promise<ReviewMarksWrite<"cleared" | "stale">> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      if (index.worktrees.get(worktreeId)?.mark && changedSince(index, worktreeId, basedOn)) {
        return { status: "stale", snapshot: snapshotOf(projectId, index), changed: false };
      }
      guard();
      index.revision = this.nextRevision(index);
      index.worktrees.set(worktreeId, { revision: index.revision, mark: null });
      await this.commit(projectId, index, guard);
      return { status: "cleared", snapshot: snapshotOf(projectId, index), changed: true };
    });
  }

  /**
   * Each worktree's entry revision, or null for one with none: what a removal
   * is checked against, so it never drops a mark made after this read.
   */
  async entryRevisions(
    projectId: string,
    worktreeIds: readonly string[] = []
  ): Promise<Map<string, number | null>> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      const revisions = new Map<string, number | null>();
      for (const [id, entry] of index.worktrees) {
        if (entry.mark) revisions.set(id, entry.revision);
      }
      for (const id of worktreeIds) {
        if (!revisions.has(id)) revisions.set(id, index.worktrees.get(id)?.revision ?? null);
      }
      return revisions;
    });
  }

  /**
   * Remove the marks of worktrees the host confirmed are gone, each only if
   * its entry is still what `expected` says it was when the check began. A
   * tombstone is left for each that had a mark or has a save in flight.
   */
  remove(
    projectId: string,
    expected: ReadonlyMap<string, number | null>
  ): Promise<ReviewMarksRemoval> {
    return this.turn(projectId, async () => {
      const index = await this.readIndex(projectId);
      const moved: string[] = [];
      const gone: string[] = [];
      for (const [id, revision] of expected) {
        if (!isReviewMarkWorktreeId(id)) continue;
        const entry = index.worktrees.get(id);
        if ((entry?.revision ?? null) !== revision) {
          moved.push(id);
          continue;
        }
        if (entry?.mark || this.pendingSaves.has(`${projectId}\0${id}`)) gone.push(id);
      }
      const result = { status: "removed" as const, changedSince: moved };
      if (gone.length === 0) {
        return { ...result, snapshot: snapshotOf(projectId, index), changed: false };
      }
      index.revision = this.nextRevision(index);
      for (const id of gone) index.worktrees.set(id, { revision: index.revision, mark: null });
      await this.commit(projectId, index);
      return { ...result, snapshot: snapshotOf(projectId, index), changed: true };
    });
  }

  private nextRevision(index: MarksIndex): number {
    return Math.max(index.revision + 1, this.now());
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

  private indexPath(projectId: string): string {
    return path.join(this.stateDir(projectId), INDEX_FILENAME);
  }

  private pointsDir(projectId: string): string {
    return path.join(this.stateDir(projectId), POINTS_DIRNAME);
  }

  /** The index as stored, or null when there is none. Throws when it can't be read. */
  private async readIndexText(projectId: string): Promise<string | null> {
    const filePath = this.indexPath(projectId);
    try {
      const { size } = await fs.stat(filePath);
      if (size > MAX_INDEX_FILE_BYTES) return "";
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  /**
   * The project's index; empty before anything was stored. A file that can't
   * be parsed or is from a newer build is moved aside, kept for the user, and
   * the project starts over. One that can't be read at all throws: writing over
   * a file we could not read would drop every mark in it.
   */
  private async readIndex(projectId: string): Promise<MarksIndex> {
    const text = await this.readIndexText(projectId);
    if (text === null) return emptyIndex();
    let raw: unknown;
    try {
      raw = JSON.parse(text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text);
    } catch {
      raw = undefined;
    }
    const parsed = parseIndex(raw);
    if (parsed && !("futureVersion" in parsed)) return parsed;
    const filePath = this.indexPath(projectId);
    const aside = parsed
      ? `${filePath}.future-v${parsed.futureVersion}.${this.now()}`
      : `${filePath}.corrupted.${this.now()}`;
    logWarn("[reviewMarks] Moved aside a review marks file it couldn't read", { projectId });
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
      if ((await fs.stat(filePath)).size > MAX_POINT_FILE_BYTES) return null;
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

  /**
   * Write the index, then drop every point file it no longer names. With a
   * guard, it is asked again once the index is written, and its throw puts the
   * previous index back: a turn's write is only seen once the turn ends.
   */
  private async commit(
    projectId: string,
    index: MarksIndex,
    guard?: ReviewMarkWriteGuard
  ): Promise<void> {
    trimTombstones(index);
    const stateDir = this.stateDir(projectId);
    const filePath = this.indexPath(projectId);
    const previous = guard ? await this.readIndexText(projectId) : null;
    await fs.mkdir(stateDir, { recursive: true });
    await resilientAtomicWriteFile(filePath, serializeIndex(index));
    try {
      guard?.();
    } catch (refusal) {
      if (previous === null) await resilientUnlink(filePath);
      else await resilientAtomicWriteFile(filePath, previous);
      throw refusal;
    }
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
