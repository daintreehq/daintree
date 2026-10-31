import path from "node:path";
import type { FileRevision, SourceFileRef } from "../../../shared/elementPicker/resolution.js";

/**
 * Notices when a file a resolve read changes underneath it, typically an agent
 * editing the component the user has selected, so whoever holds that result
 * can mark it stale rather than hand on offsets that have moved.
 *
 * Watches are non-recursive, so each file's parent directory is watched and
 * events are filtered to tracked files. An event is a hint, never proof: each
 * one re-hashes the file, and only a revision this side does not already hold
 * is reported. Tracking lives in main and never wakes the host process.
 *
 * The bounds are a working set, not a first-come allowance: when a new file
 * would take either past its cap, the files ranked last give way. Files the
 * view says it holds rank first, in the order it gave; every other file ranks
 * by how recently a resolve read it. A file given up is remembered with the
 * revision last read, so a view that later says it holds it brings it back,
 * checked against that revision rather than whatever is on disk by then.
 */

/** Bounds on what one workspace may watch at once; what ranks past them is not tracked. */
export const MAX_TRACKED_FILES = 256;
export const MAX_WATCHED_DIRECTORIES = 64;

/** Paths one file is remembered by: a link inside the app reaches the same file by another. */
const MAX_REFS_PER_FILE = 8;

export interface SourceChange {
  file: SourceFileRef;
  /** Null once the file is no longer readable source: deleted, or past the size cap. */
  revision: FileRevision | null;
}

export interface SourceTrackerOptions {
  /** Watch one directory non-recursively. Throws when it cannot; returns the disposer. */
  watch: (directory: string, onChange: (changedPath: string) => void) => () => void;
  readRevision: (absolutePath: string) => Promise<FileRevision | null>;
  push: (change: SourceChange) => void;
  warn: (message: string, detail: Record<string, unknown>) => void;
}

interface FileRecord {
  /** Every workspace-relative path a resolve reached this file by, first read first. */
  refs: SourceFileRef[];
  directory: string;
  revision: FileRevision | null;
  /** When a resolve last read it; higher is more recent. */
  readAt: number;
}

interface TrackedFile extends FileRecord {
  checking: boolean;
  recheckQueued: boolean;
}

interface WatchedDirectory {
  /** Null for a watch that failed, or once closed: it still counts against the cap while held. */
  close: (() => void) | null;
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class SourceTracker {
  private readonly files = new Map<string, TrackedFile>();
  private readonly directories = new Map<string, WatchedDirectory>();
  /**
   * Files read but not tracked now, oldest first: what a later hold can bring
   * back. Bounded for files the view doesn't hold; a held one stays while it
   * is held, so churn can't forget the file the view most wants back.
   */
  private readonly dropped = new Map<string, FileRecord>();
  /** Workspace-relative path to its place in the view's list: lower ranks first. */
  private held = new Map<string, number>();
  private reads = 0;
  private disposed = false;

  constructor(private readonly options: SourceTrackerOptions) {}

  /** Record the revision just read, and start tracking the file if it is new and ranks inside the caps. */
  observe(absolutePath: string, ref: SourceFileRef, revision: FileRevision): void {
    if (this.disposed) return;
    const readAt = ++this.reads;
    const existing = this.files.get(absolutePath);
    if (existing) {
      existing.revision = revision;
      existing.readAt = readAt;
      existing.refs = withRef(existing.refs, ref);
      return;
    }
    const remembered = this.dropped.get(absolutePath);
    this.dropped.delete(absolutePath);
    const directory = path.dirname(absolutePath);
    const refs = withRef(remembered?.refs ?? [], ref);
    this.admit([[absolutePath, { refs, directory, revision, readAt }]]);
  }

  /**
   * The files the view holds a selection on, most important first, replacing
   * the previous list. They rank ahead of every other file in this order, and
   * one given up earlier comes back if it now ranks inside the caps. A file
   * no resolve has read here is not tracked until one does.
   */
  hold(paths: readonly string[]): void {
    if (this.disposed) return;
    const held = new Map<string, number>();
    for (const entry of paths) if (!held.has(entry)) held.set(entry, held.size);
    this.held = held;
    // A new order alone never needs room: what is tracked already fits.
    const returning: Array<[string, FileRecord]> = [];
    for (const [absolutePath, record] of this.dropped) {
      if (this.rank(record) !== undefined) returning.push([absolutePath, record]);
    }
    for (const [absolutePath] of returning) this.dropped.delete(absolutePath);
    if (returning.length > 0) this.admit(returning);
    else this.prune();
  }

  /** What is tracked and watched now. */
  usage(): { files: number; directories: number } {
    return { files: this.files.size, directories: this.directories.size };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const watched of this.directories.values()) close(watched);
    this.directories.clear();
    this.files.clear();
    this.dropped.clear();
  }

  /**
   * Starts tracking `arrivals` alongside what is tracked, keeping the
   * best-ranked files that fit both caps. Files are taken in rank order: one
   * whose directory is not yet kept needs a directory slot as well as a file
   * slot, and when there is none the next file down may still fit in a
   * directory that is. What loses is remembered, untracked, and a directory
   * left with nothing tracked is closed, all before any arrival is tracked or
   * any new watch opens, so neither cap is passed even in passing.
   */
  private admit(arrivals: ReadonlyArray<readonly [string, FileRecord]>): void {
    const opening = new Set<string>();
    for (const [, record] of arrivals) {
      if (!this.directories.has(record.directory)) opening.add(record.directory);
    }
    let admitted: ReadonlyArray<readonly [string, FileRecord]> = arrivals;
    if (
      this.files.size + arrivals.length > MAX_TRACKED_FILES ||
      this.directories.size + opening.size > MAX_WATCHED_DIRECTORIES
    ) {
      const arriving = new Set(arrivals.map(([absolutePath]) => absolutePath));
      const ranked: Array<readonly [string, FileRecord]> = [...this.files, ...arrivals];
      ranked.sort(([, a], [, b]) => this.compare(a, b));
      const winners: Array<readonly [string, FileRecord]> = [];
      const kept = new Set<string>();
      let count = 0;
      for (const entry of ranked) {
        const [absolutePath, record] = entry;
        if (
          count < MAX_TRACKED_FILES &&
          (kept.has(record.directory) || kept.size < MAX_WATCHED_DIRECTORIES)
        ) {
          count += 1;
          kept.add(record.directory);
          if (arriving.has(absolutePath)) winners.push(entry);
          continue;
        }
        if (!arriving.has(absolutePath)) this.files.delete(absolutePath);
        this.remember(absolutePath, record);
      }
      for (const [directory, watched] of this.directories) {
        if (kept.has(directory)) continue;
        this.directories.delete(directory);
        close(watched);
      }
      admitted = winners;
    }
    const tracked = admitted.map(([absolutePath, record]) => {
      // A fresh record every time, so a read still out for an earlier one lands on nothing.
      const file: TrackedFile = { ...record, checking: false, recheckQueued: false };
      this.files.set(absolutePath, file);
      return [absolutePath, file] as const;
    });
    this.prune();
    for (const [absolutePath, file] of tracked) {
      if (!this.directories.has(file.directory)) this.watch(file.directory);
      // A change that landed between the read and the watch produced no event;
      // reconcile once now that both are in place.
      void this.recheck(absolutePath, file);
    }
  }

  private remember(absolutePath: string, record: FileRecord): void {
    this.dropped.set(absolutePath, {
      refs: record.refs,
      directory: record.directory,
      revision: record.revision,
      readAt: record.readAt,
    });
  }

  /** Forgets the oldest remembered files the view doesn't hold, past the bound. */
  private prune(): void {
    let excess = -MAX_TRACKED_FILES;
    for (const record of this.dropped.values()) if (this.rank(record) === undefined) excess += 1;
    for (const [absolutePath, record] of this.dropped) {
      if (excess <= 0) return;
      if (this.rank(record) !== undefined) continue;
      this.dropped.delete(absolutePath);
      excess -= 1;
    }
  }

  /** Its best place in the view's list by any path it was read through; undefined when not held. */
  private rank(record: FileRecord): number | undefined {
    let best: number | undefined;
    for (const ref of record.refs) {
      const place = this.held.get(ref.path);
      if (place !== undefined && (best === undefined || place < best)) best = place;
    }
    return best;
  }

  private compare(a: FileRecord, b: FileRecord): number {
    const left = this.rank(a);
    const right = this.rank(b);
    if (left !== undefined || right !== undefined) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right;
    }
    return b.readAt - a.readAt;
  }

  private watch(directory: string): void {
    const watched: WatchedDirectory = { close: null };
    this.directories.set(directory, watched);
    try {
      watched.close = this.options.watch(directory, (changedPath) => {
        // A watch given up to make room may still deliver an event it had queued.
        if (this.disposed || this.directories.get(directory) !== watched) return;
        // Without a filename the event names the directory itself; any file
        // in it may be the one that changed.
        const whole = samePath(changedPath, directory);
        for (const [absolutePath, file] of this.files) {
          if (
            whole
              ? samePath(path.dirname(absolutePath), directory)
              : samePath(changedPath, absolutePath)
          ) {
            void this.recheck(absolutePath, file);
          }
        }
      });
    } catch (error) {
      // Advisory: the revision a later resolve reads is the authority, so a
      // directory that cannot be watched is not a failure.
      this.options.warn("source watch failed", { directory, error: String(error) });
    }
  }

  private async recheck(absolutePath: string, file: TrackedFile): Promise<void> {
    // Watchers deliver bursts; one read at a time per file, with at most one
    // follow-up, is enough to land on the final state.
    if (file.checking) {
      file.recheckQueued = true;
      return;
    }
    file.checking = true;
    try {
      do {
        file.recheckQueued = false;
        const revision = await this.options.readRevision(absolutePath);
        if (this.disposed || this.files.get(absolutePath) !== file) return;
        if (revision === file.revision) continue;
        file.revision = revision;
        // Every path it was read by: whoever holds a selection names the file by its own.
        for (const ref of file.refs) {
          try {
            this.options.push({ file: ref, revision });
          } catch (error) {
            this.options.warn("source change listener threw", { error: String(error) });
          }
        }
      } while (file.recheckQueued && !this.disposed && this.files.get(absolutePath) === file);
    } finally {
      file.checking = false;
    }
  }
}

/** The refs with `ref` added, newest kept when there are too many. */
function withRef(refs: SourceFileRef[], ref: SourceFileRef): SourceFileRef[] {
  if (refs.some((entry) => entry.path === ref.path)) return refs;
  return [...refs, ref].slice(-MAX_REFS_PER_FILE);
}

/** Closes a watch at most once, however many times it is given up. */
function close(watched: WatchedDirectory): void {
  const dispose = watched.close;
  watched.close = null;
  try {
    dispose?.();
  } catch {
    // best-effort
  }
}
