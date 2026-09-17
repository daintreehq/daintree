import path from "node:path";
import type { PluginFsApi } from "../../../../shared/types/plugin.js";
import type { SourceChangedPush } from "../shared/protocol.js";
import { sha256Hex } from "./source.js";

/**
 * Notices when a file this workspace has read changes underneath it —
 * typically an agent editing the component the user has selected — so the view
 * can mark that selection stale rather than hand an agent offsets that have
 * moved.
 *
 * `host.fs.watch` is non-recursive, so each file's parent directory is watched
 * and events are filtered to tracked files. Watch events are a hint, never
 * proof: every event re-hashes the file and only a revision this side does not
 * already hold produces a push.
 */

/** Bounds on what one workspace may watch; beyond them files are simply not tracked. */
export const MAX_TRACKED_FILES = 256;
export const MAX_WATCHED_DIRECTORIES = 64;

interface TrackedFile {
  worktreeRelative: string;
  /** Last revision this side read; null once the file is gone. */
  revision: string | null;
  checking: boolean;
  recheckQueued: boolean;
}

export interface SourceTrackerOptions {
  fs: PluginFsApi;
  workspaceSessionId: string;
  push: (payload: SourceChangedPush) => void;
  warn: (message: string, detail: Record<string, unknown>) => void;
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class SourceTracker {
  private readonly files = new Map<string, TrackedFile>();
  private readonly directories = new Map<string, Promise<(() => void) | null>>();
  private disposed = false;

  constructor(private readonly options: SourceTrackerOptions) {}

  /** Record the revision just read, and start watching the file if it is new. */
  observe(absolutePath: string, worktreeRelative: string, revision: string): void {
    const file = this.track(absolutePath, worktreeRelative);
    if (file) file.revision = revision;
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.directories.values()) {
      void pending.then((dispose) => dispose?.());
    }
    this.directories.clear();
    this.files.clear();
  }

  private track(absolutePath: string, worktreeRelative: string): TrackedFile | null {
    if (this.disposed) return null;
    const existing = this.files.get(absolutePath);
    if (existing) return existing;
    if (this.files.size >= MAX_TRACKED_FILES) return null;

    const directory = path.dirname(absolutePath);
    const watched = this.directories.get(directory);
    if (!watched) {
      if (this.directories.size >= MAX_WATCHED_DIRECTORIES) return null;
      this.directories.set(directory, this.watch(directory));
    }
    const file: TrackedFile = {
      worktreeRelative,
      revision: null,
      checking: false,
      recheckQueued: false,
    };
    this.files.set(absolutePath, file);
    // A new watcher reconciles every file in its directory once it is wired;
    // a file joining a directory already watched gets no such pass, and a
    // change that landed between its read and this registration would go
    // unreported until the next event. Reconcile it once, after the caller has
    // recorded the revision it read.
    if (watched) {
      void watched.then((dispose) => {
        if (dispose && this.files.get(absolutePath) === file) void this.recheck(absolutePath, file);
      });
    }
    return file;
  }

  private watch(directory: string): Promise<(() => void) | null> {
    return this.options.fs
      .watch([directory], (changedPath) => {
        for (const [absolutePath, file] of this.files) {
          if (samePath(changedPath, absolutePath)) void this.recheck(absolutePath, file);
        }
      })
      .then(
        (dispose) => {
          if (this.disposed) {
            dispose();
            return null;
          }
          // Anything that changed between the read and the watch being wired
          // produced no event; reconcile once now.
          for (const [absolutePath, file] of this.files) {
            if (path.dirname(absolutePath) === directory) void this.recheck(absolutePath, file);
          }
          return dispose;
        },
        (error: unknown) => {
          // The push is advisory: the revision check before a request is sent
          // is the authority, so a directory that cannot be watched is not a
          // failure.
          this.options.warn("source watch failed", { directory, error: String(error) });
          return null;
        }
      );
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
        let revision: string | null;
        try {
          revision = sha256Hex(await this.options.fs.readFileBytes(absolutePath));
        } catch {
          revision = null;
        }
        if (this.disposed || this.files.get(absolutePath) !== file) return;
        if (revision === file.revision) continue;
        file.revision = revision;
        this.options.push({
          workspaceSessionId: this.options.workspaceSessionId,
          file: file.worktreeRelative,
          revision,
        });
      } while (file.recheckQueued);
    } finally {
      file.checking = false;
    }
  }
}
