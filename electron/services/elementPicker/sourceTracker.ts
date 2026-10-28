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
 */

/** Bounds on what one workspace may watch; beyond them files are simply not tracked. */
export const MAX_TRACKED_FILES = 256;
export const MAX_WATCHED_DIRECTORIES = 64;

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

interface TrackedFile {
  ref: SourceFileRef;
  revision: FileRevision | null;
  checking: boolean;
  recheckQueued: boolean;
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class SourceTracker {
  private readonly files = new Map<string, TrackedFile>();
  /** Null for a directory whose watch failed: it still counts against the cap. */
  private readonly directories = new Map<string, (() => void) | null>();
  private disposed = false;

  constructor(private readonly options: SourceTrackerOptions) {}

  /** Record the revision just read, and start watching the file if it is new. */
  observe(absolutePath: string, ref: SourceFileRef, revision: FileRevision): void {
    if (this.disposed) return;
    const existing = this.files.get(absolutePath);
    if (existing) {
      existing.revision = revision;
      return;
    }
    if (this.files.size >= MAX_TRACKED_FILES) return;
    const directory = path.dirname(absolutePath);
    if (!this.directories.has(directory)) {
      if (this.directories.size >= MAX_WATCHED_DIRECTORIES) return;
      this.directories.set(directory, this.watch(directory));
    }
    const file: TrackedFile = { ref, revision, checking: false, recheckQueued: false };
    this.files.set(absolutePath, file);
    // A change that landed between the read and the watch produced no event;
    // reconcile once now that both are in place.
    void this.recheck(absolutePath, file);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.directories.values()) {
      try {
        dispose?.();
      } catch {
        // best-effort
      }
    }
    this.directories.clear();
    this.files.clear();
  }

  private watch(directory: string): (() => void) | null {
    try {
      return this.options.watch(directory, (changedPath) => {
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
      return null;
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
        try {
          this.options.push({ file: file.ref, revision });
        } catch (error) {
          this.options.warn("source change listener threw", { error: String(error) });
        }
      } while (file.recheckQueued);
    } finally {
      file.checking = false;
    }
  }
}
