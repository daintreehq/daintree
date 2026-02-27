import { watch as fsWatch, FSWatcher, readFileSync } from "fs";
import {
  join as pathJoin,
  dirname,
  isAbsolute,
  basename,
  sep,
  normalize as pathNormalize,
} from "path";
import { getGitDir } from "./gitUtils.js";
import { logWarn } from "./logger.js";

export interface GitFileWatcherOptions {
  worktreePath: string;
  branch?: string;
  debounceMs: number;
  onChange: () => void;
  /** Watch the working tree recursively for file edits (macOS FSEvents). */
  watchWorktree?: boolean;
  /** Debounce for working tree events. Defaults to debounceMs if not set. */
  worktreeDebounceMs?: number;
}

export class GitFileWatcher {
  private watchers: FSWatcher[] = [];
  private readonly watchedFilesByDirectory = new Map<string, Set<string>>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private worktreeDebounceTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly worktreePath: string;
  private readonly debounceMs: number;
  private readonly worktreeDebounceMs: number;
  private readonly onChange: () => void;
  private readonly watchWorktree: boolean;
  private currentBranch?: string;

  constructor(options: GitFileWatcherOptions) {
    this.worktreePath = options.worktreePath;
    this.debounceMs = options.debounceMs;
    this.worktreeDebounceMs = options.worktreeDebounceMs ?? options.debounceMs;
    this.onChange = options.onChange;
    this.currentBranch = options.branch;
    this.watchWorktree = options.watchWorktree ?? false;
  }

  start(): boolean {
    if (this.disposed) {
      return false;
    }

    const gitDir = getGitDir(this.worktreePath, { cache: true, logErrors: false });
    if (!gitDir) {
      return false;
    }

    try {
      const commonDir = this.resolveCommonDir(gitDir);
      const headPath = pathJoin(gitDir, "HEAD");

      this.watchFile(headPath);
      this.watchFile(pathJoin(commonDir, "packed-refs"));
      this.watchFile(pathJoin(commonDir, "logs", "HEAD"));

      // For linked worktrees, the per-worktree reflog lives under gitDir, not commonDir.
      // Watch it so branch changes in linked worktrees trigger the onChange callback.
      // Normalize both paths before comparing to avoid false mismatches from trailing
      // slashes or non-canonical separators.
      if (pathNormalize(gitDir) !== pathNormalize(commonDir)) {
        this.watchFile(pathJoin(gitDir, "logs", "HEAD"));
      }

      if (this.currentBranch) {
        const branchRefPath = pathJoin(commonDir, "refs", "heads", this.currentBranch);
        this.watchFile(branchRefPath);
      }

      if (this.watchWorktree) {
        this.startWorktreeWatcher(gitDir);
      }

      return true;
    } catch (error) {
      logWarn("Failed to start git file watcher", {
        path: this.worktreePath,
        error: (error as Error).message,
      });
      this.closeWatchers();
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeWatchers();
  }

  private closeWatchers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.worktreeDebounceTimer) {
      clearTimeout(this.worktreeDebounceTimer);
      this.worktreeDebounceTimer = null;
    }

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    }

    this.watchers = [];
    this.watchedFilesByDirectory.clear();
  }

  private resolveCommonDir(gitDir: string): string {
    try {
      const commondirPath = pathJoin(gitDir, "commondir");
      const commondir = readFileSync(commondirPath, "utf-8").trim();
      return isAbsolute(commondir) ? commondir : pathJoin(gitDir, commondir);
    } catch {
      return gitDir;
    }
  }

  private startWorktreeWatcher(gitDir: string): void {
    try {
      const gitDirBase = basename(gitDir);
      const watcher = fsWatch(
        this.worktreePath,
        { persistent: false, recursive: true },
        (_eventType, changedFileName) => {
          if (!changedFileName) {
            this.handleWorktreeChange();
            return;
          }

          const changedName = changedFileName.toString();

          // Ignore all events inside .git directory
          if (
            changedName === gitDirBase ||
            changedName.startsWith(gitDirBase + sep) ||
            changedName.startsWith(gitDirBase + "/")
          ) {
            return;
          }

          // Ignore node_modules to avoid noise from package installs
          if (
            changedName.startsWith("node_modules" + sep) ||
            changedName.startsWith("node_modules/")
          ) {
            return;
          }

          this.handleWorktreeChange();
        }
      );

      watcher.on("error", (error) => {
        const errno = error as NodeJS.ErrnoException;
        if (process.platform === "linux" && errno.code === "ENOSPC") {
          logWarn(
            "inotify watch limit reached — file watching may be incomplete. " +
              "Temporary fix: sudo sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512. " +
              "Permanent fix: echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/99-inotify.conf && sudo sysctl --system",
            { path: this.worktreePath }
          );
          const idx = this.watchers.indexOf(watcher);
          if (idx !== -1) {
            this.watchers.splice(idx, 1);
          }
          try {
            watcher.close();
          } catch {
            // Ignore close errors on already-broken watcher
          }
        } else {
          logWarn("Worktree recursive watcher error", {
            path: this.worktreePath,
            error: error.message,
          });
        }
      });

      this.watchers.push(watcher);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (process.platform === "linux" && errno.code === "ENOSPC") {
        logWarn(
          "inotify watch limit reached — file watching may be incomplete. " +
            "Temporary fix: sudo sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512. " +
            "Permanent fix: echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/99-inotify.conf && sudo sysctl --system",
          { path: this.worktreePath }
        );
      } else {
        logWarn("Failed to start recursive worktree watcher", {
          path: this.worktreePath,
          error: errno.message,
        });
      }
    }
  }

  private watchFile(filePath: string): void {
    const watchDir = dirname(filePath);
    const fileName = basename(filePath);
    const watchedFiles = this.watchedFilesByDirectory.get(watchDir);

    if (watchedFiles) {
      watchedFiles.add(fileName);
      return;
    }

    try {
      const trackedFiles = new Set<string>([fileName]);
      const watcher = fsWatch(watchDir, { persistent: false }, (_eventType, changedFileName) => {
        if (this.shouldHandleDirectoryEvent(changedFileName, trackedFiles)) {
          this.handleGitFileChange();
        }
      });

      watcher.on("error", (error) => {
        logWarn("Git directory watcher error", {
          path: watchDir,
          error: error.message,
        });
      });

      this.watchers.push(watcher);
      this.watchedFilesByDirectory.set(watchDir, trackedFiles);
    } catch {
      // Silent fallback to polling
    }
  }

  private shouldHandleDirectoryEvent(
    changedFileName: string | Buffer | null,
    trackedFiles: Set<string>
  ): boolean {
    if (!changedFileName) {
      return true;
    }

    const changedName = changedFileName.toString().replaceAll("\\", "/");
    for (const trackedFile of trackedFiles) {
      if (this.matchesTrackedFile(changedName, trackedFile)) {
        return true;
      }
    }

    return false;
  }

  private matchesTrackedFile(changedName: string, trackedFile: string): boolean {
    if (changedName === trackedFile || changedName === `${trackedFile}.lock`) {
      return true;
    }

    if (changedName.endsWith(`/${trackedFile}`) || changedName.endsWith(`/${trackedFile}.lock`)) {
      return true;
    }

    return false;
  }

  /** Handle git-internal file changes (HEAD, refs, reflog). Fast debounce. */
  private handleGitFileChange(): void {
    if (this.disposed) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.disposed) {
        this.onChange();
      }
    }, this.debounceMs);
  }

  /** Handle working tree file changes. Separate debounce (can be longer). */
  private handleWorktreeChange(): void {
    if (this.disposed) {
      return;
    }

    if (this.worktreeDebounceTimer) {
      clearTimeout(this.worktreeDebounceTimer);
    }

    this.worktreeDebounceTimer = setTimeout(() => {
      this.worktreeDebounceTimer = null;
      if (!this.disposed) {
        this.onChange();
      }
    }, this.worktreeDebounceMs);
  }
}
